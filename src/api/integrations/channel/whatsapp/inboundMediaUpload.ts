import { MessageSubtype } from '@api/types/wa.types';

type MediaUploadContext = { instance: string; messageId: string };

const MEDIA_WRAPPERS = [
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'ephemeralMessage',
] as const;

/**
 * Unwraps the inbound media envelope (view-once/ephemeral) for guard checks.
 * Baileys delivers such media as `{ viewOnceMessageV2: { message: { videoMessage } } }`,
 * so the top-level `isMedia`/`isVideo` guards miss it and skip the S3 block entirely
 * (MAR-414). The persisted shape is left untouched; only detection uses the inner content.
 */
export function unwrapInboundMediaContent(message: any): any {
  let content = message;
  for (let i = 0; i < 5 && content; i++) {
    const inner = MEDIA_WRAPPERS.map((wrapper) => content?.[wrapper]?.message).find(Boolean);
    if (!inner) break;
    content = inner;
  }
  return content;
}

/**
 * Own-key copy of a received message for `getBase64FromMediaMessage`. Its
 * `'messageContextInfo' in msg.message` guard is true through the prototype of a
 * raw Baileys protobuf, so media without its own `messageContextInfo` (whatsmeow
 * clients, or the inner message of a wrapper such as `documentWithCaptionMessage`)
 * was dropped before the S3 upload (MAR-304). The send path already passes a plain
 * object built by `prepareMessage`, so the shared guard stays unchanged. `received`
 * itself is not mutated; media fields are shared by reference, as in the Chatwoot path.
 */
export function ownKeyMediaMessage<T extends { message?: any }>(received: T): T {
  const copy = (message: any) => {
    if (!message) return message;
    const own = { ...message };
    for (const subtype of MessageSubtype) {
      if (own[subtype]?.message) own[subtype] = { ...own[subtype], message: copy(own[subtype].message) };
    }
    return own;
  };
  return { ...received, message: copy(received.message) };
}
type MediaUploadLogger = { warn: (message: string) => void };

/** Keep media failures visible without logging message bodies, URLs, or media keys. */
export async function runInboundMediaUpload<TMedia, TUpload>(
  context: MediaUploadContext,
  logger: MediaUploadLogger,
  operations: {
    download: () => Promise<TMedia | null | undefined>;
    upload: (media: TMedia) => Promise<TUpload | Error>;
    createMedia: (media: TMedia, uploaded: TUpload) => Promise<unknown>;
    updateMessage: (media: TMedia, uploaded: TUpload) => Promise<void>;
  },
): Promise<boolean> {
  let stage = 'download';
  try {
    const media = await operations.download();
    if (!media) {
      logger.warn(JSON.stringify({ event: 'inbound_media_upload_skipped', ...context, stage, reason: 'empty_media' }));
      return false;
    }
    stage = 's3_upload';
    const uploaded = await operations.upload(media);
    // The S3 storage wrapper returns Error on failure instead of throwing it.
    if (uploaded instanceof Error) throw uploaded;
    stage = 'media_create';
    await operations.createMedia(media, uploaded);
    stage = 'message_update';
    await operations.updateMessage(media, uploaded);
    return true;
  } catch (error) {
    logger.warn(
      JSON.stringify({
        event: 'inbound_media_upload_failed',
        ...context,
        stage,
        errorType: error instanceof Error ? error.name : typeof error,
      }),
    );
    return false;
  }
}
