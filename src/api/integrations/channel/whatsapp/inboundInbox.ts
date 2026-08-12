import { PrismaRepository } from '@api/repository/repository.service';
import { InboundInboxMode } from '@config/env.config';
import { Prisma } from '@prisma/client';
import { WAMessage } from 'baileys';
import { createHash } from 'crypto';

export type InboundClassification = 'real' | 'stub' | 'control' | 'protocol';
export type InboundClaimKind = 'claimed' | 'duplicate' | 'promoted' | 'collision';

export type InboundIdentity = {
  sourceCluster: string;
  instanceScope: string;
  messageId: string;
};

export type InboundClaimInput = InboundIdentity & {
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
  return instanceName.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, '-');
}

export function classifyInboundMessage(received: WAMessage): InboundClassification {
  const message = received?.message as Record<string, unknown> | null | undefined;
  const protocol =
    message?.protocolMessage ||
    (message?.editedMessage as { message?: { protocolMessage?: unknown } } | undefined)?.message?.protocolMessage;
  if (protocol) return 'protocol';

  const text = (message?.conversation || (message?.extendedTextMessage as { text?: string } | undefined)?.text) as
    | string
    | undefined;
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
  return fallback;
}

export function evaluateExistingReceipt(
  existing: ExistingReceipt,
  incoming: Pick<InboundClaimInput, 'classification' | 'payloadHash'>,
): InboundClaimKind {
  if (existing.payloadHash === incoming.payloadHash) return 'duplicate';
  if (existing.classification === 'stub' && incoming.classification === 'real') return 'promoted';
  if (incoming.classification === 'stub') return 'duplicate';
  return 'collision';
}

