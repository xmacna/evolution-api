import { normalizeMessageTimestamp } from '../chatbotDebounce';

/** Internal envelope: audio source is retained only in memory, never sent to n8n. */
export type IndividualChatbotMessage = {
  keyId?: string;
  remoteJid?: string;
  participant?: string;
  fromMe?: boolean;
  messageTimestamp?: number;
  messageType: string;
  chatInput: string;
  transcription?: string;
  audioSource?: { key: Record<string, unknown>; message: unknown };
};

export type N8nIndividualMessage = Omit<IndividualChatbotMessage, 'audioSource' | 'transcription'> & {
  providerTimestamp?: number;
  transcriptionStatus?: 'available' | 'unavailable';
};

export function captureIndividualChatbotMessage(msg: any, content: string): IndividualChatbotMessage {
  const message = msg?.message;
  const body = message?.ephemeralMessage?.message ?? message;
  const inner = body?.viewOnceMessageV2?.message ?? body?.viewOnceMessage?.message ?? body;
  const type = inner?.audioMessage
    ? 'audio'
    : inner?.imageMessage
      ? 'image'
      : inner?.videoMessage
        ? 'video'
        : inner?.documentMessage || inner?.documentWithCaptionMessage
          ? 'document'
          : inner?.contactMessage || inner?.contactsArrayMessage
            ? 'contact'
            : inner?.locationMessage || inner?.liveLocationMessage
              ? 'location'
              : 'text';
  const key = {
    id: msg?.key?.id,
    remoteJid: msg?.key?.remoteJid,
    participant: msg?.key?.participant,
    fromMe: msg?.key?.fromMe,
  };
  const transcription =
    typeof message?.speechToText === 'string' && message.speechToText.trim() ? message.speechToText : undefined;
  return {
    keyId: key.id,
    remoteJid: key.remoteJid,
    participant: key.participant,
    fromMe: key.fromMe,
    messageTimestamp: normalizeMessageTimestamp(msg?.messageTimestamp),
    messageType: type,
    chatInput: content,
    ...(type === 'audio' && transcription ? { transcription } : {}),
    ...(type === 'audio' && !transcription ? { audioSource: structuredClone({ key, message }) } : {}),
  };
}

/** Explicit projection prevents raw media keys/base64 from leaking into the webhook. */
export async function prepareN8nIndividualMessages(
  messages: IndividualChatbotMessage[],
  transcribe: (source: IndividualChatbotMessage['audioSource']) => Promise<string | null>,
): Promise<N8nIndividualMessage[]> {
  const result: N8nIndividualMessage[] = [];
  for (const item of messages) {
    let text = item.chatInput;
    let transcriptionStatus: 'available' | 'unavailable' | undefined;
    if (item.messageType === 'audio') {
      transcriptionStatus = item.transcription ? 'available' : 'unavailable';
      try {
        if (!item.transcription) {
          const transcription = item.audioSource ? await transcribe(item.audioSource) : null;
          if (typeof transcription === 'string' && transcription.trim()) {
            text = `[audio] ${transcription}`;
            transcriptionStatus = 'available';
          }
        }
      } catch {
        // Preserve this event and its original content; never borrow another audio's text.
      }
    }
    const milliseconds = item.messageTimestamp === undefined ? undefined : item.messageTimestamp * 1000;
    result.push({
      keyId: item.keyId,
      remoteJid: item.remoteJid,
      participant: item.participant,
      fromMe: item.fromMe,
      messageTimestamp: item.messageTimestamp,
      providerTimestamp: Number.isSafeInteger(milliseconds) && milliseconds > 0 ? milliseconds : undefined,
      messageType: item.messageType,
      chatInput: text,
      ...(transcriptionStatus ? { transcriptionStatus } : {}),
    });
  }
  return result;
}
