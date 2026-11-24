// Uses an already installed Prisma engine. No download, database connection or write.
const fs = require('node:fs');
const cp = require('node:child_process');
const readline = require('node:readline');
const engine = process.env.PRISMA_SCHEMA_ENGINE_BINARY;
if (!engine) throw new Error('Set PRISMA_SCHEMA_ENGINE_BINARY to an existing schema-engine executable');
(async () => {
  for (const provider of ['postgresql', 'mysql'])
    await new Promise((resolve, reject) => {
      const path = `prisma/${provider}-schema.prisma`;
      const from = cp.execFileSync('git', ['show', `${process.env.META_SYNC_DIFF_BASE || 'origin/main'}:${path}`], {
        encoding: 'utf8',
      });
      const child = cp.spawn(engine, [], {
        env: {
          ...process.env,
          DATABASE_CONNECTION_URI:
            provider === 'postgresql'
              ? 'postgresql://synthetic:synthetic@127.0.0.1:1/synthetic'
              : 'mysql://synthetic:synthetic@127.0.0.1:1/synthetic',
        },
      });
      child.stderr.on('data', (data) => process.stderr.write(data));
      child.on('error', reject);
      readline.createInterface({ input: child.stdout }).on('line', (line) => {
        const data = JSON.parse(line);
        if (data.method) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: data.id, result: {} }) + '\n');
        else if (data.id === 1) {
          child.stdin.end();
          child.kill();
          if (data.error) reject(new Error(JSON.stringify(data.error)));
          else {
            console.log(`${provider}: datamodel validation/diff passed (no database target)`);
            resolve();
          }
        }
      });
      child.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'diff',
          params: {
            filters: { externalTables: [], externalEnums: [] },
            from: { tag: 'schemaDatamodel', files: [{ path, content: from }] },
            to: { tag: 'schemaDatamodel', files: [{ path, content: fs.readFileSync(path, 'utf8') }] },
            script: true,
          },
        }) + '\n',
      );
    });
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
