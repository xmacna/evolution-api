export type DurableInboundSink = 'webhook' | 'chatwoot' | 'chatbot';
export type DurableInboundSinkState = 'sent' | 'skipped' | 'failed';
export type DurableInboundSinkFailure = { sink: DurableInboundSink; error: Error };

/**
 * Runs one external sink without allowing its delivery failure to block the
 * remaining sinks. Persistence/fencing failures still reject because the
 * caller can no longer prove ownership of the receipt.
 */
export async function attemptDurableInboundSink(options: {
  sink: DurableInboundSink;
  operation: () => Promise<'sent' | 'skipped'>;
  mark: (sink: DurableInboundSink, state: DurableInboundSinkState) => Promise<void>;
  onDeliveryFailure?: (failure: DurableInboundSinkFailure) => void;
}): Promise<DurableInboundSinkFailure | undefined> {
  let state: 'sent' | 'skipped';
  try {
    state = await options.operation();
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    // If this throws, fencing/persistence was lost and must abort the caller.
    await options.mark(options.sink, 'failed');
    const failure = { sink: options.sink, error };
    options.onDeliveryFailure?.(failure);
    return failure;
  }
  // Deliberately outside the delivery catch: a persistence/fencing failure is
  // not a sink failure and must abort instead of being downgraded to retryable.
  await options.mark(options.sink, state);
  return undefined;
}

/** Keep legacy LID delivery in off/shadow; only an enforce receipt can retry it. */
export async function dispatchInboundChatbot(options: {
  unresolvedLid?: Error;
  receiptMode?: 'off' | 'shadow' | 'enforce';
  attempt: (operation: () => Promise<'sent'>) => Promise<boolean>;
  durable: () => Promise<void>;
  bestEffort: () => Promise<void>;
}): Promise<void> {
  const delivered = await options.attempt(async () => {
    if (options.unresolvedLid && options.receiptMode === 'enforce') throw options.unresolvedLid;
    await options.durable();
    return 'sent';
  });
  if (delivered) await options.bestEffort();
}
