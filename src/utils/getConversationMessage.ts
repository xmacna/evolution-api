import { configService, S3 } from '@config/env.config';

const getTypeMessage = (msg: any) => {
  let mediaId: string;

  if (
    configService.get<S3>('S3').ENABLE &&
    (configService.get<S3>('S3').SAVE_VIDEO ||
      (msg?.message?.videoMessage === undefined &&
        msg?.message?.viewOnceMessageV2?.message?.videoMessage === undefined))
  )
    mediaId = msg.message?.mediaUrl;
  else mediaId = msg.key?.id;

  const mediaReference = (type: string) => `${type}|${mediaId || 'media_unavailable'}`;

  const types = {
    conversation: msg?.message?.conversation,
    extendedTextMessage: msg?.message?.extendedTextMessage?.text,
    contactMessage: msg?.message?.contactMessage?.displayName,
    locationMessage: msg?.message?.locationMessage?.degreesLatitude.toString(),
    viewOnceMessageV2:
      msg?.message?.viewOnceMessageV2?.message?.imageMessage?.url ||
      msg?.message?.viewOnceMessageV2?.message?.videoMessage?.url ||
      msg?.message?.viewOnceMessageV2?.message?.audioMessage?.url,
    listResponseMessage: msg?.message?.listResponseMessage?.title || msg?.listResponseMessage?.title,
    responseRowId: msg?.message?.listResponseMessage?.singleSelectReply?.selectedRowId,
    templateButtonReplyMessage:
      msg?.message?.templateButtonReplyMessage?.selectedId || msg?.message?.buttonsResponseMessage?.selectedButtonId,
    // Medias
    audioMessage: msg?.message?.speechToText
      ? msg?.message?.speechToText
      : msg?.message?.audioMessage
        ? mediaReference('audioMessage')
        : undefined,
    imageMessage: msg?.message?.imageMessage
      ? `${mediaReference('imageMessage')}${msg?.message?.imageMessage?.caption ? `|${msg?.message?.imageMessage?.caption}` : ''}`
      : undefined,
    videoMessage: msg?.message?.videoMessage
      ? `${mediaReference('videoMessage')}${msg?.message?.videoMessage?.caption ? `|${msg?.message?.videoMessage?.caption}` : ''}`
      : undefined,
    documentMessage: msg?.message?.documentMessage
      ? `${mediaReference('documentMessage')}${
          msg?.message?.documentMessage?.caption ? `|${msg?.message?.documentMessage?.caption}` : ''
        }`
      : undefined,
    documentWithCaptionMessage: msg?.message?.documentWithCaptionMessage?.message?.documentMessage
      ? `${mediaReference('documentWithCaptionMessage')}${
          msg?.message?.documentWithCaptionMessage?.message?.documentMessage?.caption
            ? `|${msg?.message?.documentWithCaptionMessage?.message?.documentMessage?.caption}`
            : ''
        }`
      : undefined,
    externalAdReplyBody: msg?.contextInfo?.externalAdReply?.body
      ? `externalAdReplyBody|${msg.contextInfo.externalAdReply.body}`
      : undefined,
  };

  const messageType = Object.keys(types).find((key) => types[key] !== undefined) || 'unknown';

  return { ...types, messageType };
};

const getMessageContent = (types: any) => {
  const typeKey = Object.keys(types).find((key) => key !== 'externalAdReplyBody' && types[key] !== undefined);

  let result = typeKey ? types[typeKey] : undefined;

  if (types.externalAdReplyBody) {
    result = result ? `${result}\n${types.externalAdReplyBody}` : types.externalAdReplyBody;
  }

  return result;
};

export const getConversationMessage = (msg: any) => {
  const types = getTypeMessage(msg);

  const messageContent = getMessageContent(types);

  return messageContent;
};
