type MessageKey = {
  remoteJid?: string | null;
  remoteJidAlt?: string | null;
  fromMe?: boolean | null;
  [key: string]: unknown;
};

const phoneJid = (value: unknown): value is string => typeof value === 'string' && /^\d+@s\.whatsapp\.net$/.test(value);

/** Keep Baileys' LID as the message identity; add the known phone identity for lookup. */
export function enrichOutgoingMessageKey<T extends MessageKey>(
  key: T,
  numberCandidates: readonly (string | null | undefined)[],
): T {
  if (!key.fromMe || !key.remoteJid?.endsWith('@lid')) return key;
  const number = numberCandidates.find(phoneJid) ?? (phoneJid(key.remoteJidAlt) ? key.remoteJidAlt : undefined);
  return number ? { ...key, remoteJidAlt: number } : key;
}

export function remoteJidQueryFilters(filters: { remoteJid?: string; remoteJidAlt?: string }) {
  const comparisons = [
    ...(filters.remoteJid ? [{ key: { path: ['remoteJid'], equals: filters.remoteJid } }] : []),
    ...(filters.remoteJid ? [{ key: { path: ['remoteJidAlt'], equals: filters.remoteJid } }] : []),
    ...(filters.remoteJidAlt ? [{ key: { path: ['remoteJidAlt'], equals: filters.remoteJidAlt } }] : []),
  ];
  return comparisons.length ? comparisons : [{}];
}
