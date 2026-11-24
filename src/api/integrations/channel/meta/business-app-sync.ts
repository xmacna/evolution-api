import { PrismaRepository } from '@api/repository/repository.service';
import { createHash, randomUUID } from 'crypto';

export type BusinessAppBinding = {
  instanceId: string;
  instanceName: string;
  phoneNumberId: string;
  messagingAccountId: string;
};
export type BusinessAppSyncRegistration = {
  generation: string;
  phoneNumberId: string;
  messagingAccountId: string;
  onboardedAt: string;
  deadline?: string;
  contactsRequestId?: string;
  historyRequestId?: string;
};
export type BusinessAppSyncUnit = {
  kind: 'contact' | 'message';
  contactType?: string;
  metadata: any;
  contact?: any;
  action?: string;
  timestamp?: string;
  message?: any;
  thread?: any;
  fromMe?: boolean;
};
export type BusinessAppDestination = { portalAccountId: number; portalInboxId: number; portalBaseUrl: string };
type SyncOptions = {
  enabled: boolean;
  appSecretConfigured: boolean;
  callbackUrl: string;
  clock?: () => number;
  destination: () => Promise<BusinessAppDestination>;
  currentSource?: () => Promise<boolean>;
};
type Project = (run: any, unit: BusinessAppSyncUnit, assertLease: () => Promise<void>) => Promise<{ blocked?: string }>;
const FIELDS = ['history', 'smb_app_state_sync'];
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const stableJson = (value: any): string =>
  JSON.stringify(value, (_key, item) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, item[key]]),
      );
    }
    return item;
  });

/** Durable capture and resumable projection; no Graph, chatbot, human pause or HTTP client. */
export class BusinessAppSync {
  private readonly owner = randomUUID();
  private draining = false;
  private readonly leaseMs = 60000;

  constructor(
    private readonly repository: PrismaRepository,
    private readonly binding: BusinessAppBinding,
    private readonly options: SyncOptions,
    private readonly project: Project,
  ) {}

  private now() {
    return this.options.clock?.() ?? Date.now();
  }

  private matchesRun(run: any) {
    return (
      run.instanceId === this.binding.instanceId &&
      run.phoneNumberId === this.binding.phoneNumberId &&
      run.messagingAccountId === this.binding.messagingAccountId &&
      run.generation === hash(`${this.binding.messagingAccountId}:${this.binding.phoneNumberId}`)
    );
  }

  private matchesDestination(run: any, destination: BusinessAppDestination) {
    return (
      run.portalAccountId === destination.portalAccountId &&
      run.portalInboxId === destination.portalInboxId &&
      run.portalBaseUrl === destination.portalBaseUrl
    );
  }

  private async readiness(requireDestination = true) {
    if (!this.options.enabled) return 'disabled';
    if (!this.options.appSecretConfigured) return 'signature_not_configured';
    if (!this.binding.phoneNumberId || !this.binding.messagingAccountId) return 'binding_missing';
    try {
      if (this.options.currentSource && !(await this.options.currentSource())) return 'source_binding_changed';
    } catch {
      return 'source_binding_unavailable';
    }
    try {
      const callback = new URL(this.options.callbackUrl);
      if (callback.protocol !== 'https:' || callback.search || callback.hash || callback.username || callback.password)
        return 'callback_invalid';
    } catch {
      return 'callback_invalid';
    }
    try {
      const run = await this.repository.businessAppSyncRun.findFirst({
        where: { instanceId: this.binding.instanceId },
        select: {
          instanceId: true,
          phoneNumberId: true,
          messagingAccountId: true,
          generation: true,
          portalAccountId: true,
          portalInboxId: true,
          portalBaseUrl: true,
        },
      });
      if (run && !this.matchesRun(run)) return 'stale_run_binding';
      if (requireDestination) {
        let destination: BusinessAppDestination;
        try {
          destination = await this.options.destination();
        } catch {
          return 'portal_destination_unavailable';
        }
        if (run && !this.matchesDestination(run, destination)) return 'stale_portal_destination';
      }
      await this.repository.businessAppSyncChunk.count({ where: { instanceId: this.binding.instanceId } });
      await this.repository.businessAppContact.count({ where: { instanceId: this.binding.instanceId } });
    } catch {
      return 'schema_unavailable';
    }
    return null;
  }

