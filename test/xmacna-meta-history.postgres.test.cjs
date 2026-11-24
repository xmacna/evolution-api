const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { transformSync } = require('esbuild');
const enabled = process.env.XMACNA_INBOX_INTEGRATION === '1';

function importer() {
  const module = { exports: {} };
  const filename = path.join(__dirname, '../src/api/integrations/chatbot/chatwoot/chatwootBusinessAppHistory.ts');
  vm.runInNewContext(
    transformSync(fs.readFileSync(filename, 'utf8'), { loader: 'ts', format: 'cjs', target: 'node24' }).code,
    {
      module,
      exports: module.exports,
      require(name) {
        if (name === 'crypto') return require(name);
        if (name === './business-app-history-guard') return guard();
        throw new Error('Unexpected import boundary ' + name);
      },
    },
  );
  return module.exports;
}
function guard() {
  const module = { exports: {} };
  const filename = path.join(__dirname, '../src/api/integrations/chatbot/chatwoot/business-app-history-guard.ts');
  vm.runInNewContext(
    transformSync(fs.readFileSync(filename, 'utf8'), { loader: 'ts', format: 'cjs', target: 'node24' }).code,
    { module, exports: module.exports },
  );
  return module.exports;
}
async function isolated(fn) {
  const uri = process.env.DATABASE_CONNECTION_URI;
  const target = new URL(uri);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname), 'isolated loopback PostgreSQL only');
  const schema = 'meta_sync_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: uri, max: 1 });
  const pool = new Pool({ connectionString: uri, max: 4, options: '-c search_path=' + schema + ',public' });
  try {
    await admin.query('CREATE SCHEMA "' + schema + '"');
    await pool.query(`
      CREATE TABLE "Instance" (id TEXT PRIMARY KEY);
      CREATE TABLE contacts (id SERIAL PRIMARY KEY, account_id INT NOT NULL, identifier TEXT,
        phone_number TEXT, name TEXT, custom_attributes JSONB DEFAULT '{}', created_at TIMESTAMP, updated_at TIMESTAMP, UNIQUE(identifier, account_id));
      CREATE TABLE contact_inboxes (id SERIAL PRIMARY KEY, contact_id INT, inbox_id INT, source_id TEXT,
        created_at TIMESTAMP, updated_at TIMESTAMP, UNIQUE(contact_id, inbox_id));
      CREATE SEQUENCE conversation_display_seq START 1001;
      CREATE TABLE conversations (id SERIAL PRIMARY KEY, display_id INT NOT NULL DEFAULT nextval('conversation_display_seq'),
        account_id INT, inbox_id INT, contact_id INT,
        contact_inbox_id INT, status INT, uuid UUID, last_activity_at TIMESTAMP, created_at TIMESTAMP, updated_at TIMESTAMP,
        assignee_id INT, unread_count INT DEFAULT 0, custom_attributes JSONB DEFAULT '{}', UNIQUE(account_id, display_id));
      CREATE TABLE messages (id SERIAL PRIMARY KEY, account_id INT, inbox_id INT, conversation_id INT,
        message_type INT, private BOOLEAN, content_type INT, sender_type TEXT, sender_id INT, source_id TEXT,
        content TEXT, processed_message_content TEXT, content_attributes JSON DEFAULT '{}', created_at TIMESTAMP, updated_at TIMESTAMP);
    `);
    await pool.query(`CREATE TABLE attachments(id SERIAL PRIMARY KEY, account_id INT, message_id INT, file_type INT, extension TEXT, meta JSONB,created_at TIMESTAMP,updated_at TIMESTAMP);
      CREATE TABLE active_storage_blobs(id BIGSERIAL PRIMARY KEY,filename TEXT,byte_size BIGINT,checksum TEXT);
      CREATE TABLE active_storage_attachments(id BIGSERIAL PRIMARY KEY,name TEXT,record_type TEXT,record_id BIGINT,blob_id BIGINT,created_at TIMESTAMP,
        UNIQUE(record_type,record_id,name,blob_id));`);
    await pool.query(
      fs.readFileSync(
        path.join(__dirname, '../prisma/postgresql-migrations/20261124180000_business_app_sync/migration.sql'),
        'utf8',
      ),
    );
    await pool.query(
      fs.readFileSync(path.join(__dirname, '../docs/coexistence/portal-sql/waid-source-unique.sql'), 'utf8'),
    );
    await fn(pool, schema);
  } finally {
    await pool.end();
    await admin.query('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE');
    await admin.end();
  }
}
const binding = { accountId: 11, inboxId: 22, actorId: 33, actorType: 'User' };
const message = {
  id: 'wamid.SYNTHETIC.history',
  phone: '15550000002',
  fromMe: false,
  timestamp: 1795521600,
  content: 'Synthetic historical content',
};

