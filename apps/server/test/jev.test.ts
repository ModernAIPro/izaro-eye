import { describe, expect, it, vi } from 'vitest';
import { PNG } from 'pngjs';
import { JEV_LABELS } from '@izaro/shared';
import { parseJevResponse, TypeSafeJevClassifier } from '../src/compare/jev.js';
import { verdictFor } from '../src/compare/policy.js';
import { pixelDiff } from '../src/compare/pixel.js';

const solid = (w: number, h: number, rgb: [number, number, number], patch?: { x: number; y: number; size: number }) => {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const inPatch = patch && x >= patch.x && x < patch.x + patch.size && y >= patch.y && y < patch.y + patch.size;
      png.data.set(inPatch ? [0, 0, 0, 255] : [...rgb, 255], i);
    }
  return PNG.sync.write(png);
};

const input = { baseline: Buffer.alloc(0), candidate: Buffer.alloc(0), diffRatio: 0.1, context: { stepLabel: 'click Save' } };

describe('pixelDiff', () => {
  it('reports identical images as zero difference', () => {
    const a = solid(50, 40, [255, 255, 255]);
    expect(pixelDiff(a, a).ratio).toBe(0);
  });
  it('finds the changed region', () => {
    const d = pixelDiff(solid(100, 100, [255, 255, 255]), solid(100, 100, [255, 255, 255], { x: 10, y: 20, size: 10 }));
    expect(d.ratio).toBeCloseTo(0.01);
    expect(d.region).toEqual({ top: 0.2, bottom: 0.3, left: 0.1, right: 0.2 });
  });
  it('treats a size change as a full difference', () => {
    expect(pixelDiff(solid(10, 10, [0, 0, 0]), solid(10, 12, [0, 0, 0])).sizeMismatch).toBe(true);
  });
});

describe('parseJevResponse', () => {
  it('prefers a confident error answer', () => {
    const c = parseJevResponse({ answers: { error: { type: 'noul', noul: 0.93 }, same: { type: 'noul', noul: 0.1 } } }, input);
    expect(c.label).toBe('error_page');
    expect(verdictFor(c)).toBe('failed');
  });
  it('uses the category with the box region', () => {
    const box = { top: 0.1, bottom: 0.4, left: 0.2, right: 0.6 };
    const c = parseJevResponse(
      { answers: { same: { noul: 0.05 }, error: { noul: 0.02 }, category: { type: 'choice', choice: 'layout_regression' }, changed: { type: 'box', box } } },
      input,
    );
    expect(c).toMatchObject({ label: 'layout_regression', region: box, source: 'jev-img' });
    expect(c.confidence).toBeCloseTo(0.95);
  });
  it('uses the category confidence the API returns', () => {
    const c = parseJevResponse(
      {
        answers: {
          same: { type: 'noul', noul: 0.02 },
          category: { type: 'choice', choice: 'content_change', confidence: 0.81, probabilities: { content_change: 0.81, noise: 0.19 } },
        },
      },
      input,
    );
    expect(c).toMatchObject({ label: 'content_change', confidence: 0.81 });
  });
  it('falls back when the category is refused', () => {
    expect(parseJevResponse({ answers: { same: { noul: 0.7 } } }, input).label).toBe('noise');
  });
  it('throws when nothing usable came back', () => {
    expect(() => parseJevResponse({ answers: {} }, input)).toThrow();
  });
});

describe('TypeSafeJevClassifier', () => {
  it('sends both images with the image opt-in header', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ answers: { same: { noul: 0.97 } } }), { status: 200 }));
    const jev = new TypeSafeJevClassifier({ apiKey: 'k', url: 'https://example.test/v1/systemone', model: 'jev-1.14.0' }, fetchImpl as typeof fetch);
    const img = solid(400, 300, [255, 255, 255]);
    const c = await jev.classify({ ...input, baseline: img, candidate: img });
    expect(c.label).toBe('identical');
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['TypeSafe-Danger-Zone-Images']).toBe('true');
    const body = JSON.parse(init.body as string);
    expect(Object.keys(body.assets)).toEqual(['baseline', 'rerun']);
    expect(body.questions.changed.type).toBe('box');
    expect(Object.keys(body.questions.category.criteria)).toEqual([...JEV_LABELS]);
  });
});
