import { inspectBusinessAppHistoryIndex } from '@api/integrations/chatbot/chatwoot/business-app-history-guard';
import { attachBusinessAppHistoryMedia } from '@api/integrations/chatbot/chatwoot/business-app-history-media';
import {
  ImportBinding,
  importBusinessAppContact,
  importBusinessAppHistoryMessage,
} from '@api/integrations/chatbot/chatwoot/chatwootBusinessAppHistory';
import { postgresClient } from '@api/integrations/chatbot/chatwoot/libs/postgres.client';
import { PrismaRepository } from '@api/repository/repository.service';
import { Chatwoot, ConfigService, WaBusiness } from '@config/env.config';
import axios from 'axios';
import { createHash } from 'crypto';
import mimeTypes from 'mime-types';
import { Pool, PoolClient } from 'pg';

import { BusinessAppBinding, BusinessAppDestination, BusinessAppSync, BusinessAppSyncUnit } from './business-app-sync';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const phone = (value: any): string | null =>
  typeof value === 'string' && /^\+?\d{5,15}$/.test(value) ? value.replace(/^\+/, '') : null;
function portalUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new Error('Portal origin invalid');
  return url.href.replace(/\/$/, '');
}

/** Per-instance coordinator. Reads provider fresh; never invokes the shared mutable Chatwoot service. */
export class BusinessAppSyncRuntime {
  public readonly sync: BusinessAppSync;
  private readonly pool = postgresClient.getChatwootConnection();
  private readonly binding: BusinessAppBinding;
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly repository: PrismaRepository,
    private readonly config: ConfigService,
    instance: { instanceId: string; instanceName: string; number: string },
    private readonly download: (message: any) => Promise<any>,
    reportFailure: () => void,
  ) {
    const settings = config.get<WaBusiness>('WA_BUSINESS');
    let configured: any;
    try {
      const map = JSON.parse(settings.COEXISTENCE_SYNC_BINDINGS || '{}');
      if (map && !Array.isArray(map) && Object.prototype.hasOwnProperty.call(map, instance.instanceName))
        configured = map[instance.instanceName];
    } catch {
      /* malformed configuration stays disabled */
    }
    const enabled =
      typeof configured?.phoneNumberId === 'string' &&
      typeof configured?.messagingAccountId === 'string' &&
      !!configured.messagingAccountId &&
      configured.phoneNumberId === instance.number;
    this.binding = {
      ...instance,
      phoneNumberId: enabled ? configured.phoneNumberId : '',
      messagingAccountId: enabled ? configured.messagingAccountId : '',
    };
    this.sync = new BusinessAppSync(
      repository,
      this.binding,
      {
        enabled,
        appSecretConfigured: !!settings.APP_SECRET,
        callbackUrl: settings.COEXISTENCE_SYNC_CALLBACK_URL || '',
        currentSource: async () =>
          (await repository.instance.findUnique({ where: { id: this.binding.instanceId }, select: { number: true } }))
            ?.number === this.binding.phoneNumberId,
        destination: async () => (await this.destination()).snapshot,
      },
      (run, unit, assertLease) => this.project(run, unit, assertLease),
    );
    if (enabled) {
      // Recover durable pending/expired leases after restart, even with no new webhook.
      this.timer = setInterval(() => void this.sync.drain().catch(reportFailure), 5000);
      this.timer.unref();
      void this.sync.drain().catch(reportFailure);
    }
  }

  public close() {
    if (this.timer) clearInterval(this.timer);
  }

  private async destination(database: Pool | PoolClient = this.pool) {
    const chatwoot = this.config.get<Chatwoot>('CHATWOOT');
    if (!chatwoot.ENABLED || !chatwoot.IMPORT.DATABASE.CONNECTION.URI || !this.pool)
      throw new Error('Portal import unavailable');
    const provider = await this.repository.chatwoot.findUnique({ where: { instanceId: this.binding.instanceId } });
    if (!provider?.enabled || !provider.token || !provider.nameInbox) throw new Error('Portal provider unavailable');
    const baseUrl = portalUrl(provider.url);
    // Explicitly bind the configured SQL database to its Portal origin. No host inference.
    if (baseUrl !== portalUrl(this.config.get<WaBusiness>('WA_BUSINESS').COEXISTENCE_SYNC_PORTAL_URL || ''))
      throw new Error('Portal SQL origin mismatch');
    const accountId = Number(provider.accountId);
    if (!Number.isSafeInteger(accountId) || accountId < 1 || accountId > 2147483647)
      throw new Error('Portal account invalid');
    const inboxes = await database.query('SELECT id FROM inboxes WHERE account_id=$1 AND name=$2', [
      accountId,
      provider.nameInbox,
    ]);
    if (
      inboxes.rows.length !== 1 ||
      !Number.isSafeInteger(Number(inboxes.rows[0].id)) ||
      Number(inboxes.rows[0].id) < 1 ||
      Number(inboxes.rows[0].id) > 2147483647
    )
      throw new Error('Portal inbox ambiguous');
    const actor = (
      await database.query('SELECT owner_type AS type, owner_id AS id FROM access_tokens WHERE token=$1', [
        provider.token,
      ])
    ).rows;
    if (
      actor.length !== 1 ||
      !['User', 'AgentBot'].includes(actor[0].type) ||
      !Number.isSafeInteger(Number(actor[0].id)) ||
      Number(actor[0].id) < 1
    )
      throw new Error('Portal actor invalid');
    if (!(await inspectBusinessAppHistoryIndex(database)).ready)
      throw new Error('Portal unique source guard unavailable');
    const snapshot: BusinessAppDestination = {
      portalBaseUrl: baseUrl,
      portalAccountId: accountId,
      portalInboxId: Number(inboxes.rows[0].id),
    };
    const binding: ImportBinding = {
      accountId,
      inboxId: snapshot.portalInboxId,
      actorId: Number(actor[0].id),
      actorType: actor[0].type,
    };
    return { snapshot, binding, provider: { url: baseUrl, token: provider.token } };
  }

  private async fencedDestination(run: any, assertLease: () => Promise<void>, database?: PoolClient) {
    const destination = await this.destination(database);
    const current = await this.repository.instance.findUnique({
      where: { id: this.binding.instanceId },
      select: { number: true },
    });
    if (
      current?.number !== run.phoneNumberId ||
      run.phoneNumberId !== this.binding.phoneNumberId ||
      run.messagingAccountId !== this.binding.messagingAccountId ||
      Object.entries(destination.snapshot).some(([key, value]) => run[key] !== value)
    )
      throw new Error('Historical destination binding changed');
    await assertLease();
    return destination;
  }

  private async identity(userId: any, number: string | null) {
    if (typeof userId !== 'string' || !userId || userId.length > 100) return number;
    const id = `meta_contact_${hash(`${this.binding.instanceId}\0bsuid:${userId}`)}`;
    const prior = await this.repository.businessAppContact.findUnique({ where: { id } });
    if (prior?.phoneNumber && number && prior.phoneNumber !== number)
      throw new Error('Historical identity binding conflict');
    if (prior && !prior.phoneNumber && number) {
      await this.repository.businessAppContact.updateMany({
        where: { id, phoneNumber: null },
        data: { phoneNumber: number, remoteJid: `${number}@s.whatsapp.net` },
      });
      const saved = await this.repository.businessAppContact.findUnique({ where: { id } });
      if (saved?.phoneNumber !== number) throw new Error('Historical identity binding conflict');
    }
    if (!prior && number) {
      try {
        await this.repository.businessAppContact.create({
          data: {
            id,
            instanceId: this.binding.instanceId,
            identityKey: `bsuid:${userId}`,
            userId,
            phoneNumber: number,
            remoteJid: `${number}@s.whatsapp.net`,
            action: 'mapping',
            sourceTimestamp: 0,
            payload: { source: 'authenticated_history_phone_binding' },
          },
        });
      } catch (error) {
        if (error?.code !== 'P2002') throw error;
      }
      const saved = await this.repository.businessAppContact.findUnique({ where: { id } });
      if (saved?.phoneNumber !== number) throw new Error('Historical identity binding conflict');
    }
    return number || prior?.phoneNumber || null;
  }

  private async project(
    run: any,
    unit: BusinessAppSyncUnit,
    assertLease: () => Promise<void>,
  ): Promise<{ blocked?: string }> {
    const destination = await this.fencedDestination(run, assertLease);
    if (unit.kind === 'contact') {
      const item = unit.contact;
      const timestamp = Number(unit.timestamp);
      if (
        unit.contactType !== 'contact' ||
        (item?.user_id !== undefined &&
          (typeof item.user_id !== 'string' || !item.user_id || item.user_id.length > 100)) ||
        !item ||
        !['add', 'remove'].includes(unit.action) ||
        !Number.isSafeInteger(timestamp) ||
        timestamp < 0 ||
        timestamp > 2147483647
      )
        return { blocked: 'contact_shape_unsupported' };
      let number: string | null;
      try {
        number = await this.identity(item.user_id, phone(item.phone_number));
      } catch {
        return { blocked: 'identity_binding_conflict' };
      }
      const identityKey = item.user_id ? `bsuid:${item.user_id}` : number ? `pn:${number}` : null;
      if (!identityKey) return { blocked: 'contact_identity_unsupported' };
      const id = `meta_contact_${hash(`${this.binding.instanceId}\0${identityKey}`)}`;
      const data = {
        phoneNumber: number,
        remoteJid: number ? `${number}@s.whatsapp.net` : null,
        userId: item.user_id || null,
        fullName: item.full_name || item.first_name || null,
        action: unit.action,
        sourceTimestamp: timestamp,
        payload: JSON.parse(JSON.stringify(unit)),
      };
      const prior = await this.repository.businessAppContact.findUnique({ where: { id } });
      if (!prior) {
        try {
          await this.repository.businessAppContact.create({
            data: { id, instanceId: this.binding.instanceId, identityKey, ...data },
          });
        } catch (error) {
          if (error?.code !== 'P2002') throw error;
        }
      }
      await this.repository.businessAppContact.updateMany({
        where: {
          id,
          instanceId: this.binding.instanceId,
          OR: [{ sourceTimestamp: { lt: timestamp } }, { sourceTimestamp: timestamp, action: { not: 'remove' } }],
        },
        data,
      });
      const latest = await this.repository.businessAppContact.findUnique({ where: { id } });
      if (latest.sourceTimestamp !== timestamp || latest.action !== unit.action) return {};
      if (!number) return { blocked: 'bsuid_portal_identity_pending' };
      await this.fencedDestination(run, assertLease);
      await importBusinessAppContact(
        this.pool,
        destination.binding,
        {
          phone: number,
          fullName: data.fullName,
          timestamp,
          action: unit.action,
        },
        async (database) => {
          await this.fencedDestination(run, assertLease, database);
          // Re-read inside the destination's contact lock. A newer remove may
          // have no Portal contact on which to store its timestamp yet.
          const current = await this.repository.businessAppContact.findUnique({ where: { id } });
          if (current?.sourceTimestamp !== timestamp || current?.action !== unit.action)
            throw new Error('Historical contact sync superseded');
        },
      );
      return {};
    }
    const message = unit.message;
    const timestamp = Number(message?.timestamp);
    if (
      !message?.id ||
      typeof message.id !== 'string' ||
      !Number.isSafeInteger(timestamp) ||
      timestamp < 0 ||
      timestamp > 2147483647
    )
      return { blocked: 'message_identity_unsupported' };
    const businessPhone = phone(unit.metadata?.display_phone_number?.replace(/[ ()-]/g, ''));
    let number = phone(unit.thread?.context?.wa_id || unit.thread?.id);
    let fromMe = unit.fromMe;
    if (unit.thread) {
      if (!businessPhone) return { blocked: 'business_phone_unavailable' };
      if (unit.thread.id && unit.thread.context?.wa_id && phone(unit.thread.id) !== phone(unit.thread.context.wa_id))
        return { blocked: 'message_recipient_conflict' };
      if (message.from_user_id && unit.thread.context?.user_id && message.from_user_id !== unit.thread.context.user_id)
        return { blocked: 'message_recipient_conflict' };
      if (phone(message.from) === businessPhone) fromMe = true;
      else if (
        (number && phone(message.from) === number) ||
        (!message.from && message.from_user_id && message.from_user_id === unit.thread.context?.user_id)
      )
        fromMe = false;
      else return { blocked: 'message_direction_unsupported' };
    } else number = phone(fromMe ? message.to : message.from);
    const userId = unit.thread?.context?.user_id || (fromMe ? message.to_user_id : message.from_user_id);
    try {
      number = await this.identity(userId, number);
    } catch {
      return { blocked: 'identity_binding_conflict' };
    }
    if (!number) return { blocked: 'bsuid_portal_identity_pending' };
    if (fromMe === undefined) return { blocked: 'message_direction_unsupported' };
    const type = message.type;
    const mediaType = ['image', 'video', 'audio', 'document', 'sticker'].includes(type);
    let content: string;
    if (type === 'text' && typeof message.text?.body === 'string') content = message.text.body;
    else if (type === 'media_placeholder') content = '[Mídia do histórico aguardando disponibilidade]';
    else if (mediaType) content = message[type]?.caption || '[Mídia do histórico]';
    else if (type === 'reaction')
      content = message.reaction?.emoji ? `Reagiu com ${message.reaction.emoji}` : 'Removeu a reação';
    else if (
      type === 'location' &&
      typeof message.location?.latitude === 'number' &&
      typeof message.location?.longitude === 'number'
    )
      content = [
        message.location.name,
        message.location.address,
        `https://maps.google.com/?q=${message.location.latitude},${message.location.longitude}`,
      ]
        .filter(Boolean)
        .join('\n');
    else if (type === 'contacts' && Array.isArray(message.contacts))
      content = message.contacts
        .map((contact: any) =>
          [contact.name?.formatted_name, ...(contact.phones || []).map((entry: any) => entry.phone)]
            .filter(Boolean)
            .join('\n'),
        )
        .join('\n\n');
    else return { blocked: 'message_type_unsupported' };
    const target = await importBusinessAppHistoryMessage(
      this.pool,
      destination.binding,
      {
        id: message.id,
        phone: number,
        fromMe,
        timestamp,
        content,
        mediaPlaceholder: type === 'media_placeholder' || mediaType,
        mediaId: mediaType ? message[type]?.id : undefined,
      },
      async (database) => {
        await this.fencedDestination(run, assertLease, database);
      },
    );
    if (mediaType && target.content_attributes?.business_app_history === true) {
      const media = message[type];
      if (!media?.id || !media.mime_type) return { blocked: 'media_metadata_unsupported' };
      const downloaded = await this.download({
        message: { messageType: `${type}Message`, message: { [`${type}Message`]: media } },
      });
      await this.fencedDestination(run, assertLease);
      await attachBusinessAppHistoryMedia(
        this.pool,
        destination.binding,
        destination.provider,
        target,
        {
          id: media.id,
          type,
          bytes: Buffer.from(downloaded.base64, 'base64'),
          mimetype: media.mime_type,
          filename: media.filename || `whatsapp-history-${timestamp}.${mimeTypes.extension(media.mime_type) || 'bin'}`,
          sha256: media.sha256,
        },
        axios,
        async (database) => {
          await this.fencedDestination(run, assertLease, database);
        },
      );
    }
    return {};
  }
}