test(
  'real PostgreSQL history import is idempotent under concurrency without API/Rails callbacks',
  { skip: !enabled },
  async () =>
    isolated(async (pool) => {
      const { importBusinessAppHistoryMessage } = importer();
      const results = await Promise.all(
        Array.from({ length: 12 }, () => importBusinessAppHistoryMessage(pool, binding, message)),
      );
      assert.equal(new Set(results.map((x) => String(x.id))).size, 1);
      const saved = (await pool.query('SELECT * FROM messages')).rows;
      assert.equal(saved.length, 1);
      assert.equal(saved[0].message_type, 0);
      assert.equal(saved[0].source_id, 'WAID:' + message.id);
      const epoch = (await pool.query('SELECT EXTRACT(EPOCH FROM created_at) AS epoch FROM messages')).rows[0].epoch;
      assert.equal(Number(epoch), message.timestamp);
      assert.equal((await pool.query('SELECT status FROM conversations')).rows[0].status, 1);
    }),
);

test(
  'historical data preserves existing live conversation state and late media updates one placeholder',
  { skip: !enabled },
  async () =>
    isolated(async (pool) => {
      const { importBusinessAppHistoryMessage } = importer();
      const first = await importBusinessAppHistoryMessage(pool, binding, { ...message, mediaPlaceholder: true });
      await pool.query(
        `UPDATE conversations SET status=0, assignee_id=77, unread_count=5,
    custom_attributes='{"bot_paused":true}', last_activity_at=to_timestamp(1795529999) WHERE id=$1`,
        [first.conversation_record_id],
      );
      const before = (await pool.query('SELECT * FROM conversations WHERE id=$1', [first.conversation_record_id]))
        .rows[0];
      const updated = await importBusinessAppHistoryMessage(pool, binding, {
        ...message,
        content: 'Synthetic media caption',
        mediaId: 'media-local',
      });
      assert.equal(String(updated.id), String(first.id));
      const after = (await pool.query('SELECT * FROM conversations WHERE id=$1', [first.conversation_record_id]))
        .rows[0];
      assert.deepEqual(after, before);
      const saved = (await pool.query('SELECT * FROM messages')).rows[0];
      assert.equal(saved.content, 'Synthetic media caption');
      assert.equal(saved.content_attributes.business_app_media_id, 'media-local');
      assert.equal(saved.content_attributes.business_app_history_placeholder, true);
      const live = { ...message, id: 'wamid.SYNTHETIC.live', content: 'Original live content' };
      await pool.query(
        `INSERT INTO messages (account_id,inbox_id,conversation_id,source_id,content,content_attributes)
    VALUES ($1,$2,$3,$4,$5,'{}')`,
        [binding.accountId, binding.inboxId, first.conversation_record_id, 'WAID:' + live.id, live.content],
      );
      await importBusinessAppHistoryMessage(pool, binding, {
        ...live,
        content: 'Do not replace live content',
        mediaId: 'another-media',
      });
      assert.equal(
        (await pool.query('SELECT content FROM messages WHERE source_id=$1', ['WAID:' + live.id])).rows[0].content,
        live.content,
      );
    }),
);

