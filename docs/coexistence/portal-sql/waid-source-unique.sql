-- MANUAL PORTAL DATABASE CHANGE. Never applied by Evolution/Prisma or this task.
-- The Portal owner must review the read-only preflight, snapshot/rollback plan
-- and duplicate counts before the separately authorized production change.
-- Existing duplicates require reviewed reconciliation; this file deletes none.
-- Run outside a transaction. An absent/invalid/different index blocks readiness.
CREATE UNIQUE INDEX CONCURRENTLY index_messages_on_coexistence_waid_unique
ON messages (account_id, inbox_id, source_id)
WHERE source_id LIKE 'WAID:%';
