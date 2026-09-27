import { PrismaRepository } from '@api/repository/repository.service';
import { Prisma } from '@prisma/client';

import { normalizeInstanceScope } from './inboundInbox';

const PHONE_JID = /^[1-9][0-9]{5,19}@s\.whatsapp\.net$/;
const LID_JID = /^[1-9][0-9]{1,24}@lid$/;

export class UnresolvedInboundLidError extends Error {
  constructor(reason: 'unknown' | 'ambiguous') {
    super(`Inbound LID alias ${reason}; phone identity unavailable`);
    this.name = 'UnresolvedInboundLidError';
  }
}

export type InboundAddress = {
  remoteJid: string;
  remoteJidAlt?: string | null;
};

export type ResolvedInboundAddress = {
  remoteJid: string;
  senderLid?: string;
};

export interface LidPhoneAliasStore {
  confirm(instanceScope: string, lidJid: string, phoneJid: string): Promise<string>;
  find(instanceScope: string, lidJid: string): Promise<string | null>;
}

/**
 * A conflicting confirmed pair poisons the alias instead of replacing it.
 * The serializable transaction also prevents two workers from silently choosing
 * different phones for the same LID while recording a concurrent observation.
 */
export class PrismaLidPhoneAliasStore implements LidPhoneAliasStore {
  constructor(private readonly repository: PrismaRepository) {}

  async confirm(instanceScope: string, lidJid: string, phoneJid: string): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        const alias = await this.repository.$transaction(
          async (tx) => {
            const where = { instanceScope_lidJid: { instanceScope, lidJid } };
            const existing = await tx.lidPhoneAlias.findUnique({ where });
            if (!existing) {
              return tx.lidPhoneAlias.create({ data: { instanceScope, lidJid, phoneJid } });
            }
            if (existing.ambiguous || existing.phoneJid !== phoneJid) {
              return tx.lidPhoneAlias.update({
                where,
                data: { ambiguous: true, phoneJid: null },
              });
            }
            return existing;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
        if (alias.ambiguous || !alias.phoneJid) throw new UnresolvedInboundLidError('ambiguous');
        return alias.phoneJid;
      } catch (error) {
        if (error instanceof UnresolvedInboundLidError) throw error;
        if (
          !(error instanceof Prisma.PrismaClientKnownRequestError) ||
          !['P2002', 'P2034'].includes(error.code) ||
          attempt === 7
        ) {
          throw error;
        }
      }
    }
    throw new Error('LID alias transaction retry exhausted');
  }

  async find(instanceScope: string, lidJid: string): Promise<string | null> {
    const alias = await this.repository.lidPhoneAlias.findUnique({
      where: { instanceScope_lidJid: { instanceScope, lidJid } },
    });
    if (alias?.ambiguous) throw new UnresolvedInboundLidError('ambiguous');
    return alias?.phoneJid ?? null;
  }
}

/** Never derive a phone number from the LID digits. */
export async function resolveInboundAddress(
  instanceName: string,
  address: InboundAddress,
  aliases: LidPhoneAliasStore,
  getPhoneForLid?: (lidJid: string) => Promise<string | null | undefined>,
): Promise<ResolvedInboundAddress> {
  const primary = address.remoteJid;
  const alternate = address.remoteJidAlt ?? undefined;
  const lid = LID_JID.test(primary) ? primary : LID_JID.test(alternate ?? '') ? alternate : undefined;
  const primaryPhone = PHONE_JID.test(primary);
  if (!lid || (!primaryPhone && !LID_JID.test(primary))) return { remoteJid: primary };

  const scope = normalizeInstanceScope(instanceName);
  const alternatePhone = PHONE_JID.test(alternate ?? '') ? alternate : undefined;
  const confirmedPhone = primaryPhone ? primary : alternatePhone;
  if (confirmedPhone) {
    const remoteJid = await aliases.confirm(scope, lid, confirmedPhone);
    return { remoteJid, senderLid: LID_JID.test(primary) ? lid : undefined };
  }

  // Baileys' signal repository is tied to this instance's authenticated socket.
  const baileysPhone = await getPhoneForLid?.(lid);
  if (baileysPhone && PHONE_JID.test(baileysPhone)) {
    const remoteJid = await aliases.confirm(scope, lid, baileysPhone);
    return { remoteJid, senderLid: lid };
  }
  const storedPhone = await aliases.find(scope, lid);
  if (!storedPhone || !PHONE_JID.test(storedPhone)) throw new UnresolvedInboundLidError('unknown');
  return { remoteJid: storedPhone, senderLid: lid };
}
