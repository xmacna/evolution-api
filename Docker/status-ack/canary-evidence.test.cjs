const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluate, EXPECTED_IMAGE } = require('./canary-evidence.cjs');
function fixture() {
  const start = Date.parse('2026-11-06T10:00:00Z');
  return {
    image: EXPECTED_IMAGE,
    isolated: true,
    productionTouched: false,
    authCloned: false,
    internalConsent: true,
    cycles: Array.from({ length: 4 }, (_, i) => ({
      start: new Date(start + i * 3000000).toISOString(),
      end: new Date(start + (i + 1) * 3000000).toISOString(),
      statusReceived: 2,
      statusAcked: 2,
      statusNacks: 0,
      statusErrors: 0,
      streamErrors: 0,
      reconnects: 0,
      logLocator: 'fixture-only-' + i,
      logSha256: 'a'.repeat(64),
      inboundPairs: [
        {
          messageIdHash: 'fixture-id-' + i,
          evolutionAt: new Date(start + i * 3000000 + 10000).toISOString(),
          webhookAt: new Date(start + i * 3000000 + 21000).toISOString(),
        },
      ],
    })),
  };
}
test('complete declared metadata is only ready for review, never rollout', () => {
  const r = evaluate(fixture());
  assert.equal(r.verdict, 'READY_FOR_REVIEW');
  assert.equal(r.rolloutAuthorized, false);
});
test('zero errors without received Status is HOLD', () => {
  const x = fixture();
  x.cycles[0].statusReceived = x.cycles[0].statusAcked = 0;
  assert.equal(evaluate(x).verdict, 'HOLD');
});
test('less than 200 observed minutes is HOLD', () => {
  const x = fixture();
  x.cycles.pop();
  assert.equal(evaluate(x).verdict, 'HOLD');
});
test('missing ACK or error is HOLD', () => {
  for (const key of ['statusAcked', 'statusNacks', 'statusErrors', 'streamErrors', 'reconnects']) {
    const x = fixture();
    x.cycles[0][key] = 1;
    assert.equal(evaluate(x).verdict, 'HOLD');
  }
});
test('gaps, overlaps and replayed inbound ID are HOLD', () => {
  const x = fixture();
  x.cycles[1].start = x.cycles[0].start;
  x.cycles[1].inboundPairs[0].messageIdHash = x.cycles[0].inboundPairs[0].messageIdHash;
  assert.equal(evaluate(x).verdict, 'HOLD');
});
test('late webhook and unknown counters are HOLD', () => {
  const x = fixture();
  x.cycles[0].inboundPairs[0].webhookAt = '2026-11-06T10:40:00Z';
  delete x.cycles[1].statusNacks;
  assert.equal(evaluate(x).verdict, 'HOLD');
});
test('wrong image, consent or isolation is HOLD', () => {
  const x = fixture();
  x.image = 'unknown';
  x.internalConsent = false;
  x.productionTouched = true;
  assert.equal(evaluate(x).verdict, 'HOLD');
});
test('missing retained logs is HOLD', () => {
  const x = fixture();
  delete x.cycles[0].logSha256;
  assert.equal(evaluate(x).verdict, 'HOLD');
});

function boundaryFixture(delay = 30000) {
  const x = fixture();
  x.webhookBoundaryToleranceMs = 30000;
  const end = Date.parse(x.cycles[0].end);
  x.cycles[0].inboundPairs[0].evolutionAt = new Date(end - 1000).toISOString();
  x.cycles[0].inboundPairs[0].webhookAt = new Date(end + delay).toISOString();
  return x;
}
test('declared tolerance accepts its exact boundary and reports the late delivery', () => {
  const r = evaluate(boundaryFixture());
  assert.equal(r.verdict, 'READY_FOR_REVIEW');
  assert.equal(r.webhookBoundaryToleranceMs, 30000);
  assert.deepEqual(r.boundaryDeliveries, [{ cycle: 1, messageIdHash: 'fixture-id-0', delayPastWindowMs: 30000 }]);
  assert.equal(r.rolloutAuthorized, false);
});
test('one millisecond beyond declared tolerance is HOLD', () => {
  assert.equal(evaluate(boundaryFixture(30001)).verdict, 'HOLD');
});
test('undeclared tolerance remains zero and delivery at end is accepted', () => {
  const x = boundaryFixture(0);
  delete x.webhookBoundaryToleranceMs;
  assert.equal(evaluate(x).verdict, 'READY_FOR_REVIEW');
  x.cycles[0].inboundPairs[0].webhookAt = new Date(Date.parse(x.cycles[0].end) + 1).toISOString();
  assert.equal(evaluate(x).verdict, 'HOLD');
});
test('invalid or unbounded tolerance is HOLD', () => {
  for (const value of [-1, 60001, 0.5, '30000', null, NaN, Infinity]) {
    const x = fixture();
    x.webhookBoundaryToleranceMs = value;
    assert.equal(evaluate(x).verdict, 'HOLD', String(value));
  }
  const x = boundaryFixture(60000);
  x.webhookBoundaryToleranceMs = 60000;
  assert.equal(evaluate(x).verdict, 'READY_FOR_REVIEW');
});
test('tolerance never extends the ten-minute delivery limit', () => {
  const x = boundaryFixture();
  x.cycles[0].inboundPairs[0].evolutionAt = new Date(Date.parse(x.cycles[0].end) - 600000).toISOString();
  assert.equal(evaluate(x).verdict, 'HOLD');
  x.cycles[0].inboundPairs[0].webhookAt = x.cycles[0].end;
  assert.equal(evaluate(x).verdict, 'READY_FOR_REVIEW');
});
test('incoming event belongs to its half-open cycle even with tolerance', () => {
  for (const offset of [0, 1]) {
    const x = boundaryFixture();
    x.cycles[0].inboundPairs[0].evolutionAt = new Date(Date.parse(x.cycles[0].end) + offset).toISOString();
    assert.equal(evaluate(x).verdict, 'HOLD');
  }
  const x = boundaryFixture();
  x.cycles[0].inboundPairs[0].evolutionAt = new Date(Date.parse(x.cycles[0].start) - 1).toISOString();
  assert.equal(evaluate(x).verdict, 'HOLD');
});
test('tolerance cannot hide missing pairs, repeated IDs, cycle gaps or clock reversal', () => {
  for (const mutate of [
    (x) => {
      x.cycles[1].inboundPairs = [];
    },
    (x) => {
      x.cycles[1].inboundPairs[0].messageIdHash = 'fixture-id-0';
    },
    (x) => {
      x.cycles[1].start = new Date(Date.parse(x.cycles[1].start) + 1).toISOString();
    },
    (x) => {
      x.cycles[0].inboundPairs[0].webhookAt = x.cycles[0].start;
    },
  ]) {
    const x = boundaryFixture();
    mutate(x);
    assert.equal(evaluate(x).verdict, 'HOLD');
  }
});
