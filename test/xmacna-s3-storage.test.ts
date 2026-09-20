import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';

import {
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  PutBucketPolicyCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

process.env.S3_ENABLED = process.env.S3_ENABLED ?? 'false';

// xmacna/elysium#518: the storage wrapper moved from `minio` to `@aws-sdk/client-s3`. These
// tests pin the contract the six callers rely on (object key layout, metadata split,
// presigned URL expiry, no-op when disabled, swallowed upload/delete errors).
import { buildS3ClientConfig, createS3Backend, DEFAULT_PRESIGN_EXPIRY_SECONDS } from '../src/api/integrations/storage/s3/libs/minio.server';

const bucket = {
  ENABLE: true,
  ACCESS_KEY: 'AKIATEST',
  SECRET_KEY: 'secret',
  ENDPOINT: 's3.us-east-1.amazonaws.com',
  BUCKET_NAME: 'evolution-media-test',
  PORT: 443,
  USE_SSL: true,
  REGION: 'us-east-1',
  SKIP_POLICY: false,
  SAVE_VIDEO: false,
} as any;

function fakeClient(script: Record<string, unknown | Error> = {}) {
  const calls: Array<{ name: string; input: any }> = [];
  return {
    calls,
    send: async (command: any) => {
      const name = command.constructor.name;
      calls.push({ name, input: command.input });
      const outcome = script[name];
      if (outcome instanceof Error) throw outcome;
      return outcome ?? {};
    },
  };
}

test('AWS endpoints use virtual-host style; anything else is path style (minio parity)', () => {
  const aws = buildS3ClientConfig(bucket);
  assert.equal(aws.endpoint, 'https://s3.us-east-1.amazonaws.com');
  assert.equal(aws.forcePathStyle, false);
  assert.equal(aws.region, 'us-east-1');
  const selfHosted = buildS3ClientConfig({ ...bucket, ENDPOINT: 'minio.internal', PORT: 9000, USE_SSL: false });
  assert.equal(selfHosted.endpoint, 'http://minio.internal:9000');
  assert.equal(selfHosted.forcePathStyle, true);
});

test('uploadFile stores under evolution-api/ with Content-Type as header and the rest as metadata', async () => {
  const client = fakeClient({ PutObjectCommand: { ETag: '"abc"' } });
  const backend = createS3Backend(bucket, client);
  const body = Buffer.from('hello');
  const result = await backend.uploadFile('inst/audio/x.ogg', body, body.length, { 'Content-Type': 'audio/ogg' } as any);
  assert.deepEqual(result, { ETag: '"abc"' });
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].name, PutObjectCommand.name);
  assert.equal(client.calls[0].input.Bucket, 'evolution-media-test');
  assert.equal(client.calls[0].input.Key, 'evolution-api/inst/audio/x.ogg');
  assert.equal(client.calls[0].input.ContentType, 'audio/ogg');
  assert.equal(client.calls[0].input.ContentLength, 5);
  assert.deepEqual(client.calls[0].input.Metadata, { 'custom-header-application': 'evolution-api' });
});

test('uploadTempFile keeps the caller folder; streams pass ContentLength through', async () => {
  const client = fakeClient();
  const backend = createS3Backend(bucket, client);
  await backend.uploadTempFile('tmp', 'y.bin', Readable.from([Buffer.from('ab')]), 2, { 'Content-Type': 'application/octet-stream' } as any);
  assert.equal(client.calls[0].input.Key, 'tmp/y.bin');
  assert.equal(client.calls[0].input.ContentLength, 2);
});

test('upload and delete errors are logged and returned, never thrown (caller contract)', async () => {
  const boom = new Error('AccessDenied');
  const client = fakeClient({ PutObjectCommand: boom, DeleteObjectCommand: boom });
  const backend = createS3Backend(bucket, client);
  assert.equal(await backend.uploadFile('a', Buffer.alloc(1), 1, { 'Content-Type': 'x' } as any), boom);
  assert.equal(await backend.deleteFile('evolution-api', 'a'), boom);
  assert.equal(client.calls[1].name, DeleteObjectCommand.name);
  assert.equal(client.calls[1].input.Key, 'evolution-api/a');
});

test('getObjectUrl presigns evolution-api/<file> for 7 days by default and caps custom expiry at 7 days', async () => {
  const backend = createS3Backend(bucket, new S3Client(buildS3ClientConfig(bucket)));
  const url = new URL(await backend.getObjectUrl('inst/img.jpg'));
  assert.equal(url.hostname, 'evolution-media-test.s3.us-east-1.amazonaws.com');
  assert.equal(url.pathname, '/evolution-api/inst/img.jpg');
  assert.equal(url.searchParams.get('X-Amz-Expires'), String(DEFAULT_PRESIGN_EXPIRY_SECONDS));
  assert.ok(url.searchParams.get('X-Amz-Signature'));
  const short = new URL(await backend.getObjectUrl('inst/img.jpg', 60));
  assert.equal(short.searchParams.get('X-Amz-Expires'), '60');
  const capped = new URL(await backend.getObjectUrl('inst/img.jpg', 99 * 24 * 3600));
  assert.equal(capped.searchParams.get('X-Amz-Expires'), String(DEFAULT_PRESIGN_EXPIRY_SECONDS));
});

test('createBucket: existing bucket only gets the public-read policy; missing bucket is created first', async () => {
  const existing = fakeClient();
  await createS3Backend(bucket, existing).createBucket();
  assert.deepEqual(
    existing.calls.map((c) => c.name),
    [HeadBucketCommand.name, PutBucketPolicyCommand.name],
  );
  assert.match(existing.calls[1].input.Policy, /"s3:GetObject"/);
  assert.match(existing.calls[1].input.Policy, /arn:aws:s3:::evolution-media-test\/\*/);

  const missing = fakeClient({ HeadBucketCommand: new Error('NotFound') });
  await createS3Backend({ ...bucket, SKIP_POLICY: true }, missing).createBucket();
  assert.deepEqual(
    missing.calls.map((c) => c.name),
    [HeadBucketCommand.name, CreateBucketCommand.name],
  );
});

test('disabled storage: every function is a no-op returning undefined', async () => {
  const backend = createS3Backend({ ...bucket, ENABLE: false }, undefined);
  assert.equal(await backend.uploadFile('a', Buffer.alloc(1), 1, { 'Content-Type': 'x' } as any), undefined);
  assert.equal(await backend.getObjectUrl('a'), undefined);
  assert.equal(await backend.deleteFile('f', 'a'), undefined);
  assert.equal(await backend.createBucket(), undefined);
});