test(
  'new sync migration enforces per-instance generation, chunk identity and tenant foreign keys',
  { skip: !enabled },
  async () =>
    isolated(async (pool) => {
      await pool.query(`INSERT INTO "Instance"(id) VALUES ('local-a'),('local-b')`);
      const insertRun = `INSERT INTO "BusinessAppSyncRun" (id,"instanceId",generation,"phoneNumberId","messagingAccountId","portalAccountId","portalInboxId","portalBaseUrl","onboardedAt",deadline,"updatedAt")
    VALUES ($1,$2,$3,'phone-local','account-local',11,22,'https://portal.local.invalid',now(),now()+interval '24 hour',now())`;
      await pool.query(insertRun, ['run-local-a', 'local-a', 'a'.repeat(64)]);
      await assert.rejects(pool.query(insertRun, ['run-local-new', 'local-a', 'b'.repeat(64)]), /unique/i);
      const insert = `INSERT INTO "BusinessAppSyncChunk"(id,"runId","instanceId",field,"payloadHash",payload,"updatedAt")
    VALUES ($1,'run-local-a',$2,'history',$3,$4,now())`;
      await assert.rejects(pool.query(insert, ['chunk-cross-tenant', 'local-b', 'b'.repeat(64), '{}']), /foreign key/i);
      await pool.query(insert, ['chunk-local', 'local-a', 'c'.repeat(64), JSON.stringify({ synthetic: 'durable' })]);
      await assert.rejects(pool.query(insert, ['chunk-duplicate', 'local-a', 'c'.repeat(64), '{}']), /unique/i);
      const claims = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          pool.query(
            `UPDATE "BusinessAppSyncChunk"
    SET state='processing',"leaseOwner"=$1,"leaseVersion"="leaseVersion"+1,"leaseExpiresAt"=now()+interval '1 minute'
    WHERE id='chunk-local' AND state='pending' AND "leaseVersion"=0 RETURNING id`,
            ['worker-' + i],
          ),
        ),
      );
      assert.equal(
        claims.reduce((n, x) => n + x.rowCount, 0),
        1,
      );
    }),
);

function reconciliation(pool) {
  const module = { exports: {} };
  const filename = path.join(__dirname, '../src/api/integrations/chatbot/chatwoot/utils/chatwoot-import-helper.ts');
  vm.runInNewContext(
    transformSync(fs.readFileSync(filename, 'utf8'), { loader: 'ts', format: 'cjs', target: 'node24' }).code,
    {
      module,
      exports: module.exports,
      require(name) {
        if (name === '@config/logger.config')
          return {
            Logger: class {
              error() {}
              warn() {}
            },
          };
        if (name.endsWith('/postgres.client')) return { postgresClient: { getChatwootConnection: () => pool } };
        return {};
      },
    },
  );
  return module.exports.chatwootImport;
}

test(
  'real echo source reconciliation distinguishes internal/display IDs and equal display IDs in other accounts',
  { skip: !enabled },
  async () =>
    isolated(async (pool) => {
      const { importBusinessAppHistoryMessage } = importer();
      const first = await importBusinessAppHistoryMessage(pool, binding, message);
      const conversation = (
        await pool.query('SELECT id,display_id FROM conversations WHERE id=$1', [first.conversation_record_id])
      ).rows[0];
      assert.notEqual(String(conversation.id), String(conversation.display_id));
      const other = { accountId: 44, inboxId: 55, actorId: 66, actorType: 'AgentBot' };
      const second = await importBusinessAppHistoryMessage(pool, other, message);
      await pool.query('UPDATE conversations SET display_id=$1 WHERE id=$2', [
        conversation.display_id,
        second.conversation_record_id,
      ]);
      const helper = reconciliation(pool);
      const found = await helper.getExistingMessageBySourceId('WAID:' + message.id, conversation.display_id, {
        accountId: binding.accountId,
        inboxId: binding.inboxId,
        recipientJid: message.phone + '@s.whatsapp.net',
      });
      assert.ok(found);
      assert.equal(String(found.id), String(first.id));
      assert.equal(String(found.conversation_id), String(conversation.display_id));
      assert.equal(Number(found.inbox_id), binding.inboxId);
      await assert.rejects(
        helper.getExistingMessageBySourceId('WAID:' + message.id, conversation.display_id, {
          accountId: binding.accountId,
          inboxId: binding.inboxId,
          recipientJid: '15550000999@s.whatsapp.net',
        }),
        /identity mismatch/,
      );
    }),
);

