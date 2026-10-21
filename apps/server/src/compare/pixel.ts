import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import type { Region } from '@izaro/shared';

export interface PixelDiff {
  /** Fraction of pixels that differ, 0..1. 1 when sizes differ. */
  ratio: number;
  sizeMismatch: boolean;
  diffPng?: Buffer;
  /** Bounding box of differing pixels, as fractions of the image. */
  region?: Region;
}

export function pixelDiff(baseline: Buffer, candidate: Buffer): PixelDiff {
  const a = PNG.sync.read(baseline);
  const b = PNG.sync.read(candidate);
  if (a.width !== b.width || a.height !== b.height) return { ratio: 1, sizeMismatch: true };

  const { width, height } = a;
  const diff = new PNG({ width, height });
  const count = pixelmatch(a.data, b.data, diff.data, width, height, { threshold: 0.1, includeAA: false });

  let region: Region | undefined;
  if (count > 0) {
    let minX = width, minY = height, maxX = 0, maxY = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        // pixelmatch paints differing pixels red (255, 0, 0).
        if (diff.data[i] === 255 && diff.data[i + 1] === 0 && diff.data[i + 2] === 0) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX >= minX) region = { top: minY / height, bottom: (maxY + 1) / height, left: minX / width, right: (maxX + 1) / width };
  }

  return { ratio: count / (width * height), sizeMismatch: false, diffPng: PNG.sync.write(diff), region };
}
