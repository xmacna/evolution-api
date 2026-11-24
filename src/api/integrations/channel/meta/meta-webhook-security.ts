import { createHmac, timingSafeEqual } from 'crypto';

export type MetaRawRequest = {
  url?: string;
  metaRawBody?: Buffer;
};

/** express.json verify hook: keep original bytes only for the Meta callback. */
export function captureMetaRawBody(request: MetaRawRequest, response: unknown, body: Buffer) {
  void response;
  if (request.url?.split('?')[0].replace(/\/+$/, '') === '/webhook/meta') {
    request.metaRawBody = Buffer.from(body);
  }
}

export function hasCoexistenceChanges(body: any): boolean {
  const fields = ['smb_message_echoes', 'history', 'smb_app_state_sync'];
  return (
    Array.isArray(body?.entry) &&
    body.entry.some(
      (entry: any) =>
        Array.isArray(entry?.changes) &&
        entry.changes.some((change: any) => fields.includes(change?.field) || change?.value?.message_echoes !== undefined),
    )
  );
}

/** Never serialize parsed JSON here: signatures cover the exact HTTP bytes. */
export function verifyMetaSignature(body: Buffer | undefined, header: unknown, appSecret: string): boolean {
  if (!appSecret || !Buffer.isBuffer(body) || typeof header !== 'string' || !/^sha256=[a-f0-9]{64}$/i.test(header)) {
    return false;
  }
  const supplied = Buffer.from(header.slice(7), 'hex');
  const expected = createHmac('sha256', appSecret).update(body).digest();
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
