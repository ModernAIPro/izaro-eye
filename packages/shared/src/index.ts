// Types shared by the server and the web UI.

export interface Viewport {
  width: number;
  height: number;
}

/** Login performed before every recording and replay. Values may use {{env:NAME}}. */
export interface ProjectAuth {
  loginUrl: string;
  usernameSelector: string;
  passwordSelector: string;
  submitSelector: string;
  username: string;
  password: string;
  /** Selector that must be visible once login has succeeded. */
  successSelector?: string;
}

export interface Project {
  id: string;
  name: string;
  baseUrl: string;
  viewport: Viewport;
  auth?: ProjectAuth;
  createdAt: string;
}

export type ActionType = 'navigate' | 'click' | 'fill' | 'select' | 'press' | 'check' | 'uncheck' | 'assert';

export type Assertion =
  | { kind: 'visible' }
  | { kind: 'text'; op: 'equals' | 'contains'; expected: string }
  | { kind: 'value'; expected: string }
  | { kind: 'url'; pattern: string }
  | { kind: 'visual' };

export type ScreenshotMode = 'viewport' | 'element' | 'none';

export interface Step {
  id: string;
  action: ActionType;
  /** Candidate locators, best first. Replay tries them in order. */
  selectors: string[];
  value?: string;
  /** True when value is a secret placeholder (e.g. a password field). */
  secret?: boolean;
  url?: string;
  assertion?: Assertion;
  screenshot: ScreenshotMode;
  /** Selectors whose regions are masked before comparison. */
  masks?: string[];
  label: string;
}

export interface TestCase {
  id: string;
  projectId: string;
  name: string;
  steps: Step[];
  baselineId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Baseline {
  id: string;
  testId: string;
  version: number;
  runId: string;
  createdAt: string;
}

export type RunMode = 'baseline' | 'check';
export type RunStatus = 'queued' | 'running' | 'passed' | 'failed' | 'review' | 'error';

export interface Run {
  id: string;
  testId: string;
  mode: RunMode;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

/** Labels jev-img can assign to a baseline/rerun pair. */
export const JEV_LABELS = [
  'identical',
  'cosmetic_change',
  'content_change',
  'layout_regression',
  'missing_element',
  'error_page',
  'noise',
] as const;
export type JevLabel = (typeof JEV_LABELS)[number];

export interface Region {
  /** Fractions of image size, origin top-left. */
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface Classification {
  label: JevLabel;
  confidence: number;
  region?: Region;
  source: 'pixel' | 'jev-img' | 'heuristic';
  notes?: string;
}

export type StepStatus = 'passed' | 'failed' | 'review' | 'error' | 'skipped';
export type ReviewDecision = 'accepted' | 'bug';

export interface StepResult {
  id: string;
  runId: string;
  stepId: string;
  index: number;
  status: StepStatus;
  error?: string;
  healedSelector?: string;
  imageKey?: string;
  baselineImageKey?: string;
  diffImageKey?: string;
  diffRatio?: number;
  classification?: Classification;
  decision?: ReviewDecision;
}

// ---- Recorder WebSocket protocol ----

export type RecorderClientMessage =
  | { type: 'mouse'; event: 'down' | 'up' | 'move'; x: number; y: number; button?: 'left' | 'right' | 'middle' }
  | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  | { type: 'key'; event: 'down' | 'up'; key: string }
  | { type: 'navigate'; url: string }
  | { type: 'inspect'; x: number; y: number }
  | { type: 'assert'; selectors: string[]; assertion: Assertion }
  | { type: 'deleteStep'; stepId: string };

export interface InspectedElement {
  selectors: string[];
  tag: string;
  text: string;
  value?: string;
  box: { x: number; y: number; width: number; height: number };
}

export type RecorderServerMessage =
  | { type: 'frame'; data: string; width: number; height: number }
  | { type: 'steps'; steps: Step[] }
  | { type: 'url'; url: string }
  | { type: 'inspected'; element: InspectedElement | null }
  | { type: 'error'; message: string };
