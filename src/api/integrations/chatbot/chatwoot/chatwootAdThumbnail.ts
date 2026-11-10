import sharp from 'sharp';

/** Preserve the Chatwoot ad-card thumbnail contract with the shared native codec. */
export async function createChatwootAdThumbnail(input: Buffer): Promise<Buffer> {
  return sharp(input).resize({ width: 320, height: 180, fit: 'cover' }).png().toBuffer();
}