test(
  'manual index readiness fails closed for absent, nonunique and divergent predicates; preflight returns only counts',
  { skip: !enabled },
  async () =>
    isolated(async (pool) => {
      const { inspectBusinessAppHistoryIndex } = guard();
      assert.equal((await inspectBusinessAppHistoryIndex(pool, true)).ready, true);
      await pool.query('DROP INDEX index_messages_on_coexistence_waid_unique');
      assert.equal((await inspectBusinessAppHistoryIndex(pool)).ready, false);
      await pool.query(
        "CREATE INDEX index_messages_on_coexistence_waid_unique ON messages(account_id,inbox_id,source_id) WHERE source_id LIKE 'WAID:%'",
      );
      assert.equal((await inspectBusinessAppHistoryIndex(pool)).ready, false);
      await pool.query('DROP INDEX index_messages_on_coexistence_waid_unique');
      await pool.query(
        "CREATE UNIQUE INDEX index_messages_on_coexistence_waid_unique ON messages(account_id,inbox_id,source_id) WHERE source_id LIKE 'OTHER:%'",
      );
      const result = await inspectBusinessAppHistoryIndex(pool, true);
      assert.equal(result.ready, false);
      assert.equal(result.duplicateGroups, 0);
      assert.equal(JSON.stringify(result).includes(message.id), false);
      await assert.rejects(
        importer().importBusinessAppHistoryMessage(pool, binding, message),
        /unique index unavailable/,
      );
    }),
);

test(
  'outgoing sender preserves User or AgentBot actor, unknown actor fails before persistence',
  { skip: !enabled },
  async () =>
    isolated(async (pool) => {
      const { importBusinessAppHistoryMessage: save } = importer();
      await save(pool, binding, { ...message, fromMe: true });
      await save(
        pool,
        { ...binding, actorType: 'AgentBot', actorId: 44 },
        { ...message, id: message.id + '.bot', fromMe: true },
      );
      const rows = (await pool.query('SELECT sender_type,sender_id FROM messages ORDER BY id')).rows;
      assert.deepEqual(rows, [
        { sender_type: 'User', sender_id: 33 },
        { sender_type: 'AgentBot', sender_id: 44 },
      ]);
      await assert.rejects(
        save(pool, { ...binding, actorType: 'Other' }, { ...message, id: message.id + '.invalid' }),
        /binding invalid/,
      );
      assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM messages')).rows[0].n, 2);
    }),
);

test(
  'API-like writer without advisory lock wins race; unique violation reconciles scoped display IDs',
  { skip: !enabled },
  async () =>
    isolated(async (pool) => {
      const save = importer().importBusinessAppHistoryMessage;
      const seed = await save(pool, binding, { ...message, id: message.id + '.seed' });
      let raced = false;
      const boundary = {
        async connect() {
          const client = await pool.connect();
          return {
            release: () => client.release(),
            async query(sql, args) {
              if (!raced && sql.includes('INSERT INTO messages')) {
                raced = true;
                await pool.query(
                  `INSERT INTO messages(account_id,inbox_id,conversation_id,source_id,content,content_attributes)
        VALUES($1,$2,$3,$4,'API original','{}')`,
                  [binding.accountId, binding.inboxId, seed.conversation_record_id, 'WAID:' + message.id],
                );
              }
              return client.query(sql, args);
            },
          };
        },
      };
      const found = await save(boundary, binding, message);
      assert.equal(raced, true);
      assert.equal(found.conversation_display_id, seed.conversation_display_id);
      assert.equal(found.conversation_record_id, seed.conversation_record_id);
      assert.equal(
        (await pool.query('SELECT content FROM messages WHERE id=$1', [found.id])).rows[0].content,
        'API original',
      );
      assert.equal(
        (await pool.query('SELECT COUNT(*)::int AS n FROM messages WHERE source_id=$1', ['WAID:' + message.id])).rows[0]
          .n,
        1,
      );
      await assert.rejects(save(pool, binding, { ...message, phone: '15550000999' }), /recipient mismatch/);
    }),
);

