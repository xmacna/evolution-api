const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { transformSync } = require('esbuild');
const enabled = process.env.XMACNA_INBOX_INTEGRATION === '1';

function reconciliation(pool) {
  const module = { exports: {} };
  const filename = path.join(__dirname, '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-import-helper.ts');
  vm.runInNewContext(transformSync(fs.readFileSync(filename, 'utf8'), { loader: 'ts', format: 'cjs', target: 'node24' }).code,
    { module, exports: module.exports, require(name) {
      if (name === '@config/logger.config') return { Logger: class { error() {} warn() {} } };
      if (name.endsWith('/postgres.client')) return { postgresClient: { getChatwootConnection: () => pool } };
      return {};
    } });
  return module.exports.chatwootImport;
}

test('real Portal SQL reconciliation scopes account/inbox/recipient and returns display IDs', { skip: !enabled }, async () => {
  const uri = process.env.DATABASE_CONNECTION_URI; const target = new URL(uri);
  assert.ok(['127.0.0.1','localhost','[::1]'].includes(target.hostname), 'loopback test database only');
  const schema = 'meta_echo_' + randomUUID().replaceAll('-','');
  const admin = new Pool({ connectionString: uri, max: 1 });
  const pool = new Pool({ connectionString: uri, max: 2, options: '-c search_path=' + schema + ',public' });
  try {
    await admin.query('CREATE SCHEMA "' + schema + '"');
    await pool.query(`CREATE TABLE contacts(id BIGINT PRIMARY KEY,account_id INT,identifier TEXT,phone_number TEXT);
      CREATE TABLE conversations(id INT PRIMARY KEY,display_id INT,account_id INT,inbox_id INT,contact_id BIGINT);
      CREATE TABLE messages(id BIGINT PRIMARY KEY,account_id INT,inbox_id INT,conversation_id INT,source_id TEXT);
      INSERT INTO contacts VALUES (1,11,'15550000002@s.whatsapp.net','+15550000002'),(2,44,'15550000002@s.whatsapp.net','+15550000002');
      INSERT INTO conversations VALUES (101,7,11,22,1),(202,7,44,55,2);
      INSERT INTO messages VALUES (1001,11,22,101,'WAID:wamid.SYNTHETIC.shared'),(2002,44,55,202,'WAID:wamid.SYNTHETIC.shared');`);
    const helper = reconciliation(pool);
    const scope = { accountId: 11,inboxId:22,recipientJid:'15550000002@s.whatsapp.net' };
    const found = await helper.getExistingMessageBySourceId('WAID:wamid.SYNTHETIC.shared',7,scope);
    assert.equal(found.id,'1001'); assert.equal(found.conversation_id,7); assert.equal(found.inbox_id,22);
    const other = await helper.getExistingMessageBySourceId('WAID:wamid.SYNTHETIC.shared',7,{...scope,accountId:44,inboxId:55});
    assert.equal(other.id,'2002'); assert.equal(other.conversation_id,7);
    assert.equal(await helper.getExistingMessageBySourceId('WAID:wamid.SYNTHETIC.shared',7,{...scope,inboxId:999}),null);
    await assert.rejects(helper.getExistingMessageBySourceId('WAID:wamid.SYNTHETIC.shared',7,{...scope,recipientJid:'15550000999@s.whatsapp.net'}),/identity mismatch/);
  } finally {
    await pool.end(); await admin.query('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE'); await admin.end();
  }
});
