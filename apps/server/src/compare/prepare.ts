import sharp from 'sharp';

// Jev accepts PNG/JPEG between 280 and 1568 px per side and does not resize,
// so screenshots are fitted into that box before upload.
export const JEV_MIN_SIDE = 280;
export const JEV_MAX_SIDE = 1568;

export async function fitForJev(png: Buffer): Promise<Buffer> {
  const img = sharp(png).rotate();
  const { width = 0, height = 0 } = await img.metadata();
  let w = width, h = height;
  const down = Math.min(1, JEV_MAX_SIDE / Math.max(w, h));
  w = Math.round(w * down);
  h = Math.round(h * down);
  if (Math.min(w, h) < JEV_MIN_SIDE) {
    // Small element screenshots: pad onto a white canvas instead of upscaling.
    const padW = Math.max(0, JEV_MIN_SIDE - w), padH = Math.max(0, JEV_MIN_SIDE - h);
    return img
      .resize(w, h)
      .extend({ top: Math.floor(padH / 2), bottom: Math.ceil(padH / 2), left: Math.floor(padW / 2), right: Math.ceil(padW / 2), background: '#ffffff' })
      .png()
      .toBuffer();
  }
  return img.resize(w, h).png().toBuffer();
}
