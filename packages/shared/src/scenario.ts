// The scenario language: one plain-English sentence per step, following a
// fixed set of patterns. Quoted text is an on-screen label or an exact value.

export type Action =
  | { kind: 'click'; target: string }
  | { kind: 'enter'; value: string; target: string }
  | { kind: 'choose'; option: string; target: string }
  | { kind: 'press'; key: string }
  | { kind: 'scroll'; direction: 'up' | 'down' }
  | { kind: 'goto'; url: string }
  | { kind: 'expectScreen'; screen: string }
  | { kind: 'expectText'; text: string }
  | { kind: 'run'; scenario: string }
  | { kind: 'wait'; seconds: number };

export const STEP_PATTERNS: { pattern: string; example: string }[] = [
  { pattern: 'Click "label"', example: 'Click "Sign in"' },
  { pattern: 'Enter "value" in "field"', example: 'Enter "jane@example.com" in "Email"' },
  { pattern: 'Choose "option" in "dropdown"', example: 'Choose "Canada" in "Country"' },
  { pattern: 'Press "key"', example: 'Press "Enter"' },
  { pattern: 'Scroll down / Scroll up', example: 'Scroll down' },
  { pattern: 'Go to "address"', example: 'Go to "/settings"' },
  { pattern: 'Expect the "name" screen', example: 'Expect the "Home" screen' },
  { pattern: 'Expect to see "text"', example: 'Expect to see "Welcome back"' },
  { pattern: 'Run "scenario"', example: 'Run "Log in"' },
  { pattern: 'Wait N seconds', example: 'Wait 2 seconds' },
];

const Q = String.raw`["“”]([^"“”]*)["“”]`;
const rules: [RegExp, (m: RegExpExecArray) => Action][] = [
  [new RegExp(`^(?:click|tap)(?: on)? ${Q}$`, 'i'), (m) => ({ kind: 'click', target: m[1] })],
  [new RegExp(`^(?:enter|type) ${Q} (?:in|into) ${Q}$`, 'i'), (m) => ({ kind: 'enter', value: m[1], target: m[2] })],
  [new RegExp(`^(?:choose|select) ${Q} (?:in|from) ${Q}$`, 'i'), (m) => ({ kind: 'choose', option: m[1], target: m[2] })],
  [new RegExp(`^press ${Q}$`, 'i'), (m) => ({ kind: 'press', key: m[1] })],
  [/^scroll (up|down)$/i, (m) => ({ kind: 'scroll', direction: m[1].toLowerCase() as 'up' | 'down' })],
  [new RegExp(`^(?:go to|open) ${Q}$`, 'i'), (m) => ({ kind: 'goto', url: m[1] })],
  [new RegExp(`^expect(?: to be on)? the ${Q} (?:screen|page)$`, 'i'), (m) => ({ kind: 'expectScreen', screen: m[1] })],
  [new RegExp(`^expect to see ${Q}$`, 'i'), (m) => ({ kind: 'expectText', text: m[1] })],
  [new RegExp(`^run ${Q}$`, 'i'), (m) => ({ kind: 'run', scenario: m[1] })],
  [/^wait (\d+(?:\.\d+)?) seconds?$/i, (m) => ({ kind: 'wait', seconds: Number(m[1]) })],
];

/** Strips list numbering ("1.", "2)", "-") and a trailing full stop. */
export function normalizeStep(text: string): string {
  return text
    .trim()
    .replace(/^(?:\d+[.)]|[-*•])\s+/, '')
    .replace(/\.$/, '')
    .trim();
}

export type ParseResult = { ok: true; action: Action } | { ok: false; error: string };

export function parseStep(text: string): ParseResult {
  const s = normalizeStep(text);
  if (!s) return { ok: false, error: 'Empty step' };
  for (const [re, build] of rules) {
    const m = re.exec(s);
    if (m) {
      const action = build(m);
      const empty = Object.entries(action).find(([k, v]) => k !== 'kind' && v === '');
      if (empty) return { ok: false, error: `"${empty[0]}" is empty` };
      return { ok: true, action };
    }
  }
  return { ok: false, error: `Doesn't match a step pattern. Try e.g. ${STEP_PATTERNS.slice(0, 3).map((p) => p.example).join(', ')}` };
}

/** Renders an action back into its canonical sentence. */
export function stepText(a: Action): string {
  switch (a.kind) {
    case 'click':
      return `Click "${a.target}"`;
    case 'enter':
      return `Enter "${a.value}" in "${a.target}"`;
    case 'choose':
      return `Choose "${a.option}" in "${a.target}"`;
    case 'press':
      return `Press "${a.key}"`;
    case 'scroll':
      return `Scroll ${a.direction}`;
    case 'goto':
      return `Go to "${a.url}"`;
    case 'expectScreen':
      return `Expect the "${a.screen}" screen`;
    case 'expectText':
      return `Expect to see "${a.text}"`;
    case 'run':
      return `Run "${a.scenario}"`;
    case 'wait':
      return `Wait ${a.seconds} seconds`;
  }
}

/** Label used for elements the user has not named yet while recording. */
export const UNLABELLED = '?';
