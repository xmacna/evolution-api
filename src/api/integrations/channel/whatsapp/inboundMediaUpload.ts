type MediaUploadContext = { instance: string; messageId: string };
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
