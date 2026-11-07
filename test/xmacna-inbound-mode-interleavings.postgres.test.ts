import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Prisma, PrismaClient } from '@prisma/client';

import {
  InboundModeTransitionBlockedError,
  normalizeInstanceScope,
  PrismaInboundInbox,
  transitionInboundMode,
} from '../src/api/integrations/channel/whatsapp/inboundInbox';

const enabled = process.env.XMACNA_INBOX_INTEGRATION === '1';
const sourceCluster = 'controlled-mode-race';

function barrier(label: string) {
  let release!: () => void;
  let arrived!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { arrived = resolve; });
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Barrier not reached/released: ${label}`)), 3000);
  });
  // The same deadline covers reaching and releasing; handle it even during cleanup.
  void deadline.catch(() => {});
  return {
    ready: Promise.race([ready, deadline]),
    hold: async () => { arrived(); await Promise.race([waiting, deadline]); },
    release: () => { clearTimeout(timer); release(); },
  };
}

type Failure = { role: string; attempt: number; code: unknown; constructor: string; known: boolean };

/** Only these synthetic clients are gated. SQL, transaction options and errors stay real. */
function controlledRepository(
  repository: PrismaClient,
  role: 'claim' | 'downgrade',
  gate: ReturnType<typeof barrier>,
  failures: Failure[],
) {
  let attempts = 0;
  return {
    get attempts() { return attempts; },
    $transaction: async (operation: (tx: any) => Promise<unknown>, options: any) => {
      assert.equal(options.isolationLevel, Prisma.TransactionIsolationLevel.Serializable);
      const attempt = ++attempts;
      try {
        return await repository.$transaction(async (tx) => {
          const proxy = new Proxy(tx, {
            get(target, property) {
              const delegate = Reflect.get(target, property);
              const model = role === 'claim' ? 'instance' : 'inboundReceipt';
              const method = role === 'claim' ? 'findUnique' : 'count';
              if (property !== model || attempt !== 1) return delegate;
              return new Proxy(delegate, {
                get(modelTarget, member) {
                  const original = Reflect.get(modelTarget, member);
                  if (member !== method) return typeof original === 'function' ? original.bind(modelTarget) : original;
                  return async (...args: unknown[]) => {
                    const result = await original.apply(modelTarget, args);
                    await gate.hold(); // after the actual first snapshot read
                    return result;
                  };
                },
              });
            },
          });
          return operation(proxy);
        }, options);
      } catch (error) {
        failures.push({ role, attempt, code: error?.code, constructor: error?.constructor?.name,
          known: error instanceof Prisma.PrismaClientKnownRequestError });
        throw error; // preserve the exact exception consumed by the real retry loop
      }
    },
  };
}

for (const winner of ['claim', 'downgrade'] as const) {
  test(`controlled first snapshots: ${winner} commits first`, { skip: !enabled, timeout: 20_000 }, async (t) => {
    const repository = new PrismaClient();
    const suffix = randomUUID();
    const instanceName = `controlled-${suffix}`;
    const instanceScope = normalizeInstanceScope(instanceName);
    const failures: Failure[] = [];
    const claimGate = barrier('claim first instance read');
    const downgradeGate = barrier('downgrade first empty receipt snapshot');
    const claimRepo = controlledRepository(repository, 'claim', claimGate, failures);
    const downgradeRepo = controlledRepository(repository, 'downgrade', downgradeGate, failures);
    let claim: Promise<any>;
    let downgrade: Promise<any>;
    try {
      await repository.instance.create({ data: { id: instanceName, name: instanceName, inboundInboxMode: 'enforce' } });
      claim = new PrismaInboundInbox(claimRepo as any).claim({
        sourceCluster, instanceId: instanceName, instanceScope,
        contactScope: 'fixture@s.whatsapp.net', messageId: `message-${suffix}`,
        classification: 'real', payloadHash: 'a'.repeat(64), leaseOwner: 'controlled-worker',
      }, 'enforce');
      downgrade = transitionInboundMode(downgradeRepo as any, instanceName, sourceCluster, 'off');
      // Observe rejection immediately while the barriers order the commits.
      const results = Promise.allSettled([claim, downgrade]);
      await Promise.all([claimGate.ready, downgradeGate.ready]);
      if (winner === 'claim') {
        claimGate.release();
        await claim;
        downgradeGate.release();
      } else {
        downgradeGate.release();
        await downgrade;
        claimGate.release();
      }
      const [claimResult, downgradeResult] = await results;
      assert.equal(claimResult.status, 'fulfilled', 'claim must never throw on a single mode race');
      if (claimResult.status !== 'fulfilled') throw claimResult.reason;
      const receiptCount = await repository.inboundReceipt.count({ where: { sourceCluster, instanceScope } });
      const instance = await repository.instance.findUniqueOrThrow({ where: { id: instanceName } });
      if (winner === 'claim') {
        assert.equal(claimResult.value.kind, 'claimed');
        assert.equal(claimResult.value.shouldDispatch, true);
        assert.equal(receiptCount, 1);
        assert.equal(instance.inboundInboxMode, 'enforce');
        assert.equal(downgradeResult.status, 'rejected');
        if (downgradeResult.status !== 'rejected') assert.fail('in-flight receipt must block downgrade');
        assert.ok(downgradeResult.reason instanceof InboundModeTransitionBlockedError);
        assert.equal(downgradeResult.reason.incompleteReceipts, 1);
      } else {
        assert.equal(claimResult.value.kind, 'bypassed');
        assert.equal(claimResult.value.effectiveMode, 'off');
        assert.equal(claimResult.value.shouldDispatch, true);
        assert.equal(receiptCount, 0, 'a degraded claim must not create a receipt');
        assert.equal(instance.inboundInboxMode, 'off');
        assert.equal(downgradeResult.status, 'fulfilled');
      }
      const conflict = failures.filter((failure) => failure.code === 'P2034');
      assert.equal(conflict.length, 1, 'the forced stale snapshot must generate exactly one real write conflict');
      assert.equal(conflict[0].role, winner === 'claim' ? 'downgrade' : 'claim');
      assert.equal(conflict[0].attempt, 1);
      assert.equal(conflict[0].constructor, 'PrismaClientKnownRequestError');
      assert.equal(conflict[0].known, true);
      assert.equal(claimRepo.attempts, winner === 'claim' ? 1 : 2);
      assert.equal(downgradeRepo.attempts, winner === 'claim' ? 2 : 1);
      t.diagnostic(`[mode-race-interleaving] ${JSON.stringify({ winner, failures,
        attempts: { claim: claimRepo.attempts, downgrade: downgradeRepo.attempts } })}`);
    } finally {
      claimGate.release();
      downgradeGate.release();
      await Promise.allSettled([claim, downgrade]);
      await repository.inboundReceipt.deleteMany({ where: { sourceCluster, instanceScope } });
      await repository.instance.deleteMany({ where: { id: instanceName } });
      await repository.$disconnect();
    }
  });
}
