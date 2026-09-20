import { createHash } from 'crypto';

export function buildChatwootEditSourceId(messageId: string, editedContent: string): string {
  const revision = createHash('sha256').update(editedContent, 'utf8').digest('hex');
  return `WAID:${messageId}:EDIT:${revision}`;
}
