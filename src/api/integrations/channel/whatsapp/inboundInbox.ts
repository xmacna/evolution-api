import { PrismaRepository } from '@api/repository/repository.service';
import { InboundInboxMode } from '@config/env.config';
import { Prisma } from '@prisma/client';
import { WAMessage } from 'baileys';
import { createHash } from 'crypto';

export type InboundClassification = 'real' | 'stub' | 'control' | 'protocol';
export type InboundClaimKind = 'claimed' | 'duplicate' | 'promoted' | 'collision' | 'bypassed';

export type InboundIdentity = {
  sourceCluster: string;
  instanceScope: string;
  messageId: string;
};

export type InboundClaimInput = InboundIdentity & {
  instanceId: string;
  contactScope: string;
  classification: InboundClassification;
  payloadHash: string;
  messageData?: Record<string, unknown>;
  leaseOwner?: string;
  leaseSeconds?: number;
};

export type InboundClaimResult = {
  kind: InboundClaimKind;
  receiptId: string;
  messageRecordId?: string;
  shouldDispatch: boolean;
  leaseToken?: number;
  /** Set when the instance left enforce between the in-memory check and the
   * claim transaction; the caller must refresh its cached mode and continue
   * without a durable receipt instead of dropping the message. */
  effectiveMode?: InboundInboxMode;
};

export type InboundWorkItem = {
  receiptId: string;
  leaseOwner: string;
  leaseToken: number;
  webhookState: string;
  chatwootState: string;
  chatbotState: string;
  message: Record<string, unknown>;
};

type ExistingReceipt = {
  id: string;
  classification: string;
  payloadHash: string;
  messageRecordId?: string | null;
  state?: string;
  leaseToken?: number;
};

const VOLATILE_KEYS = new Set(['timestamp', 'messagetimestamp', 'requestid', 'fromme']);

function canonicalize(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return { type: 'Buffer', data: [...value] };
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    return Object.keys(source)
      .sort()
      .reduce<Record<string, unknown>>((result, key) => {
        const normalizedKey = key.toLowerCase();
        if (VOLATILE_KEYS.has(normalizedKey) || normalizedKey.endsWith('jid')) return result;
        const normalizedValue = canonicalize(source[key]);
        if (normalizedValue !== undefined) result[key] = normalizedValue;
        return result;
      }, {});
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}

export function normalizeInstanceScope(instanceName: string): string {
  // Instance.name is the stable external identity across internal-ID recreation.
  // Hash the exact UTF-8 value: cosmetic normalization is not injective and could
  // merge distinct tenants such as "Foo"/"foo" or "A B"/"A-B".
  return `v1:${createHash('sha256').update(instanceName, 'utf8').digest('hex')}`;
}

export function normalizeContactScope(remoteJid: string | null | undefined): string {
  return (remoteJid || 'unknown').normalize('NFKC').trim().toLowerCase();
}

export function classifyInboundMessage(received: WAMessage): InboundClassification {
  const message = received?.message as Record<string, unknown> | null | undefined;
  const protocol =
    message?.protocolMessage ||
    (message?.editedMessage as { message?: { protocolMessage?: unknown } } | undefined)?.message?.protocolMessage;
  if (protocol) return 'protocol';

  const text = (message?.conversation || (message?.extendedTextMessage as { text?: string } | undefined)?.text) as
    string | undefined;
  if (text === 'requestPlaceholder' || text === 'onDemandHistSync') return 'control';

  if (!message && (received?.messageStubType !== undefined || received?.messageStubParameters?.length)) return 'stub';
  if (
    !message ||
    Object.keys(message).every((key) => key === 'messageContextInfo' || key === 'senderKeyDistributionMessage')
  ) {
    return 'control';
  }
  return 'real';
}