function mediaImporter() {
  const module = { exports: {} };
  const filename = path.join(__dirname, '../src/api/integrations/chatbot/chatwoot/business-app-history-media.ts');
  vm.runInNewContext(
    transformSync(fs.readFileSync(filename, 'utf8'), { loader: 'ts', format: 'cjs', target: 'node24' }).code,
    {
      module,
      exports: module.exports,
      Buffer,
      URL,
      require(name) {
        if (name === 'crypto') return require(name);
        if (name === './business-app-history-guard') return guard();
        throw new Error('Unexpected media boundary ' + name);
      },
    },
  );
  return module.exports.attachBusinessAppHistoryMedia;
}
test(
  'native ActiveStorage bytes attach to historical message, PUT failure keeps placeholder and retry does not duplicate attachments',
  { skip: !enabled },
  async () =>
    isolated(async (pool) => {
      const save = importer().importBusinessAppHistoryMessage;
      const target = await save(pool, binding, { ...message, mediaPlaceholder: true, mediaId: 'synthetic-media' });
      const before = (await pool.query('SELECT * FROM conversations WHERE id=$1', [target.conversation_record_id]))
        .rows[0];
      const bytes = Buffer.from('synthetic PNG bytes, no real customer data');
      const media = {
        id: 'synthetic-media',
        type: 'image',
        bytes,
        filename: 'synthetic.png',
        mimetype: 'image/png',
        sha256: require('node:crypto').createHash('sha256').update(bytes).digest('hex'),
      };
      let failPut = true,
        posts = 0,
        puts = 0;
      const http = {
        async post(url, body, options) {
          posts++;
          assert.ok(url.endsWith('/conversations/' + target.conversation_display_id + '/direct_uploads'));
          assert.notEqual(target.conversation_record_id, target.conversation_display_id);
          assert.equal(options.headers.api_access_token, 'synthetic-portal-secret');
          assert.equal(body.blob.byte_size, bytes.length);
          const row = (
            await pool.query(
              'INSERT INTO active_storage_blobs(filename,byte_size,checksum) VALUES($1,$2,$3) RETURNING *',
              [body.blob.filename, body.blob.byte_size, body.blob.checksum],
            )
          ).rows[0];
          return {
            data: {
              ...row,
              direct_upload: {
                url: 'https://storage.local.invalid/upload?signed=synthetic',
                headers: { 'Content-MD5': body.blob.checksum, 'Content-Type': media.mimetype },
              },
            },
          };
        },
        async put(url, body, options) {
          puts++;
          assert.equal(url.includes('synthetic-portal-secret'), false);
          assert.deepEqual(Object.keys(options.headers).sort(), ['Content-MD5', 'Content-Type']);
          assert.deepEqual(body, bytes);
          if (failPut)
            throw Object.assign(new Error('secret synthetic-portal-secret'), {
              config: { headers: { Authorization: 'Bearer synthetic-meta-secret' } },
            });
        },
      };
      const attach = mediaImporter();
      const provider = { url: 'https://portal.local.invalid', token: 'synthetic-portal-secret' };
      await assert.rejects(
        attach(pool, binding, provider, target, media, http, async () => {}),
        (error) => {
          assert.equal(error.message, 'Historical native media upload failed');
          return true;
        },
      );
      assert.equal(
        (await pool.query('SELECT content_attributes FROM messages WHERE id=$1', [target.id])).rows[0]
          .content_attributes.business_app_history_placeholder,
        true,
      );
      assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM attachments')).rows[0].n, 0);
      failPut = false;
      await attach(pool, binding, provider, target, media, http, async () => {});
      await attach(pool, binding, provider, target, media, http, async () => {});
      assert.equal(posts, 2);
      assert.equal(puts, 2);
      const native = (
        await pool.query(
          `SELECT a.file_type,b.filename,b.byte_size FROM attachments a JOIN active_storage_attachments f ON f.record_type='Attachment' AND f.record_id=a.id AND f.name='file'
    JOIN active_storage_blobs b ON b.id=f.blob_id WHERE a.message_id=$1`,
          [target.id],
        )
      ).rows;
      assert.equal(native.length, 1);
      assert.equal(native[0].file_type, 0);
      assert.equal(native[0].filename, media.filename);
      assert.equal(Number(native[0].byte_size), bytes.length);
      assert.equal(
        (await pool.query('SELECT content_attributes FROM messages WHERE id=$1', [target.id])).rows[0]
          .content_attributes.business_app_history_placeholder,
        false,
      );
      assert.deepEqual(
        (await pool.query('SELECT * FROM conversations WHERE id=$1', [target.conversation_record_id])).rows[0],
        before,
      );
      assert.equal(
        (await pool.query('SELECT COUNT(*)::int AS n FROM active_storage_blobs')).rows[0].n,
        2,
        'remote acceptance gap leaves an orphan blob, documented rather than unsafe deletion',
      );
    }),
);
test(
  'media checksum mismatch and unsafe storage URL fail without attaching or exposing tokens',
  { skip: !enabled },
  async () =>
    isolated(async (pool) => {
      const target = await importer().importBusinessAppHistoryMessage(pool, binding, {
        ...message,
        mediaPlaceholder: true,
      });
      const attach = mediaImporter(),
        bytes = Buffer.from('synthetic'),
        provider = { url: 'https://portal.local.invalid', token: 'synthetic-portal-secret' };
      const media = {
        id: 'synthetic-media',
        type: 'audio',
        bytes,
        filename: 'synthetic.ogg',
        mimetype: 'audio/ogg',
        sha256: '0'.repeat(64),
      };
      let posts = 0,
        puts = 0;
      const http = {
        async post(_url, body) {
          posts++;
          return {
            data: {
              id: 1,
              byte_size: bytes.length,
              checksum: body.blob.checksum,
              direct_upload: { url: 'http://storage.local.invalid', headers: {} },
            },
          };
        },
        async put() {
          puts++;
        },
      };
      await assert.rejects(
        attach(pool, binding, provider, target, media, http, async () => {}),
        /checksum mismatch/,
      );
      assert.equal(posts, 0);
      await assert.rejects(
        attach(pool, binding, provider, target, { ...media, sha256: undefined }, http, async () => {}),
        /native media upload failed/,
      );
      assert.equal(puts, 0);
      assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM attachments')).rows[0].n, 0);
    }),
);
test(
  'contact sync preserves remove tombstone and ignores older add without deleting history',
  { skip: !enabled },
  async () =>
    isolated(async (pool) => {
      const { importBusinessAppContact: contact } = importer();
      await contact(pool, binding, { phone: message.phone, fullName: 'Newest', timestamp: 200, action: 'add' });
      await contact(pool, binding, { phone: message.phone, timestamp: 300, action: 'remove' });
      await contact(pool, binding, { phone: message.phone, fullName: 'Old', timestamp: 100, action: 'add' });
      const saved = (await pool.query('SELECT * FROM contacts')).rows[0];
      assert.equal(saved.name, 'Newest');
      assert.equal(saved.custom_attributes.business_app_contact_sync_action, 'remove');
      await contact(pool, binding, { phone: '15550000999', timestamp: 300, action: 'remove' });
      assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM contacts')).rows[0].n, 1);
    }),
);

