import sharp from 'sharp';
import { JEV_LABELS, type Classification, type JevLabel, type Region } from '@izaro/shared';
import { config } from '../config.js';
import { pixelDiff } from './pixel.js';
import { fitForJev } from './prepare.js';

export interface ClassifyInput {
  baseline: Buffer;
  candidate: Buffer;
  diffRatio: number;
  pixelRegion?: Region;
  context: { stepLabel: string; url?: string };
}

export interface FindQuery {
  /** The quoted label from the step, e.g. "Shop individual and family plans". */
  label: string;
  /** Image of the element from the screen library, when there is one. */
  crop?: Buffer;
}

export interface FindAnswer {
  /** How sure jev-img is that the element is on screen, 0..1. */
  present: number;
  box?: Region;
  boxConfidence?: number;
}

/**
 * Everything izaro-eye needs to know about screenshots. Nothing here reads the
 * page's DOM: every answer comes from images.
 */
export interface Vision {
  readonly name: string;
  /** Classifies how `candidate` differs from `baseline`. */
  classify(input: ClassifyInput): Promise<Classification>;
  /** Finds a control on a screenshot by its label (and library image). */
  findElement(screen: Buffer, query: FindQuery): Promise<FindAnswer>;
  /** Probability that two screenshots show the same application screen. */
  sameScreen(a: Buffer, b: Buffer): Promise<number>;
  /** Probability that the text is visible on the screenshot. */
  seesText(screen: Buffer, text: string): Promise<number>;
  /** Bounds of the control under a point, used while recording. */
  elementAt(screen: Buffer, point: { x: number; y: number }): Promise<Region | null>;
}

export class VisionUnavailableError extends Error {}

const LABEL_DESCRIPTIONS: Record<JevLabel, string> = {
  identical: 'no meaningful visual difference',
  cosmetic_change: 'small styling change (colour, font, spacing) with the same content and layout',
  content_change: 'different text, numbers or images but the same layout',
  layout_regression: 'elements moved, overlap, are cut off or the layout is broken',
  missing_element: 'an element present in the baseline is missing from the rerun',
  error_page: 'the rerun shows an error page, error message or blank page',
  noise: 'differences come only from dynamic data such as dates, timers, ads or avatars',
};

const img = (png: Buffer) => ({ type: 'image', format: 'png', data_base64: png.toString('base64') });

type Answer = {
  type?: string;
  noul?: number;
  choice?: string;
  probabilities?: Record<string, number>;
  box?: Region;
  confidence?: number;
};
const answersOf = (body: unknown) => ((body as { answers?: Record<string, Answer> })?.answers ?? {}) as Record<string, Answer>;

/**
 * jev-img: TypeSafe Jev 1.14 visual processing (image input + Box).
 *
 * Shapes checked against the live systemone API: questions and answers are
 * keyed by name; assets are referenced by name in backticks; `noul` answers a
 * probability; `choice` takes `criteria` (option -> description) and answers
 * `choice` + `confidence`; `box` answers fractions of the image plus a
 * `confidence`. Box has no "not found" answer, so every Box question is paired
 * with a noul presence question. Image input and Box need the Danger-Zone header.
 */
export class JevVision implements Vision {
  readonly name = 'jev-img';

  constructor(
    private opts = config.typesafe,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private async ask(body: Record<string, unknown>): Promise<Record<string, Answer>> {
    if (!this.opts.apiKey) throw new VisionUnavailableError('TYPESAFE_API_KEY is not set');
    const res = await this.fetchImpl(this.opts.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
        'Content-Type': 'application/json',
        'TypeSafe-Danger-Zone-Images': 'true',
      },
      body: JSON.stringify({ model: this.opts.model, ...body }),
    });
    if (!res.ok) throw new Error(`jev-img request failed: ${res.status} ${await res.text().catch(() => '')}`);
    return answersOf(await res.json());
  }

  buildClassifyRequest(baseline: Buffer, candidate: Buffer, input: ClassifyInput) {
    return {
      state:
        `Visual regression check for the test step "${input.context.stepLabel}"` +
        (input.context.url ? ` on ${input.context.url}` : '') +
        '. `baseline` is the approved screenshot and `rerun` is the new screenshot of the same screen.',
      assets: { baseline: img(baseline), rerun: img(candidate) },
      questions: {
        same: {
          type: 'noul',
          instructions: 'Do `baseline` and `rerun` show the same UI state, ignoring anti-aliasing and sub-pixel rendering?',
        },
        error: { type: 'noul', instructions: 'Does `rerun` show an error page, an error message, or a blank page?' },
        category: {
          type: 'choice',
          instructions: 'Which option best describes how `rerun` differs from `baseline`?',
          criteria: Object.fromEntries(JEV_LABELS.map((l) => [l, LABEL_DESCRIPTIONS[l]])),
        },
        changed: { type: 'box', instructions: 'Find the most significant region in `rerun` that differs from `baseline`.' },
      },
    };
  }

  async classify(input: ClassifyInput): Promise<Classification> {
    const [baseline, candidate] = await Promise.all([fitForJev(input.baseline), fitForJev(input.candidate)]);
    return parseJevResponse({ answers: await this.ask(this.buildClassifyRequest(baseline, candidate, input)) }, input);
  }

  buildFindRequest(screen: Buffer, query: FindQuery, crop?: Buffer) {
    const looks = crop ? ' It looks like `target`.' : '';
    return {
      state: '`screen` is a screenshot of a web application during an automated test.',
      assets: crop ? { screen: img(screen), target: img(crop) } : { screen: img(screen) },
      questions: {
        present: { type: 'noul', instructions: `Is the "${query.label}" control visible in \`screen\`?${looks}` },
        where: { type: 'box', instructions: `Find the "${query.label}" control in \`screen\`.${looks}` },
      },
    };
  }

  async findElement(screen: Buffer, query: FindQuery): Promise<FindAnswer> {
    // Box answers are fractions of the image. Viewport screenshots are only
    // scaled to fit, never padded, so the fractions map straight back.
    const [s, c] = await Promise.all([fitForJev(screen), query.crop ? fitForJev(query.crop) : undefined]);
    const a = await this.ask(this.buildFindRequest(s, query, c));
    return { present: a.present?.noul ?? 0, box: a.where?.box, boxConfidence: a.where?.confidence };
  }

  async sameScreen(a: Buffer, b: Buffer): Promise<number> {
    const [x, y] = await Promise.all([fitForJev(a), fitForJev(b)]);
    const ans = await this.ask({
      state: '`a` and `b` are screenshots of a web application.',
      assets: { a: img(x), b: img(y) },
      questions: {
        same: {
          type: 'noul',
          instructions:
            'Do `a` and `b` show the same screen of the application (same page and layout), ignoring different data, typed values, open dropdowns and scroll position?',
        },
      },
    });
    return ans.same?.noul ?? 0;
  }

  async seesText(screen: Buffer, text: string): Promise<number> {
    const ans = await this.ask({
      state: '`screen` is a screenshot of a web application.',
      assets: { screen: img(await fitForJev(screen)) },
      questions: { visible: { type: 'noul', instructions: `Does \`screen\` show the text "${text}"?` } },
    });
    return ans.visible?.noul ?? 0;
  }

  async elementAt(screen: Buffer, point: { x: number; y: number }): Promise<Region | null> {
    const marked = await markPoint(screen, point);
    const ans = await this.ask({
      state: '`screen` is a screenshot of a web application. A red crosshair marks where the user clicked.',
      assets: { screen: img(await fitForJev(marked)) },
      questions: {
        where: {
          type: 'box',
          instructions: 'Find the button, link, input field, checkbox, menu item or other control under the red crosshair in `screen`.',
        },
      },
    });
    return ans.where?.box ?? null;
  }
}

