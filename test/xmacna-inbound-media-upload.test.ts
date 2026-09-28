import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runInboundMediaUpload } from '../src/api/integrations/channel/whatsapp/inboundMediaUpload';

const context = { instance: 'test-instance', messageId: 'test-message' };

test('empty media emits a warning with instance and ID and stops before S3', async () => {
  const warnings: string[] = [];
  let uploads = 0;
  const result = await runInboundMediaUpload(context, { warn: (value) => warnings.push(value) }, {
    download: async () => null,
    upload: async () => { uploads++; return {}; },
    createMedia: async () => undefined,
    updateMessage: async () => undefined,
  });
  assert.equal(result, false);
  assert.equal(uploads, 0);
  assert.deepEqual(JSON.parse(warnings[0]), {
    event: 'inbound_media_upload_skipped', ...context, stage: 'download', reason: 'empty_media',
  });
});

test('download exception emits a stage warning and does not create Media', async () => {
  const warnings: string[] = [];
  let creates = 0;
  const result = await runInboundMediaUpload(context, { warn: (value) => warnings.push(value) }, {
    download: async (): Promise<object> => { throw new Error('private upstream URL'); },
    upload: async () => ({}),
    createMedia: async () => { creates++; },
    updateMessage: async () => undefined,
  });
  assert.equal(result, false);
  assert.equal(creates, 0);
  assert.deepEqual(JSON.parse(warnings[0]), {
    event: 'inbound_media_upload_failed', ...context, stage: 'download', errorType: 'Error',
  });
  assert.equal(warnings[0].includes('private upstream URL'), false);
});

test('S3 returned Error stops Media creation and identifies the failing stage', async () => {
  const warnings: string[] = [];
  let creates = 0;
  const result = await runInboundMediaUpload(context, { warn: (value) => warnings.push(value) }, {
    download: async () => ({}),
    upload: async () => new Error('S3 rejected'),
    createMedia: async () => { creates++; },
    updateMessage: async () => undefined,
  });
  assert.equal(result, false);
  assert.equal(creates, 0);
  assert.equal(JSON.parse(warnings[0]).stage, 's3_upload');
});

test('successful upload creates Media and updates the message in order', async () => {
  const calls: string[] = [];
  const result = await runInboundMediaUpload(context, { warn: () => assert.fail('unexpected warning') }, {
    download: async () => { calls.push('download'); return { bytes: 1 }; },
    upload: async () => { calls.push('s3'); return { key: 'local-only' }; },
    createMedia: async (_media, uploaded) => { assert.equal(uploaded.key, 'local-only'); calls.push('media'); },
    updateMessage: async () => { calls.push('message'); },
  });
  assert.equal(result, true);
  assert.deepEqual(calls, ['download', 's3', 'media', 'message']);
});
