-- READ ONLY. Run by the Portal owner against the intended database/schema.
-- Emits only counts and index metadata; never source_id/contact/message content.
SELECT COUNT(*) AS duplicate_groups FROM (
  SELECT 1 FROM messages WHERE source_id LIKE 'WAID:%'
  GROUP BY account_id, inbox_id, source_id HAVING COUNT(*) > 1
) duplicates;
SELECT c.relname AS index_name, i.indisunique, i.indisvalid, i.indisready,
  pg_get_indexdef(i.indexrelid) AS index_definition
FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
WHERE i.indrelid = 'messages'::regclass
  AND c.relname = 'index_messages_on_coexistence_waid_unique';