function isUniqueConstraint(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export class PrismaInboundInbox {
  constructor(private readonly repository: PrismaRepository) {}

  public async claim(input: InboundClaimInput, mode: InboundInboxMode): Promise<InboundClaimResult> {
    if (mode === 'shadow') {
      return this.observe(input);
    }
    try {
      return await this.repository.$transaction(
        async (tx) => {
          const receipt = await tx.inboundReceipt.create({
            data: {
              sourceCluster: input.sourceCluster,
              instanceScope: input.instanceScope,
              messageId: input.messageId,
              classification: input.classification,
              payloadHash: input.payloadHash,
              state: input.classification === 'real' ? 'processing' : 'observed',
              leaseOwner: input.classification === 'real' ? input.leaseOwner : undefined,
              leaseToken: input.classification === 'real' ? 1 : 0,
              leaseExpiresAt:
                input.classification === 'real' ? new Date(Date.now() + (input.leaseSeconds ?? 60) * 1000) : undefined,
            },
          });
          let messageRecordId: string | undefined;
          if (input.classification === 'real' && input.messageData) {
            const message = await tx.message.create({ data: input.messageData as any });
            messageRecordId = message.id;
            await tx.inboundReceipt.update({ where: { id: receipt.id }, data: { messageRecordId } });
          }
          return {
            kind: 'claimed' as const,
            receiptId: receipt.id,
            messageRecordId,
            shouldDispatch: input.classification === 'real',
            leaseToken: input.classification === 'real' ? 1 : undefined,
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (!isUniqueConstraint(error)) throw error;
    }

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
    if (kind === 'duplicate') {
      if (input.classification === 'real' && input.leaseOwner && existing.state !== 'done') {
        const reclaimed = await this.repository.inboundReceipt.updateMany({
          where: {
            id: existing.id,
            OR: [{ state: 'failed' }, { leaseExpiresAt: { lt: new Date() } }],
          },
          data: {
            state: 'processing',
            attempts: { increment: 1 },
            leaseOwner: input.leaseOwner,
            leaseToken: { increment: 1 },
            leaseExpiresAt: new Date(Date.now() + (input.leaseSeconds ?? 60) * 1000),
            lastError: null,
          },
        });
        if (reclaimed.count === 1) {
          const current = await this.repository.inboundReceipt.findUniqueOrThrow({ where: { id: existing.id } });
          let messageRecordId = current.messageRecordId ?? undefined;
          if (!messageRecordId && input.messageData) {
            const message = await this.repository.message.create({ data: input.messageData as any });
            messageRecordId = message.id;
            await this.repository.inboundReceipt.update({
              where: { id: existing.id },
              data: { messageRecordId },
            });
          }
          return {
            kind: 'claimed',
            receiptId: existing.id,
            messageRecordId,
            shouldDispatch: true,
            leaseToken: current.leaseToken,
          };
        }
      }
      return {
        kind,
        receiptId: existing.id,
        messageRecordId: existing.messageRecordId ?? undefined,
        shouldDispatch: false,
      };
    }
    if (kind === 'collision') {
      await this.repository.inboundReceipt.update({
        where: { id: existing.id },
        data: {
          state: 'quarantined',
          collisionHash: input.payloadHash,
          lastError: 'message_id_payload_hash_collision',
        },
      });
      return { kind, receiptId: existing.id, shouldDispatch: false };
    }

    return this.repository.$transaction(
      async (tx) => {
        const current = await tx.inboundReceipt.findUnique({
          where: { sourceCluster_instanceScope_messageId: key },
        });
        if (!current) throw new Error('Inbound receipt disappeared during promotion');
        if (current.classification === 'real') {
          const currentKind = current.payloadHash === input.payloadHash ? 'duplicate' : 'collision';
          return {
            kind: currentKind,
            receiptId: current.id,
            messageRecordId: current.messageRecordId ?? undefined,
            shouldDispatch: false,
          } as InboundClaimResult;
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
            messageRecordId,
            leaseOwner: input.leaseOwner,
            leaseToken: { increment: 1 },
            leaseExpiresAt: new Date(Date.now() + (input.leaseSeconds ?? 60) * 1000),
          },
        });
        const promoted = await tx.inboundReceipt.findUniqueOrThrow({ where: { id: current.id } });
        return {
          kind: 'promoted',
          receiptId: current.id,
          messageRecordId,
          shouldDispatch: true,
          leaseToken: promoted.leaseToken,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  public async markSink(
    receiptId: string,
    sink: 'webhook' | 'chatwoot' | 'chatbot',
    state: 'sent' | 'skipped',
  ): Promise<void> {
    const field = `${sink}State` as 'webhookState' | 'chatwootState' | 'chatbotState';
    await this.repository.inboundReceipt.update({ where: { id: receiptId }, data: { [field]: state } });
  }

  public async markDone(receiptId: string, leaseOwner: string, leaseToken: number): Promise<boolean> {
    const updated = await this.repository.inboundReceipt.updateMany({
      where: { id: receiptId, leaseOwner, leaseToken, state: 'processing' },
      data: { state: 'done', leaseOwner: null, leaseExpiresAt: null, lastError: null },
    });
    return updated.count === 1;
  }

  public async markFailed(receiptId: string, leaseOwner: string, leaseToken: number, error: unknown): Promise<boolean> {
    const updated = await this.repository.inboundReceipt.updateMany({
      where: { id: receiptId, leaseOwner, leaseToken, state: 'processing' },
      data: {
        state: 'failed',
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
            classification: input.classification,
            payloadHash: input.payloadHash,
            state: 'shadow_seen',
          },
        });
        return {
          kind: 'claimed',
          receiptId: created.id,
          shouldDispatch: input.classification === 'real',
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
        data: { state: 'shadow_collision', collisionHash: input.payloadHash },
      });
    } else if (kind === 'promoted') {
      await this.repository.inboundReceipt.update({
        where: { id: existing.id },
        data: { classification: 'real', payloadHash: input.payloadHash, state: 'shadow_promoted' },
      });
    }
    return {
      kind,
      receiptId: existing.id,
      messageRecordId: existing.messageRecordId ?? undefined,
      shouldDispatch: input.classification === 'real',
    };
  }
}
