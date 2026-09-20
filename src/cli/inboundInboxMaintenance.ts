import {
  inboundPayloadHash,
  normalizeContactScope,
  normalizeInstanceScope,
} from '@api/integrations/channel/whatsapp/inboundInbox';
import { PrismaClient } from '@prisma/client';
import { closeSync, openSync, readFileSync, writeFileSync } from 'fs';

type Command = 'backfill' | 'export' | 'import';

export type Options = {
  command: Command;
  sourceCluster?: string;
  instanceName?: string;
  targetCluster?: string;
  targetScope?: string;
  input?: string;
  output?: string;
  batchSize: number;
  live: boolean;
};

type Tombstone = {
  messageId: string;
  classification: string;
  payloadHash: string;
  collisionHash?: string | null;
  contactScope: string;
};

type TombstoneManifest = {
  schemaVersion: 1;
  sourceCluster: string;
  sourceScope: string;
  exportedAt: string;
  tombstones: Tombstone[];
};

function usage(): never {
  console.error(
    [
      'Usage:',
      '  npm run inbound-inbox:maintenance -- backfill --source-cluster NAME --instance-name NAME [--batch-size N] [--live]',
      '  npm run inbound-inbox:maintenance -- export --source-cluster NAME --instance-name NAME --output FILE',
      '  npm run inbound-inbox:maintenance -- import --input FILE --target-cluster NAME --target-scope NAME [--live]',
      '',
      'backfill/import are dry-run by default. export refuses to overwrite FILE.',
    ].join('\n'),
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Options {
  const command = argv.shift() as Command;
  if (!['backfill', 'export', 'import'].includes(command)) usage();
  const options: Options = { command, batchSize: 500, live: false };
  while (argv.length > 0) {
    const flag = argv.shift();
    if (flag === '--live') options.live = true;
    else if (flag === '--source-cluster') options.sourceCluster = argv.shift();
    else if (flag === '--instance-name') options.instanceName = argv.shift();
    else if (flag === '--target-cluster') options.targetCluster = argv.shift();
    else if (flag === '--target-scope') options.targetScope = argv.shift();
    else if (flag === '--input') options.input = argv.shift();
    else if (flag === '--output') options.output = argv.shift();
    else if (flag === '--batch-size') options.batchSize = Number.parseInt(argv.shift() || '', 10);
    else usage();
  }
  if (!Number.isInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 5000) usage();
  if (command === 'backfill' && (!options.sourceCluster || !options.instanceName)) usage();
  if (command === 'export' && (!options.sourceCluster || !options.instanceName || !options.output)) usage();
  if (command === 'import' && (!options.input || !options.targetCluster || !options.targetScope)) usage();
  return options;
}

function assertSafeName(value: string, label: string): string {
  const normalized = value.normalize('NFKC').trim();
  if (!normalized || normalized.length > 255 || [...normalized].some((character) => character.charCodeAt(0) < 32)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

export async function backfill(prisma: PrismaClient, options: Options): Promise<void> {
  const instanceName = assertSafeName(options.instanceName!, 'instance-name');
  const sourceCluster = assertSafeName(options.sourceCluster!, 'source-cluster');
  const instance = await prisma.instance.findUnique({
    where: { name: instanceName },
    select: { id: true, name: true },
  });
  if (!instance) throw new Error(`Instance not found: ${instanceName}`);
  const instanceScope = normalizeInstanceScope(instance.name);
  let cursor: string | undefined;
  let scanned = 0;
  let candidates = 0;
  let inserted = 0;

  for (;;) {
    const messages = await prisma.message.findMany({
      where: { instanceId: instance.id },
      orderBy: { id: 'asc' },
      take: options.batchSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, key: true, message: true, messageType: true },
    });
    if (messages.length === 0) break;
    cursor = messages[messages.length - 1].id;
    scanned += messages.length;
    const messageIds = messages.map((message) => (message.key as any)?.id).filter(Boolean) as string[];
    const existing = await prisma.inboundReceipt.findMany({
      where: { sourceCluster, instanceScope, messageId: { in: messageIds } },
      select: { messageId: true },
    });
    const existingIds = new Set(existing.map((receipt) => receipt.messageId));
    const rows = messages
      .filter((message) => {
        const messageId = (message.key as any)?.id;
        return messageId && !existingIds.has(messageId);
      })
      .map((message) => ({
        sourceCluster,
        instanceScope,
        contactScope: normalizeContactScope((message.key as any)?.remoteJidAlt || (message.key as any)?.remoteJid),
        messageId: (message.key as any).id as string,
        classification: 'real',
        payloadHash: inboundPayloadHash({ key: message.key, message: message.message } as any),
        state: 'historical_seen',
        webhookState: 'skipped',
        chatwootState: 'skipped',
        chatbotState: 'skipped',
        messageRecordId: message.id,
      }));
    candidates += rows.length;
    if (options.live && rows.length > 0) {
      inserted += (await prisma.inboundReceipt.createMany({ data: rows, skipDuplicates: true })).count;
    }
  }
  console.log(
    JSON.stringify({ mode: options.live ? 'live' : 'dry-run', scanned, candidates, inserted, instanceScope }),
  );
}

export async function exportTombstones(prisma: PrismaClient, options: Options): Promise<void> {
  const sourceCluster = assertSafeName(options.sourceCluster!, 'source-cluster');
  const instanceName = assertSafeName(options.instanceName!, 'instance-name');
  const instanceScope = normalizeInstanceScope(instanceName);
  const incomplete = await prisma.inboundReceipt.count({
    where: { sourceCluster, instanceScope, state: { in: ['received', 'processing', 'failed'] } },
  });
  if (incomplete > 0) throw new Error(`Refusing export: ${incomplete} receipts are incomplete`);
  const receipts = await prisma.inboundReceipt.findMany({
    where: { sourceCluster, instanceScope },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      messageId: true,
      classification: true,
      payloadHash: true,
      collisionHash: true,
      contactScope: true,
    },
  });
  const manifest: TombstoneManifest = {
    schemaVersion: 1,
    sourceCluster,
    sourceScope: instanceScope,
    exportedAt: new Date().toISOString(),
    tombstones: receipts,
  };
  const fd = openSync(options.output!, 'wx', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  } finally {
    closeSync(fd);
  }
  console.log(JSON.stringify({ mode: 'export', count: receipts.length, output: options.output }));
}

export function readManifest(input: string): TombstoneManifest {
  const manifest = JSON.parse(readFileSync(input, 'utf8')) as TombstoneManifest;
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.tombstones))
    throw new Error('Invalid tombstone manifest');
  for (const row of manifest.tombstones) {
    if (!row.messageId || !/^[0-9a-f]{64}$/.test(row.payloadHash) || !row.contactScope) {
      throw new Error('Invalid tombstone row');
    }
  }
  return manifest;
}