  public async status() {
    const reason = await this.readiness();
    const base = {
      ready: !reason,
      reason,
      ...this.binding,
      fields: FIELDS,
      webhookCallbackUrl: this.options.callbackUrl,
    };
    if (reason) return { ...base, generation: null };
    const run = await this.repository.businessAppSyncRun.findUnique({ where: { instanceId: this.binding.instanceId } });
    if (!run) return { ...base, generation: null };
    if (!this.matchesRun(run)) return { ...base, ready: false, reason: 'stale_run_binding', generation: null };
    const fieldStatus = async (field: string) => {
      const chunks = await this.repository.businessAppSyncChunk.findMany({
        where: { runId: run.id, instanceId: this.binding.instanceId, field },
        select: { state: true, late: true, lastErrorCode: true },
      });
      const pendingChunks = chunks.filter((chunk) => chunk.state === 'pending' || chunk.state === 'processing').length;
      const blockedChunks = chunks.filter((chunk) => chunk.state === 'blocked').length;
      return {
        capturedChunks: chunks.length,
        pendingChunks,
        blockedChunks,
        lateChunks: chunks.filter((chunk) => chunk.late).length,
        blockedReasons: [
          ...new Set(
            chunks
              .filter((chunk) => chunk.state === 'blocked')
              .map((chunk) => chunk.lastErrorCode)
              .filter(Boolean),
          ),
        ],
        importState: blockedChunks ? 'blocked' : pendingChunks ? 'pending' : chunks.length ? 'caught_up' : 'waiting',
      };
    };
    return {
      ...base,
      generation: run.generation,
      onboardedAt: run.onboardedAt,
      deadline: run.deadline,
      expired: this.now() > +run.deadline,
      history: {
        ...(await fieldStatus('history')),
        sourceProgress: run.sourceProgress,
        consent: run.historyConsent,
        requestId: run.historyRequestId,
        sourceErrorCode: run.sourceErrorCode,
        mediaCompletion: 'not_signaled',
      },
      contacts: {
        ...(await fieldStatus('smb_app_state_sync')),
        requestId: run.contactsRequestId,
        sourceCompletion: 'not_signaled',
      },
    };
  }

  public async start(input: BusinessAppSyncRegistration) {
    const reason = await this.readiness();
    if (reason) throw new Error(`Business app sync unavailable: ${reason}`);
    if (
      input?.phoneNumberId !== this.binding.phoneNumberId ||
      input?.messagingAccountId !== this.binding.messagingAccountId
    ) {
      throw new Error('Business app sync binding mismatch');
    }
    if (input.generation !== hash(`${input.messagingAccountId}:${input.phoneNumberId}`))
      throw new Error('Business app sync generation mismatch');
    const onboardedAt = Date.parse(input.onboardedAt);
    const deadline = input.deadline ? Date.parse(input.deadline) : onboardedAt + 24 * 3600000;
    if (
      !Number.isFinite(onboardedAt) ||
      onboardedAt > this.now() ||
      !Number.isFinite(deadline) ||
      deadline <= onboardedAt ||
      deadline > onboardedAt + 24 * 3600000
    )
      throw new Error('Business app sync deadline invalid');
    const destination = await this.options.destination();
    let run = await this.repository.businessAppSyncRun.findUnique({ where: { instanceId: this.binding.instanceId } });
    if (!run) {
      try {
        run = await this.repository.businessAppSyncRun.create({
          data: {
            id: `meta_sync_${hash(this.binding.instanceId)}`,
            instanceId: this.binding.instanceId,
            generation: input.generation,
            ...destination,
            phoneNumberId: input.phoneNumberId,
            messagingAccountId: input.messagingAccountId,
            onboardedAt: new Date(onboardedAt),
            deadline: new Date(deadline),
          },
        });
      } catch (error) {
        if (error?.code !== 'P2002') throw error;
        run = await this.repository.businessAppSyncRun.findUnique({ where: { instanceId: this.binding.instanceId } });
        if (!run) throw error;
      }
    }
    if (
      !this.matchesDestination(run, destination) ||
      run.generation !== input.generation ||
      run.phoneNumberId !== input.phoneNumberId ||
      run.messagingAccountId !== input.messagingAccountId ||
      +run.onboardedAt !== onboardedAt ||
      +run.deadline !== deadline
    ) {
      throw new Error('Business app sync immutable generation/deadline mismatch');
    }
    for (const field of ['contactsRequestId', 'historyRequestId'] as const) {
      const value = input[field];
      if (value === undefined) continue;
      if (typeof value !== 'string' || !value || value.length > 255)
        throw new Error('Business app sync request metadata invalid');
      if (run[field] && run[field] !== value) throw new Error('Business app sync request metadata collision');
      if (!run[field]) {
        await this.repository.businessAppSyncRun.updateMany({
          where: { id: run.id, [field]: null },
          data: { [field]: value },
        });
        const current = await this.repository.businessAppSyncRun.findUnique({ where: { id: run.id } });
        if (current?.[field] !== value) throw new Error('Business app sync request metadata collision');
      }
    }
    return {
      ok: true,
      generation: run.generation,
      phoneNumberId: run.phoneNumberId,
      messagingAccountId: run.messagingAccountId,
    };
  }

