const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluate, EXPECTED_IMAGE } = require('./canary-evidence.cjs');
function fixture() {
  const start = Date.parse('2026-11-06T10:00:00Z');
  return { image: EXPECTED_IMAGE, isolated: true, productionTouched: false, authCloned: false, internalConsent: true,
    cycles: Array.from({ length: 4 }, (_, i) => ({ start: new Date(start + i * 3000000).toISOString(), end: new Date(start + (i + 1) * 3000000).toISOString(), statusReceived: 2, statusAcked: 2, statusNacks: 0, statusErrors: 0, streamErrors: 0, reconnects: 0, logLocator: 'fixture-only-' + i, logSha256: 'a'.repeat(64), inboundPairs: [{ messageIdHash: 'fixture-id-' + i, evolutionAt: new Date(start + i * 3000000 + 10000).toISOString(), webhookAt: new Date(start + i * 3000000 + 21000).toISOString() }] })) };
}
test('complete declared metadata is only ready for review, never rollout', () => { const r = evaluate(fixture()); assert.equal(r.verdict, 'READY_FOR_REVIEW'); assert.equal(r.rolloutAuthorized, false); });
test('zero errors without received Status is HOLD', () => { const x = fixture(); x.cycles[0].statusReceived = x.cycles[0].statusAcked = 0; assert.equal(evaluate(x).verdict, 'HOLD'); });
test('less than 200 observed minutes is HOLD', () => { const x = fixture(); x.cycles.pop(); assert.equal(evaluate(x).verdict, 'HOLD'); });
test('missing ACK or error is HOLD', () => { for (const key of ['statusAcked', 'statusNacks', 'statusErrors', 'streamErrors', 'reconnects']) { const x = fixture(); x.cycles[0][key] = 1; assert.equal(evaluate(x).verdict, 'HOLD'); } });
test('gaps, overlaps and replayed inbound ID are HOLD', () => { const x = fixture(); x.cycles[1].start = x.cycles[0].start; x.cycles[1].inboundPairs[0].messageIdHash = x.cycles[0].inboundPairs[0].messageIdHash; assert.equal(evaluate(x).verdict, 'HOLD'); });
test('late webhook and unknown counters are HOLD', () => { const x = fixture(); x.cycles[0].inboundPairs[0].webhookAt = '2026-11-06T10:40:00Z'; delete x.cycles[1].statusNacks; assert.equal(evaluate(x).verdict, 'HOLD'); });
test('wrong image, consent or isolation is HOLD', () => { const x = fixture(); x.image = 'unknown'; x.internalConsent = false; x.productionTouched = true; assert.equal(evaluate(x).verdict, 'HOLD'); });
test('missing retained logs is HOLD', () => { const x = fixture(); delete x.cycles[0].logSha256; assert.equal(evaluate(x).verdict, 'HOLD'); });
