// The step library: reusable steps a project defines in its own words, such as
// `Search for "{term}"`, each made of base steps. A scenario line that matches a
// library step's pattern runs that step's body with the quoted values filled in.

import type { ScenarioStep } from './index.js';
import { normalizeStep, parseStep } from './scenario.js';

export type LibraryStepKind = 'action' | 'flow' | 'check';

export interface LibraryStep {
  id: string;
  projectId: string;
  /** The sentence, with parameters in braces: `Search for "{term}"`. */
  pattern: string;
  kind: LibraryStepKind;
  /** What the step is for, in a sentence. */
  intent: string;
  /** Screen the step expects to start on, and the one it leaves the app on. */
  startScreenId?: string;
  endScreenId?: string;
  /** Base steps or other library steps; `{name}` is replaced with the matching value. */
  body: ScenarioStep[];
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

/** A library step as the API returns it, with where it is used. */
export interface LibraryStepView extends LibraryStep {
  usedBy: { scenarios: { id: string; name: string }[]; steps: { id: string; pattern: string }[] };
}

const PARAM = /\{([A-Za-z_][\w-]*)\}/g;

/** Parameter names in a pattern, in order. */
export function stepParams(pattern: string): string[] {
  return [...pattern.matchAll(PARAM)].map((m) => m[1]);
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Turns a pattern into a regular expression: quoted `"{x}"` takes any quoted text, bare `{x}` any words. */
export function compileStepPattern(pattern: string): RegExp {
  const src = normalizeStep(pattern)
    .split(/(["“”]\{[A-Za-z_][\w-]*\}["“”]|\{[A-Za-z_][\w-]*\})/)
    .map((part, i) => {
      if (i % 2 === 0) return part.split(/\s+/).map(escape).join('\\s+');
      return part.startsWith('{') ? '(.+?)' : '["“”]([^"“”]*)["“”]';
    })
    .join('');
  return new RegExp(`^${src}$`, 'i');
}

/** Puts values into `{name}` placeholders; unknown names are left as they are. */
export function fillParams(text: string, args: Record<string, string>): string {
  return text.replace(PARAM, (whole, name: string) => (name in args ? args[name] : whole));
}

/** Finds the library step a scenario line uses, with the values it passes. Patterns with more fixed words win ties. */
export function matchLibraryStep(text: string, steps: LibraryStep[]): { step: LibraryStep; args: Record<string, string> } | undefined {
  const s = normalizeStep(text);
  let best: { step: LibraryStep; args: Record<string, string>; weight: number } | undefined;
  for (const step of steps) {
    const m = compileStepPattern(step.pattern).exec(s);
    if (!m) continue;
    const names = stepParams(step.pattern);
    const weight = step.pattern.replace(PARAM, '').length;
    if (!best || weight > best.weight) best = { step, args: Object.fromEntries(names.map((n, i) => [n, m[i + 1]])), weight };
  }
  return best && { step: best.step, args: best.args };
}

/** Problems with a pattern itself (not its body). */
export function patternProblems(pattern: string): string[] {
  const p = normalizeStep(pattern);
  const problems: string[] = [];
  if (!p) return ['Write the step as a sentence, e.g. Search for "{term}"'];
  const names = stepParams(p);
  if (new Set(names.map((n) => n.toLowerCase())).size !== names.length) problems.push('Each {name} can appear only once in the sentence');
  if (!p.replace(PARAM, '').replace(/["“”\s]/g, '')) problems.push('The sentence needs words besides its {values}');
  // A library step can't shadow a base step: base steps always win, so it would never run.
  if (parseStep(fillParams(p, Object.fromEntries(names.map((n) => [n, 'x'])))).ok) problems.push('That sentence is already a base step pattern; pick other words');
  return problems;
}

/** Rewrites a line that uses `from` so it uses `to` instead, keeping its values. */
export function renameStepUse(text: string, from: string, to: string): string | undefined {
  const m = compileStepPattern(from).exec(normalizeStep(text));
  if (!m) return undefined;
  const args = Object.fromEntries(stepParams(from).map((n, i) => [n, m[i + 1]]));
  return fillParams(to, args);
}
