import type { Classification, Region } from '@izaro/shared';
import { config } from '../config.js';
import type { Vision } from './jev.js';
import { pixelDiff } from './pixel.js';

export interface Comparison {
  diffRatio: number;
  diffPng?: Buffer;
  classification: Classification;
}

/** Stage 1: pixel diff. Stage 2: jev-img, only when pixels actually changed. */
export async function compareScreenshots(
  baseline: Buffer,
  candidate: Buffer,
  classifier: Vision,
  context: { stepLabel: string; url?: string },
): Promise<Comparison> {
  const d = pixelDiff(baseline, candidate);
  if (!d.sizeMismatch && d.ratio <= config.pixelIdenticalThreshold) {
    return { diffRatio: d.ratio, diffPng: d.diffPng, classification: { label: 'identical', confidence: 1, source: 'pixel' } };
  }
  const pixelRegion: Region | undefined = d.region;
  try {
    const classification = await classifier.classify({ baseline, candidate, diffRatio: d.ratio, pixelRegion, context });
    return { diffRatio: d.ratio, diffPng: d.diffPng, classification };
  } catch (err) {
    return {
      diffRatio: d.ratio,
      diffPng: d.diffPng,
      classification: {
        label: 'content_change',
        confidence: 0,
        region: pixelRegion,
        source: 'heuristic',
        notes: `classifier failed: ${(err as Error).message}`,
      },
    };
  }
}
