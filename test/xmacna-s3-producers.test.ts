import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { posix, resolve, win32 } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import ts from 'typescript';

process.env.S3_ENABLED = process.env.S3_ENABLED ?? 'false';
import { buildS3ClientConfig, createS3Backend } from '../src/api/integrations/storage/s3/libs/minio.server';

// Read the production initializers instead of giving the backend a pre-normalized fixture.
// Only these expressions run: importing channel classes would initialize unrelated providers.
const producers = [
  { file: 'meta/whatsapp.business.service.ts', expected: ['fixture-instance/fixture-jid/image/fixture.jpg'] },
  { file: 'evolution/evolution.channel.service.ts', expected: ['fixture-instance/fixture-jid/image/fixture.jpg'] },
  {
    file: 'whatsapp/whatsapp.baileys.service.ts',
    expected: [
      'fixture-instance/fixture-jid/image/1700000000000_fixture.jpg',
      'fixture-instance/fixture-jid/fixture-message/image/fixture.jpg',
    ],
  },
];
const bucket = {
  ENABLE: true,
  ACCESS_KEY: 'AKIATEST',
  SECRET_KEY: 'fixture-secret',
  ENDPOINT: 's3.us-east-1.amazonaws.com',
  BUCKET_NAME: 'evolution-media-test',
  PORT: 443,
  USE_SSL: true,
  REGION: 'us-east-1',
  SKIP_POLICY: true,
  SAVE_VIDEO: false,
};

for (const producer of producers) {
  const filename = resolve(__dirname, '../src/api/integrations/channel', producer.file);
  const source = ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
  const expressions: ts.Expression[] = [];
  const imports: Array<{ local: string; imported: string }> = [];
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'fullName') {
      assert.ok(node.initializer, `${producer.file}: fullName must have an initializer`);
      expressions.push(node.initializer);
    }
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      ['path', 'node:path'].includes(node.moduleSpecifier.text)
    ) {
      const bindings = node.importClause?.namedBindings;
      assert.ok(bindings && ts.isNamedImports(bindings), `${producer.file}: inspect the real path bindings`);
      for (const item of bindings.elements)
        imports.push({ local: item.name.text, imported: (item.propertyName ?? item.name).text });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.equal(expressions.length, producer.expected.length, `${producer.file}: cover every fullName producer`);

  for (const [platform, paths] of [
    ['Windows', win32],
    ['Linux', posix],
  ] as const) {
    expressions.forEach((expression, index) => {
      test(`producer→S3 ${producer.file} #${index + 1} on ${platform}`, async () => {
        const context = {
          owner: { instance: { id: 'fixture-instance' } },
          key: { remoteJid: 'fixture-jid' },
          messageRaw: { key: { remoteJid: 'fixture-jid', id: 'fixture-message' } },
          received: { key: { remoteJid: 'fixture-jid' } },
          mediaType: 'image',
          fileName: 'fixture.jpg',
          Date: { now: () => 1700000000000 },
          ...Object.fromEntries(imports.map(({ local, imported }) => [local, paths[imported]])),
        };
        const fullName = runInNewContext(
          `(function () { return ${expression.getText(source)}; }).call(owner)`,
          context,
        );
        const client = new S3Client(buildS3ClientConfig(bucket));
        const calls: PutObjectCommand[] = [];
        client.send = (async (command: PutObjectCommand) => {
          calls.push(command);
          return { ETag: 'fixture-etag' };
        }) as typeof client.send;
        try {
          const backend = createS3Backend(bucket, client);
          const body = Buffer.from('fixture');
          await backend.uploadFile(fullName, body, body.length, { 'Content-Type': 'image/jpeg' });
          const url = new URL(await backend.getObjectUrl(fullName, 60));
          console.info(
            JSON.stringify({
              producer: producer.file,
              index,
              platform,
              key: calls[0].input.Key,
              pathname: url.pathname,
            }),
          );
          assert.equal(fullName, producer.expected[index]);
          assert.equal(calls.length, 1);
          assert.ok(calls[0] instanceof PutObjectCommand);
          assert.equal(calls[0].input.Key, 'evolution-api/' + producer.expected[index]);
          assert.equal(calls[0].input.Body, body);
          assert.equal(calls[0].input.ContentLength, body.length);
          assert.equal(calls[0].input.ContentType, 'image/jpeg');
          assert.equal(url.pathname, '/evolution-api/' + producer.expected[index]);
          assert.ok(!/%5c/i.test(url.pathname));
          assert.equal(url.searchParams.get('X-Amz-Expires'), '60');
          assert.ok(url.searchParams.get('X-Amz-Signature'));
        } finally {
          client.destroy();
        }
      });
    });
  }
}
