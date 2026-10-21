// Types shared by the server and the web UI.

export * from './scenario.js';
export * from './steps.js';

export interface Viewport {
  width: number;
  height: number;
}

export interface Project {
  id: string;
  name: string;
  baseUrl: string;
  viewport: Viewport;
  /** Scenario run before every other scenario, e.g. signing in. */
  setupScenarioId?: string;
  createdAt: string;
  /** Set when the project has its own TypeSafe API key; only its last 4 characters ever leave the server. */
  typesafeKey?: { last4: string };
}

/** Pixel rectangle on a screenshot. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** An element the user interacted with on a screen, kept as an image. */
export interface ScreenElement {
  id: string;
  label: string;
  rect: Rect;
  cropKey: string;
}

/** One distinct screen of the application, captured while recording. */
export interface Screen {
  id: string;
  projectId: string;
  name: string;
  url: string;
  title: string;
  imageKey: string;
  elements: ScreenElement[];
  /** Which element led to which screen. */
  next: { elementId: string; screenId: string }[];
  createdAt: string;
  updatedAt: string;
}

/** Links a recorded step to the library so execution can use the element's image. */
export interface StepHint {
  screenId: string;
  elementId?: string;
}

export interface ScenarioStep {
  text: string;
  hint?: StepHint;
}

export interface Scenario {
  id: string;
  projectId: string;
  name: string;
  steps: ScenarioStep[];
  createdAt: string;
  updatedAt: string;
}

export type RunStatus = 'queued' | 'running' | 'passed' | 'failed' | 'review' | 'error';

export interface Run {
  id: string;
  scenarioId: string;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  /** A video of the run is available at /api/runs/:id/video. */
  hasVideo?: boolean;
}

export type LogSource = 'typesafe' | 'browser' | 'runner';
export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  at: string;
  source: LogSource;
  level: LogLevel;
  message: string;
  /** Extra detail, e.g. jev-img answers. */
  data?: unknown;
  /** Index of the step being executed, when known. */
  step?: number;
}

/** Messages on the run WebSocket. */
export type RunEvent =
  | { type: 'state'; run: Run; results: StepResult[] }
  | { type: 'frame'; data: string; width: number; height: number }
  | { type: 'logs'; entries: LogEntry[] }
  | { type: 'log'; entry: LogEntry };

/** Labels jev-img can assign to an expected/actual screen pair. */
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

/** How a step's target was found on screen. */
export interface FoundTarget {
  label: string;
  rect: Rect;
  /** jev-img's certainty the element is present (1 for an exact image match). */
  confidence: number;
  method: 'exact-match' | 'jev-img';
}

export type StepStatus = 'passed' | 'failed' | 'review' | 'error' | 'skipped';
export type ReviewDecision = 'accepted' | 'bug';

export interface StepResult {
  id: string;
  runId: string;
  index: number;
  /** Step text, with any `Run "..."` steps expanded. */
  text: string;
  /** Nesting path when the step came from a reused scenario, e.g. "Sign in". */
  from?: string;
  status: StepStatus;
  error?: string;
  imageKey?: string;
  found?: FoundTarget;
  /** Library element the step acted on, if known. */
  elementId?: string;
  /** For `Expect the "..." screen`. */
  screenId?: string;
  expectedImageKey?: string;
  diffImageKey?: string;
  diffRatio?: number;
  classification?: Classification;
  /** For `Expect to see "..."`. */
  textConfidence?: number;
  decision?: ReviewDecision;
}

// ---- Recorder WebSocket protocol ----

export type RecorderClientMessage =
  | { type: 'mouse'; event: 'down' | 'up' | 'move'; x: number; y: number; button?: 'left' | 'right' | 'middle' }
  | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  | { type: 'key'; event: 'down' | 'up'; key: string }
  | { type: 'navigate'; url: string }
  | { type: 'secret'; name: string }
  | { type: 'expectText'; text: string }
  | { type: 'setSteps'; steps: ScenarioStep[] };

export interface RecorderStep extends ScenarioStep {
  /** Crop of the element the step acts on, for the UI. */
  cropKey?: string;
}

export type RecorderServerMessage =
  | { type: 'frame'; data: string; width: number; height: number }
  | { type: 'steps'; steps: RecorderStep[] }
  | { type: 'url'; url: string }
  | { type: 'busy'; busy: boolean }
  | { type: 'error'; message: string };

// ---- Test results insights ----

/** One scenario in an insights list, pointing at the run the item is about. */
export interface InsightItem {
  scenarioId: string;
  name: string;
  runId?: string;
  status?: RunStatus;
  /** Milliseconds, for the run pointed at. */
  durationMs?: number;
  /** A short reason, e.g. "failed after passing" or "3 flips in 10 runs". */
  note?: string;
}

/** Failed steps across the latest runs that share the same cause. */
export interface FailureCluster {
  error: string;
  count: number;
  items: InsightItem[];
}

/** Steps waiting for review, by what jev-img saw. */
export interface ReviewGroup {
  label: string;
  count: number;
  items: InsightItem[];
}

/** Project-level insights from each scenario's latest run and its recent history. */
export interface ProjectInsights {
  /** When the most recent of the latest runs started. */
  asOf?: string;
  scenarios: number;
  newScenarios: number;
  neverRun: number;
  counts: { passed: number; failed: number; review: number; notRun: number };
  failedNew: number;
  /** Passed share of the scenarios that have run, 0-100. */
  passRate?: number;
  durationMs: number;
  flaky: number;
  health?: { grade: 'A' | 'B' | 'C' | 'D' | 'F'; score: number; pass: number; stability: number; perf: number };
  clusters: FailureCluster[];
  reviews: ReviewGroup[];
  slowest: InsightItem[];
  atRisk: InsightItem[];
  regressions: InsightItem[];
  fixed: InsightItem[];
  mostFlaky: InsightItem[];
  newest: InsightItem[];
  /** Whether an AI summary can be asked for (a Claude key is set on the server). */
  aiAvailable: boolean;
}
