// Audited rc14-only patch; never starts Evolution or opens an auth store.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const BASE_SHA = '850445e6f9e076b1beb98034cbc5cf79562dfda26a44f5a874a84e3609bfd710';
const MARKER = 'XMACNA_STATUS_STANZA_ACK_1047';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function once(source, anchor, replacement) {
  if (source.split(anchor).length !== 2) throw new Error('Missing or ambiguous rc14 anchor');
  return source.replace(anchor, replacement);
}
function transform(source) {
  if (sha(source) !== BASE_SHA) throw new Error('Unreviewed messages-recv.js bytes; refusing patch');
  source = once(source, '    const offlineNodeProcessor = makeOfflineNodeProcessor(new Map([',
`    // ${MARKER}: acknowledge the top-level stanza; do not emit messages or read receipts.
    const handleStatus = async (node) => {
        try {
            await sendMessageAck(node);
        }
        catch (error) {
            onUnexpectedError(error, 'acking status stanza');
        }
    };
    const offlineNodeProcessor = makeOfflineNodeProcessor(new Map([`);
  source = once(source, "        ['notification', handleNotification]\n", "        ['notification', handleNotification],\n        ['status', handleStatus]\n");
  return once(source, '    // recv a message\n',
`    ws.on('CB:status', async (node) => {
        try {
            await processNode('status', node, 'acking status stanza', handleStatus);
        }
        catch (error) {
            // Also covers the existing ignored-JID fast path.
            onUnexpectedError(error, 'acking status stanza');
        }
    });
    // recv a message
`);
}
if (require.main === module) {
  const root = process.argv[2];
  if (!root) throw new Error('Usage: node patch.cjs <baileys-root> [--apply]');
  const file = path.join(root, 'lib/Socket/messages-recv.js');
  const original = fs.readFileSync(file, 'utf8');
  const result = transform(original);
  const record = { file, before: sha(original), after: sha(result), applied: process.argv.includes('--apply') };
  if (record.applied) fs.writeFileSync(file, result);
  process.stdout.write(JSON.stringify(record) + '\n');
}
module.exports = { transform, BASE_SHA, MARKER, sha };
