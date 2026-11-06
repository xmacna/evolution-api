/* Evaluate a sanitized canary evidence manifest. Never starts a container or sends messages. */
'use strict';
const fs = require('node:fs');
const EXPECTED_IMAGE = 'sha256:3ce3432e7fb89be020ce4578435a3c06b36e40c18f95aec6ff972e17d43d1a87';
function evaluate(input) {
  const gaps = [];
  if (!input || typeof input !== 'object') return { verdict: 'HOLD', gaps: ['manifest missing'], rolloutAuthorized: false };
  if (input.image !== EXPECTED_IMAGE) gaps.push('image differs from reviewed candidate');
  if (input.isolated !== true || input.productionTouched !== false || input.authCloned !== false) gaps.push('isolation not attested');
  if (input.internalConsent !== true) gaps.push('internal test consent missing');
  const cycles = Array.isArray(input.cycles) ? input.cycles : [];
  if (cycles.length < 4) gaps.push('fewer than four observed cycles');
  const ids = new Set();
  let previousEnd = null;
  for (const [i, cycle] of cycles.entries()) {
    const tag = 'cycle ' + (i + 1);
    const start = Date.parse(cycle.start);
    const end = Date.parse(cycle.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 50 * 60 * 1000) gaps.push(tag + ': less than 50 minutes observed');
    if (previousEnd !== null && start !== previousEnd) gaps.push(tag + ': observation has gap or overlap');
    previousEnd = end;
    if (!Number.isInteger(cycle.statusReceived) || cycle.statusReceived < 1) gaps.push(tag + ': no real Status stanza observed');
    if (cycle.statusAcked !== cycle.statusReceived) gaps.push(tag + ': missing Status ACK');
    for (const key of ['statusNacks', 'statusErrors', 'streamErrors', 'reconnects']) {
      if (cycle[key] !== 0) gaps.push(tag + ': ' + key + ' not zero or unknown');
    }
    if (!cycle.logLocator || !/^[a-f0-9]{64}$/i.test(cycle.logSha256 || '')) gaps.push(tag + ': retained log reference/hash missing');
    const pairs = Array.isArray(cycle.inboundPairs) ? cycle.inboundPairs : [];
    if (!pairs.length) gaps.push(tag + ': no new inbound/webhook pair');
    for (const pair of pairs) {
      const incoming = Date.parse(pair.evolutionAt);
      const delivered = Date.parse(pair.webhookAt);
      if (!pair.messageIdHash || ids.has(pair.messageIdHash)) gaps.push(tag + ': inbound ID absent or reused');
      ids.add(pair.messageIdHash);
      if (!Number.isFinite(incoming) || !Number.isFinite(delivered) || incoming < start || delivered > end || delivered < incoming || delivered - incoming > 600000) gaps.push(tag + ': inbound clock or delivery exceeds limit');
    }
  }
  return { verdict: gaps.length ? 'HOLD' : 'READY_FOR_REVIEW', gaps, rolloutAuthorized: false,
    limit: 'Checks declared metadata only; logs, actual Status receipt and identity require reviewer readback. Rafael review and Vesper approval remain mandatory.' };
}
module.exports = { evaluate, EXPECTED_IMAGE };
if (require.main === module) {
  try {
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    const result = evaluate(input);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exitCode = result.gaps.length ? 2 : 0;
  } catch {
    process.stdout.write(JSON.stringify({ verdict: 'HOLD', gaps: ['invalid JSON input'], rolloutAuthorized: false }) + '\n');
    process.exitCode = 2;
  }
}