export async function importTombstones(prisma: PrismaClient, options: Options): Promise<void> {
  const manifest = readManifest(options.input!);
  const targetCluster = assertSafeName(options.targetCluster!, 'target-cluster');
  const targetScope = normalizeInstanceScope(assertSafeName(options.targetScope!, 'target-scope'));
  const rows = manifest.tombstones.map((row) => ({
    sourceCluster: targetCluster,
    instanceScope: targetScope,
    contactScope: normalizeContactScope(row.contactScope),
    messageId: row.messageId,
    classification: row.classification,
    payloadHash: row.payloadHash,
    collisionHash: row.collisionHash,
    state: 'historical_seen',
    webhookState: 'skipped',
    chatwootState: 'skipped',
    chatbotState: 'skipped',
  }));
  let inserted = 0;
  if (options.live && rows.length > 0) {
    inserted = (await prisma.inboundReceipt.createMany({ data: rows, skipDuplicates: true })).count;
  }
  console.log(
    JSON.stringify({
      mode: options.live ? 'live' : 'dry-run',
      sourceCluster: manifest.sourceCluster,
      sourceScope: manifest.sourceScope,
      targetCluster,
      targetScope,
      candidates: rows.length,
      inserted,
    }),
  );
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  try {
    await prisma.$connect();
    if (options.command === 'backfill') await backfill(prisma, options);
    else if (options.command === 'export') await exportTombstones(prisma, options);
    else await importTombstones(prisma, options);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