let PrismaClient;
try {
  ({ PrismaClient } = require('@prisma/client'));
} catch {
  /* local tooling may be absent; CI requires it explicitly */
}
test(
  'actual Prisma core survives client/process-state replacement and checkpoints cursor on isolated PostgreSQL',
  { skip: !enabled || (!PrismaClient && process.env.META_SYNC_REQUIRE_PRISMA !== '1') },
  async () =>
    isolated(async (pool, schema) => {
      assert.ok(PrismaClient, 'CI must provide the generated locked Prisma client');
      const source = fs.readFileSync(
        path.join(__dirname, '../src/api/integrations/channel/meta/business-app-sync.ts'),
        'utf8',
      );
      const module = { exports: {} };
      vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs', target: 'node24' }).code, {
        module,
        exports: module.exports,
        URL,
        require(name) {
          if (name === 'crypto') return require(name);
          throw new Error('Unexpected core dependency ' + name);
        },
      });
      const Service = module.exports.BusinessAppSync;
      const url = new URL(process.env.DATABASE_CONNECTION_URI);
      url.searchParams.set('schema', schema);
      const bind = {
        instanceId: 'prisma-local',
        instanceName: 'prisma-local',
        phoneNumberId: 'phone-local',
        messagingAccountId: 'account-local',
      };
      const generation = require('node:crypto').createHash('sha256').update('account-local:phone-local').digest('hex');
      const options = {
        enabled: true,
        appSecretConfigured: true,
        callbackUrl: 'https://evolve.local.invalid/webhook/meta',
        clock: () => Date.parse('2026-11-24T13:00:00Z'),
        destination: async () => ({
          portalAccountId: 11,
          portalInboxId: 22,
          portalBaseUrl: 'https://portal.local.invalid',
        }),
      };
      await pool.query('INSERT INTO "Instance"(id) VALUES($1)', [bind.instanceId]);
      let client = new PrismaClient({ datasources: { db: { url: url.href } } });
      let service = new Service(client, bind, options, async () => ({}));
      try {
        await service.start({
          generation,
          phoneNumberId: bind.phoneNumberId,
          messagingAccountId: bind.messagingAccountId,
          onboardedAt: '2026-11-24T12:00:00Z',
        });
        await service.capture(
          'history',
          {
            metadata: { phone_number_id: bind.phoneNumberId },
            history: [{ metadata: { progress: 100 }, threads: [{ messages: [{ id: 'one' }, { id: 'two' }] }] }],
          },
          bind.messagingAccountId,
        );
        await service.drain(1);
        assert.equal((await client.businessAppSyncChunk.findFirst()).cursor, 1);
        await client.$disconnect();
        client = new PrismaClient({ datasources: { db: { url: url.href } } });
        const projected = [];
        service = new Service(client, bind, options, async (_run, unit) => {
          projected.push(unit.message.id);
          return {};
        });
        await Promise.all([
          service.drain(),
          new Service(client, bind, options, async (_run, unit) => {
            projected.push(unit.message.id);
            return {};
          }).drain(),
        ]);
        assert.deepEqual(projected, ['two']);
        const status = await service.status();
        assert.equal(status.history.sourceProgress, 100);
        assert.equal(status.history.importState, 'caught_up');
      } finally {
        await client.$disconnect();
      }
    }),
);