/** Draws a crosshair so jev-img knows which control was clicked. */
async function markPoint(png: Buffer, p: { x: number; y: number }): Promise<Buffer> {
  const { width = 0, height = 0 } = await sharp(png).metadata();
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <g stroke="#ff0000" stroke-width="3"><line x1="${p.x - 14}" y1="${p.y}" x2="${p.x + 14}" y2="${p.y}"/><line x1="${p.x}" y1="${p.y - 14}" x2="${p.x}" y2="${p.y + 14}"/></g>
    <circle cx="${p.x}" cy="${p.y}" r="9" fill="none" stroke="#ff0000" stroke-width="2"/></svg>`;
  return sharp(png).composite([{ input: Buffer.from(svg) }]).png().toBuffer();
}

export function parseJevResponse(body: unknown, input: ClassifyInput): Classification {
  const answers = answersOf(body);
  const same = answers.same?.noul;
  const error = answers.error?.noul;
  const picked = answers.category?.choice;
  const region = answers.changed?.box ?? input.pixelRegion;

  // Strong yes/no answers override the category; refusals (missing answers)
  // fall back to whatever evidence remains.
  if (error !== undefined && error >= 0.8) return { label: 'error_page', confidence: error, region, source: 'jev-img' };
  if (same !== undefined && same >= 0.9) return { label: 'identical', confidence: same, region, source: 'jev-img' };
  if (picked && (JEV_LABELS as readonly string[]).includes(picked)) {
    const confidence = answers.category?.confidence ?? (same !== undefined ? 1 - same : 0.5);
    return { label: picked as JevLabel, confidence: Math.max(confidence, 0.5), region, source: 'jev-img' };
  }
  if (same !== undefined) {
    return same >= 0.5
      ? { label: 'noise', confidence: same, region, source: 'jev-img', notes: 'category not returned' }
      : { label: 'content_change', confidence: 1 - same, region, source: 'jev-img', notes: 'category not returned' };
  }
  throw new Error('jev-img returned no usable answers');
}

/**
 * Offline stand-in used when no API key is configured. It can compare pixels
 * but cannot find elements or read text, so scenarios only run while the
 * screen still matches the library exactly.
 */
export class LocalVision implements Vision {
  readonly name: string = 'local';

  async classify(input: ClassifyInput): Promise<Classification> {
    const r = input.diffRatio;
    const base = { region: input.pixelRegion, source: 'heuristic' as const };
    if (r >= 1) return { ...base, label: 'layout_regression', confidence: 0.5, notes: 'screenshot size changed' };
    if (r < 0.002) return { ...base, label: 'noise', confidence: 0.6 };
    if (r < 0.02) return { ...base, label: 'cosmetic_change', confidence: 0.5 };
    if (r < 0.15) return { ...base, label: 'content_change', confidence: 0.5 };
    return { ...base, label: 'layout_regression', confidence: 0.5 };
  }
  async findElement(_screen: Buffer, _query: FindQuery): Promise<FindAnswer> {
    throw new VisionUnavailableError('Finding elements needs jev-img (set TYPESAFE_API_KEY)');
  }
  async sameScreen(a: Buffer, b: Buffer): Promise<number> {
    const d = pixelDiff(a, b);
    return d.sizeMismatch ? 0 : Math.max(0, 1 - d.ratio * 5);
  }
  async seesText(_screen: Buffer, _text: string): Promise<number> {
    throw new VisionUnavailableError('Checking for text needs jev-img (set TYPESAFE_API_KEY)');
  }
  async elementAt(_screen: Buffer, _point: { x: number; y: number }): Promise<Region | null> {
    return null;
  }
}

export function defaultVision(): Vision {
  return config.typesafe.apiKey ? new JevVision() : new LocalVision();
}