  public async capture(field: string, value: any, messagingAccountId: string) {
    const reason = await this.readiness(false);
    if (reason) throw new Error(`Business app durable sync ingest unavailable: ${reason}`);
    if (
      !FIELDS.includes(field) ||
      value?.metadata?.phone_number_id !== this.binding.phoneNumberId ||
      messagingAccountId !== this.binding.messagingAccountId
    )
      throw new Error('Business app sync capture binding mismatch');
    const run = await this.repository.businessAppSyncRun.findUnique({ where: { instanceId: this.binding.instanceId } });
    if (!run) throw new Error('Business app sync generation not registered');
    if (!this.matchesRun(run)) throw new Error('Business app sync stale run binding');
    const payload = JSON.parse(JSON.stringify({ field, value }));
    const payloadHash = hash(stableJson(payload));
    const id = `meta_chunk_${hash(`${run.id}\0${field}\0${payloadHash}`)}`;
    try {
      await this.repository.businessAppSyncChunk.create({
        data: {
          id,
          runId: run.id,
          instanceId: this.binding.instanceId,
          field,
          payloadHash,
          payload,
          state: 'pending',
          nextAttemptAt: new Date(this.now()),
          late: this.now() > +run.deadline,
        },
      });
    } catch (error) {
      if (error?.code !== 'P2002') throw error;
      const existing = await this.repository.businessAppSyncChunk.findUnique({ where: { id } });
      if (!existing || stableJson(existing.payload) !== stableJson(payload))
        throw new Error('Business app sync capture collision');
      await this.repository.businessAppSyncChunk.updateMany({
        where: { id, instanceId: this.binding.instanceId },
        data: { duplicateCount: { increment: 1 } },
      });
    }
    // Source progress is separate from local projection. Repeated/out-of-order
    // chunks cannot move it backwards. A consent rejection is never completion.
    for (const history of value.history || []) {
      if (history.errors?.length) {
        const code = history.errors[0].code;
        await this.repository.businessAppSyncRun.updateMany({
          where: { id: run.id },
          data: {
            sourceErrorCode: Number.isSafeInteger(code) ? String(code) : 'UNKNOWN_SOURCE_ERROR',
          },
        });
      }
      const progress = history.metadata?.progress;
      if (Number.isInteger(progress) && progress >= 0 && progress <= 100) {
        await this.repository.businessAppSyncRun.updateMany({
          where: { id: run.id, sourceProgress: { lt: progress } },
          data: { sourceProgress: progress },
        });
      }
      if (history.errors?.some((error: any) => error.code === 2593109)) {
        await this.repository.businessAppSyncRun.updateMany({
          where: { id: run.id },
          data: { historyConsent: 'declined' },
        });
      } else if (history.threads?.length) {
        await this.repository.businessAppSyncRun.updateMany({
          where: { id: run.id, historyConsent: 'unknown' },
          data: { historyConsent: 'shared' },
        });
      }
    }
    return { captured: true, chunkId: id, generation: run.generation };
  }

  private units(payload: any): BusinessAppSyncUnit[] {
    const { field, value } = payload;
    if (field === 'smb_app_state_sync')
      return (value.state_sync || []).map((item: any) => ({
        kind: 'contact',
        contactType: item.type,
        metadata: value.metadata,
        contact: item.contact,
        action: item.action,
        timestamp: item.metadata?.timestamp,
      }));
    const units: BusinessAppSyncUnit[] = [];
    for (const history of value.history || []) {
      for (const thread of history.threads || []) {
        for (const message of thread.messages || [])
          units.push({ kind: 'message', metadata: value.metadata, thread, message });
      }
    }
    for (const message of value.messages || [])
      units.push({ kind: 'message', metadata: value.metadata, message, fromMe: false });
    for (const message of value.message_echoes || [])
      units.push({ kind: 'message', metadata: value.metadata, message, fromMe: true });
    return units;
  }

