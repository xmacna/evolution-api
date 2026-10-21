import { parsePhoneNumberFromString } from 'libphonenumber-js';

export type GroupParticipantKey = {
  participant?: string | null;
  participantAlt?: string | null;
  addressingMode?: string | null;
  fromMe?: boolean | null;
};

// xmacna/elysium#961: a group message may arrive without `participant`, or with a LID that is not
// a phone number. Both used to throw inside the Chatwoot sink (`.split` / `.formatInternational`
// on undefined) and the durable inbox retried the receipt until it became `dead`.
export function resolveGroupParticipantJid(key: GroupParticipantKey): string | undefined {
  if (key.addressingMode === 'lid' && !key.fromMe && key.participantAlt) return key.participantAlt;
  return key.participant || key.participantAlt || undefined;
}

export function formatGroupParticipantLabel(key: GroupParticipantKey): string | undefined {
  const participantJid = resolveGroupParticipantJid(key);
  const identifier = participantJid?.split('@')[0]?.split(':')[0];
  if (!identifier) return undefined;
  if (participantJid.endsWith('@lid')) return identifier;

  return parsePhoneNumberFromString(`+${identifier}`)?.formatInternational() || identifier;
}

export function formatGroupParticipantHeader(key: GroupParticipantKey, participantName?: string | null): string {
  const author = [formatGroupParticipantLabel(key), participantName].filter(Boolean).join(' - ');
  return author ? `**${author}:**` : '';
}