function runtimeProjector(pool, repository) {
  const module = { exports: {} };
  const filename = path.join(__dirname, '../src/api/integrations/channel/meta/business-app-sync-runtime.ts');
  vm.runInNewContext(
    transformSync(fs.readFileSync(filename, 'utf8'), { loader: 'ts', format: 'cjs', target: 'node24' }).code,
    {
      module,
      exports: module.exports,
      URL,
      Buffer,
      setInterval: () => ({ unref() {} }),
      clearInterval() {},
      require(name) {
        if (name === 'crypto') return require(name);
        if (name === './business-app-sync')
          return {
            BusinessAppSync: class {
              async drain() {}
            },
          }; // lifecycle only; production projector/helpers run below
        if (name.endsWith('/libs/postgres.client')) return { postgresClient: { getChatwootConnection: () => pool } };
        if (name.endsWith('/business-app-history-guard')) return guard();
        if (name.endsWith('/business-app-history-media')) return { attachBusinessAppHistoryMedia: mediaImporter() };
        if (name.endsWith('/chatwootBusinessAppHistory')) return importer();
        if (name === 'mime-types') return { extension: () => 'png' };
        if (name === 'axios')
          return {
            post() {
              assert.fail('no message API/Graph write');
            },
          };
        throw new Error('Unexpected runtime import ' + name);
      },
    },
  );
  const config = {
    get(key) {
      return key === 'WA_BUSINESS'
        ? {
            APP_SECRET: 'synthetic',
            COEXISTENCE_SYNC_BINDINGS: JSON.stringify({
              'local-a': { phoneNumberId: 'phone-local', messagingAccountId: 'account-local' },
            }),
            COEXISTENCE_SYNC_PORTAL_URL: 'https://portal.local.invalid',
          }
        : { ENABLED: true, IMPORT: { DATABASE: { CONNECTION: { URI: 'synthetic' } } } };
    },
  };
  return new module.exports.BusinessAppSyncRuntime(
    repository,
    config,
    { instanceId: 'instance-local', instanceName: 'local-a', number: 'phone-local' },
    async () => assert.fail('text has no media'),
    () => {},
  );
}
test('real runtime text projection reuses its transaction client with pool max1', { skip: !enabled }, async () =>
  isolated(async (pool, schema) => {
    await pool.query(`CREATE TABLE inboxes(id INT,account_id INT,name TEXT);INSERT INTO inboxes VALUES(22,11,'Synthetic');
    CREATE TABLE access_tokens(token TEXT,owner_type TEXT,owner_id INT);INSERT INTO access_tokens VALUES('synthetic-token','AgentBot',33);`);
    const single = new Pool({
      connectionString: process.env.DATABASE_CONNECTION_URI,
      max: 1,
      connectionTimeoutMillis: 200,
      options: '-c search_path=' + schema + ',public',
    });
    const repository = {
      chatwoot: {
        findUnique: async () => ({
          enabled: true,
          accountId: '11',
          nameInbox: 'Synthetic',
          token: 'synthetic-token',
          url: 'https://portal.local.invalid',
        }),
      },
      instance: { findUnique: async () => ({ number: 'phone-local' }) },
    };
    const runtime = runtimeProjector(single, repository);
    try {
      await runtime.project(
        {
          phoneNumberId: 'phone-local',
          messagingAccountId: 'account-local',
          portalAccountId: 11,
          portalInboxId: 22,
          portalBaseUrl: 'https://portal.local.invalid',
        },
        {
          kind: 'message',
          metadata: { display_phone_number: '15550000001' },
          thread: { id: message.phone, context: { wa_id: message.phone } },
          message: {
            id: message.id,
            from: message.phone,
            timestamp: String(message.timestamp),
            type: 'text',
            text: { body: message.content },
          },
        },
        async () => {},
      );
      assert.equal((await single.query('SELECT COUNT(*)::int AS n FROM messages')).rows[0].n, 1);
    } finally {
      runtime.close();
      await single.end();
    }
  }),
);

