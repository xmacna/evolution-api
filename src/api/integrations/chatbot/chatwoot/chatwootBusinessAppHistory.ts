import { randomUUID } from 'crypto';
import { Pool, PoolClient } from 'pg';

import { requireBusinessAppHistoryIndex } from './business-app-history-guard';

export type ImportBinding = { accountId: number; inboxId: number; actorId: number; actorType: 'User' | 'AgentBot' };
function validateBinding(binding: ImportBinding) {
  if (
    ![binding.accountId, binding.inboxId, binding.actorId].every((value) => Number.isSafeInteger(value) && value > 0) ||
    !['User', 'AgentBot'].includes(binding.actorType)
  )
    throw new Error('Historical Portal binding invalid');
}
type HistoricalMessage = {
  id: string;
  phone: string;
  fromMe: boolean;
  timestamp: number;
  content: string;
  mediaPlaceholder?: boolean;
  mediaId?: string;
};

async function contactId(client: PoolClient, binding: ImportBinding, phone: string, timestamp: number, name?: string) {
  const identifier = `${phone}@s.whatsapp.net`;
  const existing = await client.query(
    `SELECT id FROM contacts WHERE account_id = $1 AND (identifier = $2 OR phone_number = $3)
     ORDER BY CASE WHEN identifier = $2 THEN 0 ELSE 1 END, id LIMIT 1`,
    [binding.accountId, identifier, `+${phone}`],
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const created = await client.query(
    `INSERT INTO contacts (account_id, identifier, phone_number, name, created_at, updated_at)
     VALUES ($1, $2, $3, $4, (to_timestamp($5) AT TIME ZONE 'UTC'), (to_timestamp($5) AT TIME ZONE 'UTC'))
     ON CONFLICT (identifier, account_id) DO UPDATE SET identifier = EXCLUDED.identifier RETURNING id`,
    [binding.accountId, identifier, `+${phone}`, name || phone, timestamp],
  );
  return created.rows[0].id;
}

async function existingMessage(client: Pool | PoolClient, binding: ImportBinding, message: HistoricalMessage) {
  const result = await client.query(
    `SELECT m.id, m.inbox_id, m.conversation_id AS conversation_record_id,
       c.display_id AS conversation_display_id, c.display_id AS conversation_id,
       m.content_attributes, ct.identifier, ct.phone_number
     FROM messages m JOIN conversations c ON c.id = m.conversation_id
       AND c.account_id = m.account_id AND c.inbox_id = m.inbox_id
     JOIN contacts ct ON ct.id = c.contact_id AND ct.account_id = c.account_id
     WHERE m.account_id = $1 AND m.inbox_id = $2 AND m.source_id = $3`,
    [binding.accountId, binding.inboxId, `WAID:${message.id}`],
  );
  if (result.rows.length > 1) throw new Error('Historical Portal source identity ambiguous');
  const found = result.rows[0];
  if (found && found.identifier !== `${message.phone}@s.whatsapp.net` && found.phone_number !== `+${message.phone}`)
    throw new Error('Historical Portal recipient mismatch');
  return found;
}

/** Direct import, matching the existing history approach: no Rails/API callbacks, bot or send sink. */
export async function importBusinessAppHistoryMessage(
  pool: Pool,
  binding: ImportBinding,
  message: HistoricalMessage,
  fence: (database?: PoolClient) => Promise<void> = async () => {},
) {
  validateBinding(binding);
  if (!/^\d{5,15}$/.test(message.phone) || !message.id || !Number.isSafeInteger(message.timestamp)) {
    throw new Error('Historical message identity invalid');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await requireBusinessAppHistoryIndex(client);
    await fence(client);
    const sourceId = `WAID:${message.id}`;
    // Serialize this history importer across replicas. Live/API writers are a
    // separate boundary; reconciliation also uses their existing source IDs.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `${binding.accountId}:${binding.inboxId}:${sourceId}`,
    ]);
    const found = await existingMessage(client, binding, message);
    if (found) {
      // A later media webhook may enrich an imported placeholder. It must not
      // overwrite a live/echo message or change conversation activity/state.
      if (message.mediaId && found.content_attributes?.business_app_history_placeholder === true) {
        await fence(client);
        await client.query(
          `UPDATE messages SET content = $1, processed_message_content = $1,
             content_attributes = content_attributes::jsonb || $2::jsonb WHERE id = $3`,
          [message.content, JSON.stringify({ business_app_media_id: message.mediaId }), found.id],
        );
      }
      await client.query('COMMIT');
      return found;
    }
    // The second lock covers a contact shared by separate history message IDs.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `${binding.accountId}:${binding.inboxId}:phone:${message.phone}`,
    ]);
    const contact = await contactId(client, binding, message.phone, message.timestamp);
    let contactInbox = (
      await client.query('SELECT id FROM contact_inboxes WHERE contact_id = $1 AND inbox_id = $2 ORDER BY id LIMIT 1', [
        contact,
        binding.inboxId,
      ])
    ).rows[0]?.id;
    if (!contactInbox) {
      contactInbox = (
        await client.query(
          `INSERT INTO contact_inboxes (contact_id, inbox_id, source_id, created_at, updated_at)
         VALUES ($1, $2, $3, (to_timestamp($4) AT TIME ZONE 'UTC'), (to_timestamp($4) AT TIME ZONE 'UTC')) RETURNING id`,
          [contact, binding.inboxId, randomUUID(), message.timestamp],
        )
      ).rows[0].id;
    }
    let conversation = (
      await client.query(
        `SELECT id FROM conversations WHERE account_id = $1 AND inbox_id = $2 AND contact_id = $3
       ORDER BY created_at DESC, id DESC LIMIT 1`,
        [binding.accountId, binding.inboxId, contact],
      )
    ).rows[0]?.id;
    if (!conversation) {
      conversation = (
        await client.query(
          `INSERT INTO conversations (account_id, inbox_id, contact_id, contact_inbox_id, status, uuid,
           last_activity_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 1, $5, (to_timestamp($6) AT TIME ZONE 'UTC'), (to_timestamp($6) AT TIME ZONE 'UTC'), (to_timestamp($6) AT TIME ZONE 'UTC')) RETURNING id`,
          [binding.accountId, binding.inboxId, contact, contactInbox, randomUUID(), message.timestamp],
        )
      ).rows[0].id;
    }
    await fence(client);
    await client.query(
      `INSERT INTO messages (account_id, inbox_id, conversation_id, message_type, private, content_type,
         sender_type, sender_id, source_id, content, processed_message_content, content_attributes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, FALSE, 0, $5, $6, $7, $8, $8, $9::jsonb, (to_timestamp($10) AT TIME ZONE 'UTC'), (to_timestamp($10) AT TIME ZONE 'UTC'))
       RETURNING id, inbox_id, conversation_id`,
      [
        binding.accountId,
        binding.inboxId,
        conversation,
        message.fromMe ? 1 : 0,
        message.fromMe ? binding.actorType : 'Contact',
        message.fromMe ? binding.actorId : contact,
        sourceId,
        message.content,
        JSON.stringify({
          business_app_history: true,
          business_app_history_placeholder: !!message.mediaPlaceholder,
          ...(message.mediaId ? { business_app_media_id: message.mediaId } : {}),
        }),
        message.timestamp,
      ],
    );
    await fence(client);
    await client.query('COMMIT');
    return await existingMessage(client, binding, message);
  } catch (error) {
    await client.query('ROLLBACK');
    if (error?.code === '23505' && error?.constraint === 'index_messages_on_coexistence_waid_unique') {
      const reconciled = await existingMessage(client, binding, message);
      if (reconciled) return reconciled;
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Address-book sync does not remove contacts that own conversation history. */
export async function importBusinessAppContact(
  pool: Pool,
  binding: ImportBinding,
  data: {
    phone: string;
    fullName?: string;
    timestamp: number;
    action: string;
  },
  fence: (database?: PoolClient) => Promise<void> = async () => {},
) {
  validateBinding(binding);
  if (!['add', 'remove'].includes(data.action) || !/^\d{5,15}$/.test(data.phone))
    throw new Error('Historical contact identity invalid');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `${binding.accountId}:contact:${data.phone}`,
    ]);
    const previous = (
      await client.query(
        'SELECT id FROM contacts WHERE account_id=$1 AND (identifier=$2 OR phone_number=$3) ORDER BY id LIMIT 1',
        [binding.accountId, `${data.phone}@s.whatsapp.net`, `+${data.phone}`],
      )
    ).rows[0];
    if (data.action === 'remove' && !previous) {
      await client.query('COMMIT');
      return;
    }
    const id = previous?.id || (await contactId(client, binding, data.phone, data.timestamp, data.fullName));
    const current =
      (
        await client.query('SELECT custom_attributes FROM contacts WHERE id=$1 AND account_id=$2', [
          id,
          binding.accountId,
        ])
      ).rows[0]?.custom_attributes || {};
    await fence(client);
    const priorTimestamp = Number(current.business_app_contact_sync_timestamp ?? -1);
    if (
      data.timestamp > priorTimestamp ||
      (data.timestamp === priorTimestamp && current.business_app_contact_sync_action !== 'remove')
    ) {
      await client.query(
        `UPDATE contacts SET name=CASE WHEN $1='add' AND $2::text IS NOT NULL THEN $2 ELSE name END,
        custom_attributes=COALESCE(custom_attributes::jsonb,'{}'::jsonb) || $3::jsonb WHERE id=$4 AND account_id=$5`,
        [
          data.action,
          data.fullName || null,
          JSON.stringify({
            business_app_contact_sync_timestamp: data.timestamp,
            business_app_contact_sync_action: data.action,
          }),
          id,
          binding.accountId,
        ],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
