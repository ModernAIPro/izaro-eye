import type { Classification, JevLabel, StepStatus } from '@izaro/shared';

export type Verdict = Extract<StepStatus, 'passed' | 'failed' | 'review'>;

export const DEFAULT_POLICY: Record<JevLabel, Verdict> = {
  identical: 'passed',
  noise: 'passed',
  cosmetic_change: 'review',
  content_change: 'review',
  layout_regression: 'failed',
  missing_element: 'failed',
  error_page: 'failed',
};

/** Below this confidence a verdict is never automatic. */
export const MIN_CONFIDENCE = 0.7;

export function verdictFor(c: Classification, policy = DEFAULT_POLICY): Verdict {
  const v = policy[c.label];
  if (c.source === 'pixel') return v;
  if (c.confidence < MIN_CONFIDENCE) return 'review';
  return v;
}