test(
  'concurrent contact processors cannot project an older name after the newer remove stamp',
  { skip: !enabled },
  async () =>
    isolated(async (pool) => {
      const contact = importer().importBusinessAppContact;
      let release, arrived;
      const gate = new Promise((r) => (release = r)),
        waiting = new Promise((r) => (arrived = r));
      const delayed = {
        async connect() {
          const client = await pool.connect();
          return {
            release: () => client.release(),
            async query(sql, args) {
              if (sql.includes('pg_advisory_xact_lock')) {
                arrived();
                await gate;
              }
              return client.query(sql, args);
            },
          };
        },
      };
      const older = contact(delayed, binding, { phone: message.phone, fullName: 'Old', timestamp: 100, action: 'add' });
      await waiting;
      await contact(pool, binding, { phone: message.phone, fullName: 'New', timestamp: 200, action: 'add' });
      await contact(pool, binding, { phone: message.phone, timestamp: 300, action: 'remove' });
      release();
      await older;
      const row = (await pool.query('SELECT name,custom_attributes FROM contacts')).rows[0];
      assert.equal(row.name, 'New');
      assert.equal(row.custom_attributes.business_app_contact_sync_timestamp, 300);
      assert.equal(row.custom_attributes.business_app_contact_sync_action, 'remove');
    }),
);

test(
  'remove of nonexistent contact supersedes a processor that already read the older add ledger',
  { skip: !enabled },
  async () =>
    isolated(async (pool) => {
      await pool.query(`CREATE TABLE inboxes(id INT,account_id INT,name TEXT);INSERT INTO inboxes VALUES(22,11,'Synthetic');
    CREATE TABLE access_tokens(token TEXT,owner_type TEXT,owner_id INT);INSERT INTO access_tokens VALUES('synthetic-token','AgentBot',33);`);
      const { memoryRepository } = require('./helpers/meta-sync-repository.cjs');
      const repo = memoryRepository();
      repo.chatwoot = {
        findUnique: async () => ({
          enabled: true,
          accountId: '11',
          nameInbox: 'Synthetic',
          token: 'synthetic-token',
          url: 'https://portal.local.invalid',
        }),
      };
      repo.instance = { findUnique: async () => ({ number: 'phone-local' }) };
      let release, arrived;
      const gate = new Promise((r) => (release = r)),
        waiting = new Promise((r) => (arrived = r));
      let count = 0;
      const boundary = {
        query: (...args) => pool.query(...args),
        async connect() {
          if (++count === 1) {
            arrived();
            await gate;
          }
          return pool.connect();
        },
      };
      const runtime = runtimeProjector(boundary, repo);
      const run = {
        phoneNumberId: 'phone-local',
        messagingAccountId: 'account-local',
        portalAccountId: 11,
        portalInboxId: 22,
        portalBaseUrl: 'https://portal.local.invalid',
      };
      const unit = {
        kind: 'contact',
        contactType: 'contact',
        metadata: {},
        action: 'add',
        timestamp: '100',
        contact: { phone_number: message.phone, full_name: 'Old' },
      };
      const older = runtime.project(run, unit, async () => {});
      await waiting;
      await runtime.project(
        run,
        { ...unit, action: 'remove', timestamp: '300', contact: { phone_number: message.phone } },
        async () => {},
      );
      release();
      await assert.rejects(older, /superseded/);
      await runtime.project(run, unit, async () => {}); // retry observes the newer ledger and safely advances without an obsolete add
      assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM contacts')).rows[0].n, 0);
      assert.equal([...repo.tables.contact.values()][0].action, 'remove');
      runtime.close();
    }),
);