export function inboundPayloadHash(received: WAMessage): string {
  const payload = canonicalize({
    message: received.message,
    messageStubType: received.messageStubType,
    messageStubParameters: received.messageStubParameters,
  });
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function resolveInboundMode(
  instanceMode: string | null | undefined,
  fallback: InboundInboxMode,
): InboundInboxMode {
  if (instanceMode === 'off' || instanceMode === 'shadow' || instanceMode === 'enforce') return instanceMode;
  // A global enforce is unsafe: an instance row may still be off while sinks
  // start throwing as if a durable receipt existed. Missing/invalid instance
  // state therefore fails closed to off; the env may only opt into shadow.
  return fallback === 'shadow' ? 'shadow' : 'off';
}

export function canTransitionInboundMode(current: string, target: string, incompleteReceipts: number): boolean {
  return current !== 'enforce' || target === 'enforce' || incompleteReceipts === 0;
}

export function evaluateExistingReceipt(
  existing: ExistingReceipt,
  incoming: Pick<InboundClaimInput, 'classification' | 'payloadHash'>,
): Exclude<InboundClaimKind, 'claimed' | 'bypassed'> {
  if (existing.payloadHash === incoming.payloadHash) return 'duplicate';
  if (existing.classification !== 'real' && incoming.classification === 'real') return 'promoted';
  if (incoming.classification !== 'real') return 'duplicate';
  return 'collision';
}

function isUniqueConstraint(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function isWriteConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034';
}

export class InboundModeTransitionBlockedError extends Error {
  constructor(public readonly incompleteReceipts: number) {
    super(`Inbound inbox downgrade blocked: ${incompleteReceipts} incomplete receipt(s) must drain first`);
  }
}

export async function transitionInboundMode(
  repository: PrismaRepository,
  instanceName: string,
  sourceCluster: string,
  targetMode: InboundInboxMode,
) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await repository.$transaction(
        async (tx) => {
          const current = await tx.instance.findUniqueOrThrow({
            where: { name: instanceName },
            select: { name: true, inboundInboxMode: true },
          });
          const incompleteReceipts =
            current.inboundInboxMode === 'enforce' && targetMode !== 'enforce'
              ? await tx.inboundReceipt.count({
                  where: {
                    sourceCluster,
                    instanceScope: normalizeInstanceScope(current.name),
                    state: { in: ['received', 'processing', 'failed'] },
                  },
                })
              : 0;
          if (!canTransitionInboundMode(current.inboundInboxMode, targetMode, incompleteReceipts)) {
            throw new InboundModeTransitionBlockedError(incompleteReceipts);
          }
          return tx.instance.update({
            where: { name: instanceName },
            data: { inboundInboxMode: targetMode },
            select: { name: true, inboundInboxMode: true },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (!isWriteConflict(error) || attempt === 7) throw error;
      const jitterMs = Math.floor(Math.random() * 5);
      await new Promise((resolve) => setTimeout(resolve, 2 ** attempt + jitterMs));
    }
  }
  throw new Error('Inbound inbox mode transition retry exhausted');
}

export class PrismaInboundInbox {
  constructor(private readonly repository: PrismaRepository) {}

  public async claim(input: InboundClaimInput, mode: InboundInboxMode): Promise<InboundClaimResult> {
    if (mode === 'shadow') {
      return this.observe(input);
    }
    let uniqueConflict = false;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        const outcome = await this.repository.$transaction(
          async (tx) => {
            const instance = await tx.instance.findUnique({
              where: { id: input.instanceId },
              select: { inboundInboxMode: true },
            });
            const liveMode = resolveInboundMode(instance?.inboundInboxMode, 'off');
            if (liveMode !== 'enforce') {
              return { divergedMode: liveMode };
            }
            const receipt = await tx.inboundReceipt.create({
              data: {
                sourceCluster: input.sourceCluster,
                instanceScope: input.instanceScope,
                contactScope: input.contactScope,
                messageId: input.messageId,
                classification: input.classification,
                payloadHash: input.payloadHash,
                state: input.classification === 'real' ? 'processing' : 'observed',
                leaseOwner: input.classification === 'real' ? input.leaseOwner : undefined,
                attempts: input.classification === 'real' ? 1 : 0,
                leaseToken: input.classification === 'real' ? 1 : 0,
                leaseExpiresAt:
                  input.classification === 'real'
                    ? new Date(Date.now() + (input.leaseSeconds ?? 60) * 1000)
                    : undefined,
              },
            });
            let messageRecordId: string | undefined;
            if (input.classification === 'real' && input.messageData) {
              const message = await tx.message.create({ data: input.messageData as any });
              messageRecordId = message.id;
              await tx.inboundReceipt.update({ where: { id: receipt.id }, data: { messageRecordId } });
            }
            return {
              result: {
                kind: 'claimed' as const,
                receiptId: receipt.id,
                messageRecordId,
                shouldDispatch: input.classification === 'real' || input.classification === 'protocol',
                leaseToken: input.classification === 'real' ? 1 : undefined,
              },
            };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
        if ('divergedMode' in outcome) return this.claimAfterModeChange(input, outcome.divergedMode);
        return outcome.result;
      } catch (error) {
        if (isUniqueConstraint(error)) {
          uniqueConflict = true;
          break;
        }
        if (!isWriteConflict(error) || attempt === 7) throw error;
        const jitterMs = Math.floor(Math.random() * 5);
        await new Promise((resolve) => setTimeout(resolve, 2 ** attempt + jitterMs));
      }
    }
    if (!uniqueConflict) throw new Error('Inbound receipt initial claim retry exhausted');

    const key = {
      sourceCluster: input.sourceCluster,
      instanceScope: input.instanceScope,
      messageId: input.messageId,
    };
    const existing = await this.repository.inboundReceipt.findUnique({
      where: { sourceCluster_instanceScope_messageId: key },
    });
    if (!existing) throw new Error('Inbound receipt disappeared after unique conflict');

    const kind = evaluateExistingReceipt(existing, input);
    if (kind !== 'promoted') {
      // A redelivery at ingress never reopens work. Only the durable reconciler may
      // lease failed/expired receipts, preserving per-sink completion state.
      return this.recordSettledReplay(existing, input, kind);
    }

    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        const outcome = await this.repository.$transaction(
          async (tx) => {
            const instance = await tx.instance.findUnique({
              where: { id: input.instanceId },
              select: { inboundInboxMode: true },
            });
            const liveMode = resolveInboundMode(instance?.inboundInboxMode, 'off');
            if (liveMode !== 'enforce') {
              return { divergedMode: liveMode } as const;
            }
            const current = await tx.inboundReceipt.findUnique({
              where: { sourceCluster_instanceScope_messageId: key },
            });
            if (!current) throw new Error('Inbound receipt disappeared during promotion');
            if (current.classification === 'real') {
              const currentKind = current.payloadHash === input.payloadHash ? 'duplicate' : 'collision';
              return {
                result: {
                  kind: currentKind,
                  receiptId: current.id,
                  messageRecordId: current.messageRecordId ?? undefined,
                  shouldDispatch: false,
                } as InboundClaimResult,
                settledReplay: current,
                settledKind: currentKind,
              };
            }

            let messageRecordId = current.messageRecordId ?? undefined;
            if (!messageRecordId && input.messageData) {
              const message = await tx.message.create({ data: input.messageData as any });
              messageRecordId = message.id;
            }
            await tx.inboundReceipt.update({
              where: { id: current.id },
              data: {
                classification: 'real',
                payloadHash: input.payloadHash,
                collisionHash: null,
                state: 'processing',
                contactScope: input.contactScope,
                messageRecordId,
                leaseOwner: input.leaseOwner,
                attempts: 1,
                leaseToken: { increment: 1 },
                leaseExpiresAt: new Date(Date.now() + (input.leaseSeconds ?? 60) * 1000),
                lastSeenAt: new Date(),
              },
            });
            const promoted = await tx.inboundReceipt.findUniqueOrThrow({ where: { id: current.id } });
            return {
              result: {
                kind: 'promoted' as const,
                receiptId: current.id,
                messageRecordId,
                shouldDispatch: true,
                leaseToken: promoted.leaseToken,
              },
              settledReplay: undefined,
              settledKind: undefined,
            };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
        if ('divergedMode' in outcome) return this.claimAfterModeChange(input, outcome.divergedMode);
        if (outcome.settledReplay) {
          return this.recordSettledReplay(
            outcome.settledReplay,
            input,
            outcome.settledKind as 'duplicate' | 'collision',
          );
        }
        return outcome.result;
      } catch (error) {
        if (!isWriteConflict(error)) throw error;
        const raced = await this.repository.inboundReceipt.findUnique({
          where: { sourceCluster_instanceScope_messageId: key },
        });
        if (raced?.classification === 'real') {
          const racedKind = raced.payloadHash === input.payloadHash ? 'duplicate' : 'collision';
          return this.recordSettledReplay(raced, input, racedKind);
        }
        if (attempt === 7) throw error;
        const jitterMs = Math.floor(Math.random() * 5);
        await new Promise((resolve) => setTimeout(resolve, 2 ** attempt + jitterMs));
      }
    }
    throw new Error('Inbound receipt promotion retry exhausted');
  }

  // The instance left enforce between the caller's in-memory mode check and
  // the claim transaction (mode transitions serialize against claims). Failing
  // here would drop the message with no receipt and no reconciler; degrade to
  // the live mode's semantics instead and tell the caller to refresh its cache.
  private async claimAfterModeChange(
    input: InboundClaimInput,
    liveMode: InboundInboxMode,
  ): Promise<InboundClaimResult> {
    if (liveMode === 'shadow') {
      const observed = await this.observe(input);
      return { ...observed, effectiveMode: 'shadow' };
    }
    return {
      kind: 'bypassed',
      receiptId: '',
      shouldDispatch: input.classification === 'real' || input.classification === 'protocol',
      effectiveMode: 'off',
    };
  }

  private async recordSettledReplay(
    existing: ExistingReceipt,
    input: InboundClaimInput,
    kind: 'duplicate' | 'collision',
  ): Promise<InboundClaimResult> {
    if (kind === 'duplicate') {
      await this.repository.inboundReceipt.update({
        where: { id: existing.id },
        data: { duplicateCount: { increment: 1 }, lastSeenAt: new Date() },
      });
    } else {
      // Never revoke an active/failed worker's fencing token by quarantining its
      // receipt underneath it. Terminal collisions remain visible, while an
      // in-flight collision is suppressed without changing delivery state.
      await this.repository.inboundReceipt.updateMany({
        where: {
          id: existing.id,
          state: { notIn: ['received', 'processing', 'failed'] },
        },
        data: {
          state: 'quarantined',
          collisionHash: input.payloadHash,
          lastSeenAt: new Date(),
          lastError: 'message_id_payload_hash_collision',
        },
      });
    }
    return {
      kind,
      receiptId: existing.id,
      messageRecordId: existing.messageRecordId ?? undefined,
      shouldDispatch: false,
    };
  }

  public async markSink(
    receiptId: string,
    sink: 'webhook' | 'chatwoot' | 'chatbot',
    state: 'sent' | 'skipped' | 'failed',
    leaseOwner?: string,
    leaseToken?: number,
    messageData?: Record<string, unknown>,
  ): Promise<boolean> {
    const field = `${sink}State` as 'webhookState' | 'chatwootState' | 'chatbotState';
    return this.repository.$transaction(async (tx) => {
      const updated = await tx.inboundReceipt.updateMany({
        where: {
          id: receiptId,
          ...(leaseOwner && leaseToken !== undefined ? { leaseOwner, leaseToken, state: 'processing' } : {}),
        },
        data: { [field]: state },
      });
      if (updated.count !== 1) return false;
      if (messageData) {
        const receipt = await tx.inboundReceipt.findUnique({
          where: { id: receiptId },
          select: { messageRecordId: true },
        });
        if (!receipt?.messageRecordId) throw new Error(`Inbound receipt ${receiptId} has no durable Message`);
        await tx.message.update({ where: { id: receipt.messageRecordId }, data: messageData as any });
      }
      return true;
    });
  }

  public async persistMessage(
    receiptId: string,
    leaseOwner: string,
    leaseToken: number,
    messageData: Record<string, unknown>,
  ): Promise<boolean> {
    return this.repository.$transaction(async (tx) => {
      // The no-op assignment still takes the receipt row lock and proves that
      // this worker owns the current fencing token before changing the payload.
      const fenced = await tx.inboundReceipt.updateMany({
        where: { id: receiptId, leaseOwner, leaseToken, state: 'processing' },
        data: { leaseOwner },
      });
      if (fenced.count !== 1) return false;
      const receipt = await tx.inboundReceipt.findUnique({
        where: { id: receiptId },
        select: { messageRecordId: true },
      });
      if (!receipt?.messageRecordId) throw new Error(`Inbound receipt ${receiptId} has no durable Message`);
      await tx.message.update({ where: { id: receipt.messageRecordId }, data: messageData as any });
      return true;
    });
  }

  public async heartbeat(
    receiptId: string,
    leaseOwner: string,
    leaseToken: number,
    leaseSeconds: number,
  ): Promise<boolean> {
    const updated = await this.repository.inboundReceipt.updateMany({
      where: { id: receiptId, leaseOwner, leaseToken, state: 'processing' },
      data: { leaseExpiresAt: new Date(Date.now() + leaseSeconds * 1000) },
    });
    return updated.count === 1;
  }

  public async leaseNext(
    sourceCluster: string,
    instanceScope: string,
    leaseOwner: string,
    leaseSeconds: number,
    maxAttempts: number,
  ): Promise<InboundWorkItem | null> {
    const provider = process.env.DATABASE_PROVIDER || 'postgresql';
    return this.repository.$transaction(
      async (tx) => {
        const rows =
          provider === 'mysql'
            ? await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
                SELECT candidate.id
                FROM InboundReceipt candidate
                WHERE candidate.sourceCluster = ${sourceCluster}
                  AND candidate.instanceScope = ${instanceScope}
                  AND candidate.classification = 'real'
                  AND candidate.messageRecordId IS NOT NULL
                  AND candidate.attempts < ${maxAttempts}
                  AND (
                    (candidate.state = 'failed' AND candidate.availableAt <= CURRENT_TIMESTAMP)
                    OR (candidate.state = 'processing' AND candidate.leaseExpiresAt < CURRENT_TIMESTAMP)
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM InboundReceipt previous
                    WHERE previous.sourceCluster = candidate.sourceCluster
                      AND previous.instanceScope = candidate.instanceScope
                      AND previous.contactScope = candidate.contactScope
                      AND previous.state IN ('received', 'processing', 'failed')
                      AND (previous.createdAt < candidate.createdAt OR
                        (previous.createdAt = candidate.createdAt AND previous.id < candidate.id))
                  )
                ORDER BY candidate.createdAt, candidate.id
                LIMIT 1 FOR UPDATE SKIP LOCKED
              `)
            : await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
                SELECT candidate.id
                FROM "InboundReceipt" candidate
                WHERE candidate."sourceCluster" = ${sourceCluster}
                  AND candidate."instanceScope" = ${instanceScope}
                  AND candidate.classification = 'real'
                  AND candidate."messageRecordId" IS NOT NULL
                  AND candidate.attempts < ${maxAttempts}
                  AND (
                    (candidate.state = 'failed' AND candidate."availableAt" <= CURRENT_TIMESTAMP)
                    OR (candidate.state = 'processing' AND candidate."leaseExpiresAt" < CURRENT_TIMESTAMP)
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM "InboundReceipt" previous
                    WHERE previous."sourceCluster" = candidate."sourceCluster"
                      AND previous."instanceScope" = candidate."instanceScope"
                      AND previous."contactScope" = candidate."contactScope"
                      AND previous.state IN ('received', 'processing', 'failed')
                      AND (previous."createdAt" < candidate."createdAt" OR
                        (previous."createdAt" = candidate."createdAt" AND previous.id < candidate.id))
                  )
                ORDER BY candidate."createdAt", candidate.id
                LIMIT 1 FOR UPDATE SKIP LOCKED
              `);
        if (rows.length === 0) return null;

        const updated = await tx.inboundReceipt.update({
          where: { id: rows[0].id },
          data: {
            state: 'processing',
            attempts: { increment: 1 },
            leaseOwner,
            leaseToken: { increment: 1 },
            leaseExpiresAt: new Date(Date.now() + leaseSeconds * 1000),
            lastError: null,
          },
          include: { Message: true },
        });
        if (!updated.Message) throw new Error(`Inbound receipt ${updated.id} has no durable Message`);
        const message = { ...updated.Message } as any;
        delete message.id;
        return {
          receiptId: updated.id,
          leaseOwner,
          leaseToken: updated.leaseToken,
          webhookState: updated.webhookState,
          chatwootState: updated.chatwootState,
          chatbotState: updated.chatbotState,
          message,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }

  public async markDone(receiptId: string, leaseOwner: string, leaseToken: number): Promise<boolean> {
    const updated = await this.repository.inboundReceipt.updateMany({
      where: { id: receiptId, leaseOwner, leaseToken, state: 'processing' },
      data: { state: 'done', leaseOwner: null, leaseExpiresAt: null, lastError: null },
    });
    return updated.count === 1;
  }

  public async markFailed(
    receiptId: string,
    leaseOwner: string,
    leaseToken: number,
    error: unknown,
    maxAttempts = 10,
    baseBackoffSeconds = 2,
  ): Promise<boolean> {
    const current = await this.repository.inboundReceipt.findFirst({
      where: { id: receiptId, leaseOwner, leaseToken, state: 'processing' },
      select: { attempts: true },
    });
    if (!current) return false;
    const dead = current.attempts >= maxAttempts;
    const delaySeconds = Math.min(300, baseBackoffSeconds * 2 ** Math.max(0, current.attempts - 1));
    const updated = await this.repository.inboundReceipt.updateMany({
      where: { id: receiptId, leaseOwner, leaseToken, state: 'processing' },
      data: {
        state: dead ? 'dead' : 'failed',
        availableAt: dead ? new Date() : new Date(Date.now() + delaySeconds * 1000),
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: String(error instanceof Error ? error.message : error).slice(0, 4000),
      },
    });
    return updated.count === 1;
  }

  private async observe(input: InboundClaimInput): Promise<InboundClaimResult> {
    const key = {
      sourceCluster: input.sourceCluster,
      instanceScope: input.instanceScope,
      messageId: input.messageId,
    };
    const existing = await this.repository.inboundReceipt.findUnique({
      where: { sourceCluster_instanceScope_messageId: key },
    });
    if (!existing) {
      try {
        const created = await this.repository.inboundReceipt.create({
          data: {
            ...key,
            contactScope: input.contactScope,
            classification: input.classification,
            payloadHash: input.payloadHash,
            state: 'shadow_seen',
          },
        });
        return {
          kind: 'claimed',
          receiptId: created.id,
          shouldDispatch: input.classification === 'real' || input.classification === 'protocol',
        };
      } catch (error) {
        if (!isUniqueConstraint(error)) throw error;
        return this.observe(input);
      }
    }

    const kind = evaluateExistingReceipt(existing, input);
    if (kind === 'collision') {
      await this.repository.inboundReceipt.update({
        where: { id: existing.id },
        data: { state: 'shadow_collision', collisionHash: input.payloadHash, lastSeenAt: new Date() },
      });
    } else if (kind === 'promoted') {
      await this.repository.inboundReceipt.update({
        where: { id: existing.id },
        data: {
          classification: 'real',
          payloadHash: input.payloadHash,
          state: 'shadow_promoted',
          lastSeenAt: new Date(),
        },
      });
    } else {
      await this.repository.inboundReceipt.update({
        where: { id: existing.id },
        data: { duplicateCount: { increment: 1 }, lastSeenAt: new Date() },
      });
    }
    return {
      kind,
      receiptId: existing.id,
      messageRecordId: existing.messageRecordId ?? undefined,
      // Shadow observes only; it must preserve baseline delivery semantics.
      shouldDispatch: input.classification === 'real' || input.classification === 'protocol',
    };
  }
}
