import { Pool, PoolClient } from 'pg';

type Queryable = Pick<Pool | PoolClient, 'query'>;
const INDEX = 'index_messages_on_coexistence_waid_unique';

/** Read-only readiness guard. The manual Portal SQL is never applied here. */
export async function inspectBusinessAppHistoryIndex(database: Queryable, countDuplicates = false) {
  const result = await database.query(
    `SELECT i.indisunique AS unique, i.indisvalid AS valid, i.indisready AS ready,
       i.indnkeyatts AS key_count, i.indnatts AS column_count,
       pg_get_expr(i.indpred, i.indrelid) AS predicate,
       ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
         WHERE k.ord <= i.indnkeyatts ORDER BY k.ord) AS columns
     FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
     WHERE i.indrelid = 'messages'::regclass AND c.relname = $1`,
    [INDEX],
  );
  const index = result.rows[0];
  const predicate = index?.predicate?.replace(/::text|[()\s]/g, '');
  const ready = !!(
    index?.unique &&
    index.valid &&
    index.ready &&
    index.key_count === 3 &&
    index.column_count === 3 &&
    JSON.stringify(index.columns) === JSON.stringify(['account_id', 'inbox_id', 'source_id']) &&
    predicate === "source_id~~'WAID:%'"
  );
  let duplicateGroups: number | undefined;
  if (countDuplicates) {
    const duplicates = await database.query(
      `SELECT COUNT(*)::int AS count FROM (SELECT 1 FROM messages WHERE source_id LIKE 'WAID:%'
       GROUP BY account_id, inbox_id, source_id HAVING COUNT(*) > 1) duplicates`,
    );
    duplicateGroups = duplicates.rows[0].count;
  }
  return {
    ready,
    reason: ready ? null : 'portal_waid_unique_index_unavailable',
    index: { name: INDEX, present: !!index, unique: !!index?.unique, valid: !!index?.valid, ready: !!index?.ready },
    ...(countDuplicates ? { duplicateGroups } : {}),
  };
}

export async function requireBusinessAppHistoryIndex(database: Queryable) {
  if (!(await inspectBusinessAppHistoryIndex(database)).ready) throw new Error('Portal WAID unique index unavailable');
}
