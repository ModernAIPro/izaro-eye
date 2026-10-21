import { EventEmitter } from 'node:events';
import type { Browser, CDPSession, Page } from 'playwright';
import {
  parseStep,
  stepText,
  UNLABELLED,
  type Action,
  type Project,
  type Rect,
  type RecorderClientMessage,
  type RecorderServerMessage,
  type RecorderStep,
  type Screen,
} from '@izaro/shared';
import { crop, launchBrowser, newContext, screenshot, settle } from '../browser.js';
import type { Vision } from '../compare/jev.js';
import { newId } from '../ids.js';
import type { Library } from '../library.js';
import { Executor, flatten, type ExecutorDeps } from '../runner/executor.js';
import { expand } from '../template.js';

/** Used when jev-img is unavailable or its box does not contain the click. */
const DEFAULT_BOX = { width: 180, height: 44 };
const NAMED_KEYS = new Set(['Enter', 'Tab', 'Escape']);

export interface RecorderDeps extends ExecutorDeps {
  library: Library;
  vision: Vision;
}

/**
 * One live recording: a server-side browser streamed to the UI as JPEG frames,
 * with the viewer's mouse and keyboard forwarded back into it. Every click is
 * captured as an image of the element and every new screen goes into the
 * library; the steps are written as a scenario in the fixed sentence patterns.
 */