  public async drain(maxUnits = 100) {
    if (this.draining || (await this.readiness())) return;
    this.draining = true;
    try {
      const now = new Date(this.now());
      const run = await this.repository.businessAppSyncRun.findUnique({
        where: { instanceId: this.binding.instanceId },
      });
      if (!run || !this.matchesRun(run)) return;
      const eligible = {
        runId: run.id,
        instanceId: this.binding.instanceId,
        OR: [
          { state: 'pending', nextAttemptAt: { lte: now } },
          { state: 'processing', leaseExpiresAt: { lte: now } },
        ],
      };
      const chunk = await this.repository.businessAppSyncChunk.findFirst({
        where: eligible,
        orderBy: { createdAt: 'asc' },
      });
      if (!chunk) return;
      const expectedVersion = chunk.leaseVersion + 1;
      const claimed = await this.repository.businessAppSyncChunk.updateMany({
        where: { ...eligible, id: chunk.id, leaseVersion: expectedVersion - 1 },
        data: {
          state: 'processing',
          leaseOwner: this.owner,
          leaseVersion: { increment: 1 },
          attempts: { increment: 1 },
          leaseExpiresAt: new Date(this.now() + this.leaseMs),
        },
      });
      if (!claimed.count) return;
      const current = await this.repository.businessAppSyncChunk.findUnique({ where: { id: chunk.id } });
      const ownership = {
        id: chunk.id,
        instanceId: this.binding.instanceId,
        leaseOwner: this.owner,
        leaseVersion: expectedVersion,
      };
      const ownsLease = () =>
        this.repository.businessAppSyncChunk.findFirst({
          where: {
            ...ownership,
            state: 'processing',
            leaseExpiresAt: { gt: new Date(this.now()) },
          },
        });
      if (!current || !(await ownsLease())) return;
      let cursor = current.cursor;
      const blocked: { cursor: number; reason: string }[] = [];
      try {
        if (current.blocked !== null && !Array.isArray(current.blocked))
          throw new Error('Historical quarantine state invalid');
        const entries = Array.isArray(current.blocked) ? current.blocked : [];
        for (const item of entries) {
          if (
            !item ||
            typeof item !== 'object' ||
            Array.isArray(item) ||
            typeof item.cursor !== 'number' ||
            !Number.isSafeInteger(item.cursor) ||
            item.cursor < 0 ||
            typeof item.reason !== 'string'
          )
            throw new Error('Historical quarantine state invalid');
          blocked.push({ cursor: item.cursor, reason: item.reason });
        }
        const units = this.units(current.payload);
        let processed = 0;
        while (cursor < units.length && processed++ < maxUnits) {
          if (!(await ownsLease()) || (await this.readiness())) return;
          const outcome = await this.project(run, units[cursor], async () => {
            if (!(await ownsLease())) throw new Error('Historical projection lease expired');
          });
          if (!(await ownsLease())) return;
          if (outcome?.blocked) blocked.push({ cursor, reason: outcome.blocked });
          cursor++;
          const checkpoint = await this.repository.businessAppSyncChunk.updateMany({
            where: { ...ownership, state: 'processing', leaseExpiresAt: { gt: new Date(this.now()) } },
            data: {
              cursor,
              blocked: blocked.length ? blocked : undefined,
              leaseExpiresAt: new Date(this.now() + this.leaseMs),
            },
          });
          if (!checkpoint.count) return; // Another worker reclaimed the lease.
        }
        await this.repository.businessAppSyncChunk.updateMany({
          where: { ...ownership, state: 'processing', leaseExpiresAt: { gt: new Date(this.now()) } },
          data: {
            state: cursor < units.length ? 'pending' : blocked.length ? 'blocked' : 'done',
            nextAttemptAt: new Date(this.now()),
            leaseOwner: null,
            leaseExpiresAt: null,
            lastErrorCode: blocked.length ? String(blocked[0].reason).slice(0, 64) : null,
          },
        });
      } catch {
        await this.repository.businessAppSyncChunk.updateMany({
          where: { ...ownership, state: 'processing', leaseExpiresAt: { gt: new Date(this.now()) } },
          data: {
            state: 'pending',
            lastErrorCode: 'PROJECTION_FAILED',
            nextAttemptAt: new Date(this.now() + 30000),
            leaseOwner: null,
            leaseExpiresAt: null,
          },
        });
      }
    } finally {
      this.draining = false;
    }
  }
}
