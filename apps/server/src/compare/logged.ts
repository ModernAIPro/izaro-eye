import type { Classification, LogEntry, Region } from '@izaro/shared';
import type { ClassifyInput, FindAnswer, FindQuery, Vision } from './jev.js';

type Log = (entry: Omit<LogEntry, 'at' | 'source'> & { source?: LogEntry['source'] }) => void;

const pct = (n: number | undefined) => (n === undefined ? '–' : `${Math.round(n * 100)}%`);

/** Wraps a Vision so every jev-img question, answer and timing lands in the run log. */
export class LoggedVision implements Vision {
  constructor(
    private inner: Vision,
    private log: Log,
  ) {}

  get name() {
    return this.inner.name;
  }

  private async call<T>(question: string, f: () => Promise<T>, summary: (r: T) => string): Promise<T> {
    const started = Date.now();
    try {
      const r = await f();
      this.log({ source: 'typesafe', level: 'info', message: `${question} → ${summary(r)} (${Date.now() - started} ms)`, data: r });
      return r;
    } catch (e) {
      this.log({ source: 'typesafe', level: 'error', message: `${question} failed after ${Date.now() - started} ms: ${(e as Error).message}` });
      throw e;
    }
  }

  classify(input: ClassifyInput): Promise<Classification> {
    return this.call(`classify change for "${input.context.stepLabel}"`, () => this.inner.classify(input), (c) => `${c.label} ${pct(c.confidence)}`);
  }
  findElement(screen: Buffer, query: FindQuery): Promise<FindAnswer> {
    return this.call(
      `find "${query.label}"${query.crop ? ' (with library image)' : ''}`,
      () => this.inner.findElement(screen, query),
      (a) => `present ${pct(a.present)}${a.box ? `, box ${pct(a.box.left)}–${pct(a.box.right)} × ${pct(a.box.top)}–${pct(a.box.bottom)}` : ''}`,
    );
  }
  sameScreen(a: Buffer, b: Buffer): Promise<number> {
    return this.call('same screen?', () => this.inner.sameScreen(a, b), pct);
  }
  seesText(screen: Buffer, text: string): Promise<number> {
    return this.call(`text "${text}" visible?`, () => this.inner.seesText(screen, text), pct);
  }
  elementAt(screen: Buffer, point: { x: number; y: number }): Promise<Region | null> {
    return this.call(`control at (${Math.round(point.x)}, ${Math.round(point.y)})`, () => this.inner.elementAt(screen, point), (r) => (r ? 'found' : 'none'));
  }
}
