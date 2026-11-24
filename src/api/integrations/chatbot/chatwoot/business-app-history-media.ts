import { createHash } from 'crypto';
import { Pool, PoolClient } from 'pg';

import { requireBusinessAppHistoryIndex } from './business-app-history-guard';
import { ImportBinding } from './chatwootBusinessAppHistory';

type Media = {
  id: string;
  type: 'image' | 'audio' | 'video' | 'document' | 'sticker';
  bytes: Buffer;
  filename: string;
  mimetype: string;
  sha256?: string;
};
type Target = { id: number; conversation_record_id: number; conversation_display_id: number };
type NativeHttp = {
  post: (url: string, body: any, options: any) => Promise<any>;
  put: (url: string, body: Buffer, options: any) => Promise<any>;
};

/** Native ActiveStorage upload followed by callback-free historical attachment. */
export async function attachBusinessAppHistoryMedia(
  pool: Pool,
  binding: ImportBinding,
  provider: { url: string; token: string },
  target: Target,
  media: Media,
  http: NativeHttp,
  fence: (database?: PoolClient) => Promise<void>,
) {
  const fileTypes = { image: 0, audio: 1, video: 2, document: 3, sticker: 0 };
  const checksum = createHash('md5').update(media.bytes).digest('base64');
  if (!media.id || !media.bytes.length || !media.filename || !media.mimetype || !(media.type in fileTypes))
    throw new Error('Historical media metadata invalid');
  if (media.sha256) {
    const expected = /^[a-f\d]{64}$/i.test(media.sha256)
      ? Buffer.from(media.sha256, 'hex')
      : Buffer.from(media.sha256, 'base64');
    if (expected.length !== 32 || !createHash('sha256').update(media.bytes).digest().equals(expected))
      throw new Error('Historical media checksum mismatch');
  }
  const base = new URL(provider.url);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash)
    throw new Error('Historical media Portal URL invalid');
  const existing = async () =>
    (
      await pool.query(
        `SELECT a.id FROM attachments a JOIN active_storage_attachments f ON f.record_type = 'Attachment'
       AND f.record_id = a.id AND f.name = 'file'
     WHERE a.message_id = $1 AND a.account_id = $2 AND a.meta->>'business_app_media_id' = $3`,
        [target.id, binding.accountId, media.id],
      )
    ).rows[0];
  await fence();
  await requireBusinessAppHistoryIndex(pool);
  if (await existing()) return { attached: true, reused: true };
  let blob: any;
  try {
    const response = await http.post(
      `${base.href.replace(/\/$/, '')}/api/v1/accounts/${binding.accountId}/conversations/${target.conversation_display_id}/direct_uploads`,
      {
        blob: {
          filename: media.filename,
          byte_size: media.bytes.length,
          checksum,
          content_type: media.mimetype,
          metadata: {},
        },
      },
      { headers: { api_access_token: provider.token }, maxRedirects: 0 },
    );
    blob = response.data;
    if (
      !Number.isSafeInteger(Number(blob?.id)) ||
      Number(blob.id) < 1 ||
      Number(blob.byte_size) !== media.bytes.length ||
      blob.checksum !== checksum
    )
      throw new Error('Invalid blob');
    const storage = new URL(blob.direct_upload?.url);
    const headers = blob.direct_upload?.headers;
    if (
      storage.protocol !== 'https:' ||
      storage.username ||
      storage.password ||
      !headers ||
      typeof headers !== 'object' ||
      Array.isArray(headers)
    )
      throw new Error('Invalid storage');
    if (
      storage.href.includes(provider.token) ||
      Object.entries(headers).some(
        ([name, value]) =>
          /^(authorization|cookie|api_access_token)$/i.test(name) ||
          typeof value !== 'string' ||
          (provider.token && value.includes(provider.token)),
      )
    )
      throw new Error('Invalid storage authentication');
    await fence();
    await http.put(storage.href, media.bytes, { headers: { ...headers }, maxRedirects: 0 });
    await fence();
  } catch {
    throw new Error('Historical native media upload failed');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await requireBusinessAppHistoryIndex(client);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `history-media:${binding.accountId}:${target.id}:${media.id}`,
    ]);
    const found = (
      await client.query(
        `SELECT a.id FROM attachments a JOIN active_storage_attachments f ON f.record_type='Attachment' AND f.record_id=a.id AND f.name='file'
       WHERE a.message_id=$1 AND a.account_id=$2 AND a.meta->>'business_app_media_id'=$3`,
        [target.id, binding.accountId, media.id],
      )
    ).rows[0];
    if (!found) {
      // Internal FK and public display_id are deliberately distinct.
      const verified = await client.query(
        `SELECT m.id FROM messages m JOIN conversations c ON c.id=m.conversation_id
         WHERE m.id=$1 AND m.account_id=$2 AND m.inbox_id=$3 AND c.id=$4 AND c.display_id=$5 AND c.account_id=$2 AND c.inbox_id=$3
           AND m.content_attributes::jsonb->>'business_app_history'='true'`,
        [target.id, binding.accountId, binding.inboxId, target.conversation_record_id, target.conversation_display_id],
      );
      const stored = await client.query(
        'SELECT id FROM active_storage_blobs WHERE id=$1 AND byte_size=$2 AND checksum=$3 AND filename=$4',
        [blob.id, media.bytes.length, checksum, media.filename],
      );
      if (verified.rowCount !== 1 || stored.rowCount !== 1)
        throw new Error('Historical media attachment binding mismatch');
      await fence(client);
      const attachment = await client.query(
        `INSERT INTO attachments(account_id,message_id,file_type,extension,meta,created_at,updated_at)
         VALUES($1,$2,$3,$4,$5::jsonb,now(),now()) RETURNING id`,
        [
          binding.accountId,
          target.id,
          fileTypes[media.type],
          media.filename.split('.').pop(),
          JSON.stringify({ business_app_media_id: media.id }),
        ],
      );
      await client.query(
        `INSERT INTO active_storage_attachments(name,record_type,record_id,blob_id,created_at)
        VALUES('file','Attachment',$1,$2,now())`,
        [attachment.rows[0].id, blob.id],
      );
      await client.query(
        `UPDATE messages SET content_attributes=content_attributes::jsonb || '{"business_app_history_placeholder":false}'::jsonb WHERE id=$1`,
        [target.id],
      );
    }
    await client.query('COMMIT');
    return { attached: true, reused: !!found };
  } catch {
    await client.query('ROLLBACK');
    throw new Error('Historical media attachment failed');
  } finally {
    client.release();
  }
}