export class RecorderSession extends EventEmitter {
  readonly id = newId('rec');
  steps: RecorderStep[] = [];
  private browser?: Browser;
  private page?: Page;
  private cdp?: CDPSession;
  private screen?: Screen;
  private pressed?: { x: number; y: number; before: Buffer; screenId: string };
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private deps: RecorderDeps,
    readonly project: Project,
    private startUrl?: string,
  ) {
    super();
  }

  async start(): Promise<void> {
    this.browser = await launchBrowser();
    const page = (this.page = await (await newContext(this.browser, this.project)).newPage());
    page.on('framenavigated', (f) => {
      if (f === page.mainFrame()) this.emitMessage({ type: 'url', url: f.url() });
    });
    await page.goto(this.project.baseUrl);

    const setup = this.project.setupScenarioId ? this.deps.store.getScenario(this.project.setupScenarioId) : undefined;
    if (setup) {
      const exec = new Executor(this.deps, this.project, page);
      for (const { step, error } of flatten(this.deps.store, this.project, setup)) {
        const p = parseStep(step.text);
        if (error || !p.ok) throw new Error(`Setup scenario "${setup.name}": ${error ?? (p as { error: string }).error}`);
        const out = await exec.perform(p.action, step.hint);
        if (out.status === 'failed' || out.status === 'error') throw new Error(`Setup scenario "${setup.name}" failed at: ${step.text}`);
      }
      this.steps.push({ text: stepText({ kind: 'run', scenario: setup.name }) });
    }
    if (this.startUrl) {
      await page.goto(new URL(this.startUrl, this.project.baseUrl).toString());
      this.steps.push({ text: stepText({ kind: 'goto', url: this.startUrl }) });
    }
    await this.checkScreen();

    this.cdp = await page.context().newCDPSession(page);
    this.cdp.on('Page.screencastFrame', (f) => {
      this.emitMessage({ type: 'frame', data: f.data, width: f.metadata.deviceWidth, height: f.metadata.deviceHeight });
      this.cdp?.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
    });
    await this.cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 70,
      maxWidth: this.project.viewport.width,
      maxHeight: this.project.viewport.height,
    });
  }

  private emitMessage(msg: RecorderServerMessage) {
    this.emit('message', msg);
  }
  private emitSteps() {
    this.emitMessage({ type: 'steps', steps: this.steps });
  }

  /** Identifies the settled screen; a new or different screen adds an `Expect the "..." screen` step. */
  private async checkScreen(via?: { screenId: string; elementId: string }) {
    const page = this.page!;
    // Give a navigation started by the last action a moment to begin before waiting for stillness.
    await page.waitForTimeout(400);
    const shot = await settle(page);
    const { screen } = await this.deps.library.identifyOrAdd(this.project, shot, page.url(), await page.title());
    if (screen.id !== this.screen?.id) {
      if (via) this.deps.library.linkTransition(via.screenId, via.elementId, screen.id);
      this.steps.push({ text: stepText({ kind: 'expectScreen', screen: screen.name }), hint: { screenId: screen.id } });
    }
    this.screen = screen;
    this.emitSteps();
  }

  /** Input is applied strictly in arrival order, so a click lands before the keys typed after it. */
  handle(msg: RecorderClientMessage): Promise<void> {
    const next = this.queue.then(() => this.apply(msg));
    this.queue = next.catch(() => {});
    return next;
  }

  private async apply(msg: RecorderClientMessage): Promise<void> {
    const page = this.page;
    if (!page) return;
    switch (msg.type) {
      case 'mouse':
        if (msg.event === 'down' && (msg.button ?? 'left') === 'left') {
          this.pressed = { x: msg.x, y: msg.y, before: await screenshot(page), screenId: this.screen!.id };
        }
        await page.mouse.move(msg.x, msg.y);
        if (msg.event === 'down') await page.mouse.down({ button: msg.button ?? 'left' });
        if (msg.event === 'up') {
          await page.mouse.up({ button: msg.button ?? 'left' });
          const p = this.pressed;
          this.pressed = undefined;
          if (p && Math.hypot(p.x - msg.x, p.y - msg.y) < 6) await this.recordClick(p);
        }
        break;
      case 'wheel': {
        await page.mouse.move(msg.x, msg.y);
        await page.mouse.wheel(msg.deltaX, msg.deltaY);
        if (msg.deltaY === 0) break;
        const text = stepText({ kind: 'scroll', direction: msg.deltaY > 0 ? 'down' : 'up' });
        if (this.steps.at(-1)?.text !== text) {
          this.steps.push({ text });
          this.emitSteps();
        }
        break;
      }
      case 'key':
        if (msg.event === 'up') {
          await page.keyboard.up(msg.key);
          break;
        }
        await page.keyboard.down(msg.key);
        if (msg.key.length === 1) this.typed((v) => v + msg.key);
        else if (msg.key === 'Backspace') this.typed((v) => v.slice(0, -1));
        else if (NAMED_KEYS.has(msg.key)) {
          this.steps.push({ text: stepText({ kind: 'press', key: msg.key }) });
          if (msg.key === 'Enter') await this.checkScreen();
          else this.emitSteps();
        }
        break;
      case 'secret': {
        const placeholder = `{{secret:${msg.name}}}`;
        await page.keyboard.insertText(expand(placeholder));
        if (!this.typed((v) => v + placeholder)) this.emitMessage({ type: 'error', message: 'Click a field before inserting a secret' });
        break;
      }
      case 'navigate': {
        await page.goto(new URL(msg.url, this.project.baseUrl).toString());
        this.steps.push({ text: stepText({ kind: 'goto', url: msg.url }) });
        await this.checkScreen();
        break;
      }
      case 'expectText':
        this.steps.push({ text: stepText({ kind: 'expectText', text: msg.text }) });
        this.emitSteps();
        break;
      case 'setSteps':
        this.steps = msg.steps;
        this.emitSteps();
        break;
    }
  }

  private async recordClick(p: { x: number; y: number; before: Buffer; screenId: string }) {
    const rect = await this.elementRect(p.before, p);
    const element = await this.deps.library.addElement(p.screenId, rect, await crop(p.before, rect));
    this.steps.push({
      text: stepText({ kind: 'click', target: element.label || UNLABELLED }),
      hint: { screenId: p.screenId, elementId: element.id },
      cropKey: element.cropKey,
    });
    this.emitSteps();
    await this.checkScreen({ screenId: p.screenId, elementId: element.id });
  }

  /** Bounds of the clicked control from jev-img, or a fixed box around the click. */
  private async elementRect(before: Buffer, p: { x: number; y: number }): Promise<Rect> {
    const vp = this.project.viewport;
    const fallback: Rect = {
      x: Math.max(0, Math.min(vp.width - DEFAULT_BOX.width, p.x - DEFAULT_BOX.width / 2)),
      y: Math.max(0, Math.min(vp.height - DEFAULT_BOX.height, p.y - DEFAULT_BOX.height / 2)),
      ...DEFAULT_BOX,
    };
    this.emitMessage({ type: 'busy', busy: true });
    try {
      const box = await this.deps.vision.elementAt(before, p);
      if (!box) return fallback;
      const r: Rect = { x: box.left * vp.width, y: box.top * vp.height, width: (box.right - box.left) * vp.width, height: (box.bottom - box.top) * vp.height };
      const contains = p.x >= r.x - 4 && p.x <= r.x + r.width + 4 && p.y >= r.y - 4 && p.y <= r.y + r.height + 4;
      const sane = r.width >= 8 && r.height >= 8 && r.width <= vp.width * 0.6 && r.height <= vp.height * 0.5;
      return contains && sane ? r : fallback;
    } catch {
      return fallback;
    } finally {
      this.emitMessage({ type: 'busy', busy: false });
    }
  }

  /**
   * Typing turns the most recent `Click "field"` into `Enter "..." in "field"`
   * (or extends it). Returns false when there is no field to type into.
   */
  private typed(change: (value: string) => string): boolean {
    for (let i = this.steps.length - 1; i >= 0; i--) {
      const parsed = parseStep(this.steps[i].text);
      if (!parsed.ok) return false;
      const a = parsed.action;
      if (a.kind === 'expectScreen') continue;
      let next: Action | undefined;
      if (a.kind === 'click') next = { kind: 'enter', value: change(''), target: a.target };
      else if (a.kind === 'enter') next = { ...a, value: change(a.value) };
      if (!next) return false;
      this.steps[i] = { ...this.steps[i], text: stepText(next) };
      this.emitSteps();
      return true;
    }
    return false;
  }

  async stop(): Promise<void> {
    await this.cdp?.send('Page.stopScreencast').catch(() => {});
    await this.browser?.close().catch(() => {});
    this.removeAllListeners();
  }
}

export class RecorderRegistry {
  private sessions = new Map<string, RecorderSession>();

  constructor(private deps: RecorderDeps) {}

  async create(project: Project, startUrl?: string) {
    const s = new RecorderSession(this.deps, project, startUrl);
    try {
      await s.start();
    } catch (e) {
      await s.stop();
      throw e;
    }
    this.sessions.set(s.id, s);
    return s;
  }
  get(id: string) {
    return this.sessions.get(id);
  }
  async close(id: string) {
    const s = this.sessions.get(id);
    this.sessions.delete(id);
    await s?.stop();
  }
  async closeAll() {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }
}
