import { JEV_LABELS, type Classification, type JevLabel, type Region } from '@izaro/shared';
import { config } from '../config.js';
import { fitForJev } from './prepare.js';

export interface ClassifyInput {
  baseline: Buffer;
  candidate: Buffer;
  diffRatio: number;
  pixelRegion?: Region;
  context: { stepLabel: string; url?: string };
}

export interface ImageClassifier {
  readonly name: string;
  classify(input: ClassifyInput): Promise<Classification>;
}

const LABEL_DESCRIPTIONS: Record<JevLabel, string> = {
  identical: 'no meaningful visual difference',
  cosmetic_change: 'small styling change (colour, font, spacing) with the same content and layout',
  content_change: 'different text, numbers or images but the same layout',
  layout_regression: 'elements moved, overlap, are cut off or the layout is broken',
  missing_element: 'an element present in the baseline is missing from the rerun',
  error_page: 'the rerun shows an error page, error message or blank page',
  noise: 'differences come only from dynamic data such as dates, timers, ads or avatars',
};

/**
 * jev-img: TypeSafe Jev 1.14 visual processing (image input + Box).
 *
 * One request asks four questions about the baseline/rerun pair:
 *   same     noul   - probability that the two show the same UI state
 *   error    noul   - probability that the rerun shows an error
 *   category choice - which JEV_LABELS entry best describes the change
 *   changed  box    - where the most significant change is in the rerun
 *
 * Request/response shapes follow the published systemone examples (questions
 * and answers keyed by name, assets referenced by name inside instructions).
 * Image input and Box are beta in Jev 1.14 and need the Danger-Zone header.
 * The `choice` question body is not in the public examples; verify it against
 * docs.typesafe.ai before relying on `category`.
 */
export class TypeSafeJevClassifier implements ImageClassifier {
  readonly name = 'jev-img';

  constructor(
    private opts = config.typesafe,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  buildRequest(baseline: Buffer, candidate: Buffer, input: ClassifyInput) {
    const labels = JEV_LABELS.map((l) => `${l}: ${LABEL_DESCRIPTIONS[l]}`).join('\n');
    return {
      model: this.opts.model,
      state:
        `Visual regression check for the test step "${input.context.stepLabel}"` +
        (input.context.url ? ` on ${input.context.url}` : '') +
        '. `baseline` is the approved screenshot and `rerun` is the new screenshot of the same step.',
      assets: {
        baseline: { type: 'image', format: 'png', data_base64: baseline.toString('base64') },
        rerun: { type: 'image', format: 'png', data_base64: candidate.toString('base64') },
      },
      questions: {
        same: {
          type: 'noul',
          instructions: 'Do `baseline` and `rerun` show the same UI state, ignoring anti-aliasing and sub-pixel rendering?',
        },
        error: {
          type: 'noul',
          instructions: 'Does `rerun` show an error page, an error message, or a blank page?',
        },
        category: {
          type: 'choice',
          instructions: `Which option best describes how \`rerun\` differs from \`baseline\`?\n${labels}`,
          choices: [...JEV_LABELS],
        },
        changed: {
          type: 'box',
          instructions: 'Find the most significant region in `rerun` that differs from `baseline`.',
        },
      },
    };
  }

  async classify(input: ClassifyInput): Promise<Classification> {
    if (!this.opts.apiKey) throw new Error('TYPESAFE_API_KEY is not set');
    const [baseline, candidate] = await Promise.all([fitForJev(input.baseline), fitForJev(input.candidate)]);
    const res = await this.fetchImpl(this.opts.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
        'Content-Type': 'application/json',
        'TypeSafe-Danger-Zone-Images': 'true',
      },
      body: JSON.stringify(this.buildRequest(baseline, candidate, input)),
    });
    if (!res.ok) throw new Error(`jev-img request failed: ${res.status} ${await res.text().catch(() => '')}`);
    return parseJevResponse(await res.json(), input);
  }
}

type Answer = { type?: string; noul?: number; choice?: string; answer?: string; box?: Region; confidence?: number };

export function parseJevResponse(body: unknown, input: ClassifyInput): Classification {
  const answers = ((body as { answers?: Record<string, Answer> })?.answers ?? {}) as Record<string, Answer>;
  const same = answers.same?.noul;
  const error = answers.error?.noul;
  const picked = answers.category?.choice ?? answers.category?.answer;
  const region = answers.changed?.box ?? input.pixelRegion;

  // Strong yes/no answers override the category; refusals (missing answers)
  // fall back to whatever evidence remains.
  if (error !== undefined && error >= 0.8) return { label: 'error_page', confidence: error, region, source: 'jev-img' };
  if (same !== undefined && same >= 0.9) return { label: 'identical', confidence: same, region, source: 'jev-img' };
  if (picked && (JEV_LABELS as readonly string[]).includes(picked)) {
    const confidence = same !== undefined ? 1 - same : 0.5;
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
 * Offline stand-in used when no API key is configured (and in tests). It only
 * looks at how much changed, so anything it flags goes to human review.
 */
export class HeuristicClassifier implements ImageClassifier {
  readonly name = 'heuristic';
  async classify(input: ClassifyInput): Promise<Classification> {
    const r = input.diffRatio;
    const base = { region: input.pixelRegion, source: 'heuristic' as const };
    if (r >= 1) return { ...base, label: 'layout_regression', confidence: 0.5, notes: 'screenshot size changed' };
    if (r < 0.002) return { ...base, label: 'noise', confidence: 0.6 };
    if (r < 0.02) return { ...base, label: 'cosmetic_change', confidence: 0.5 };
    if (r < 0.15) return { ...base, label: 'content_change', confidence: 0.5 };
    return { ...base, label: 'layout_regression', confidence: 0.5 };
  }
}

export function defaultClassifier(): ImageClassifier {
  return config.typesafe.apiKey ? new TypeSafeJevClassifier() : new HeuristicClassifier();
}
