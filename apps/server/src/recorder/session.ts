import { EventEmitter } from 'node:events';
import type { Browser, BrowserContext, CDPSession, Page } from 'playwright';
import type { Assertion, InspectedElement, Project, RecorderClientMessage, RecorderServerMessage, Step } from '@izaro/shared';
import { launchBrowser, login, newContext } from '../browser.js';
import { newId } from '../ids.js';
import { RECORDER_SCRIPT } from './inject.js';

interface RawEvent {
  action: Step['action'];
  selectors: string[];
  value?: string;
  secret?: boolean;
  label: string;
}

/** Secrets typed while recording are replaced with this env placeholder. */
export const SECRET_PLACEHOLDER = '{{env:AUT_PASSWORD}}';

/**
 * One live recording: a server-side browser streamed to the UI as JPEG frames,
 * with the viewer's mouse and keyboard forwarded back into it.
 */
export class RecorderSession extends EventEmitter {
  readonly id = newId('rec');
  steps: Step[] = [];
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private cdp?: CDPSession;

  constructor(readonly project: Project, private startUrl: string) {
    super();
  }

  async start(): Promise<void> {
    this.browser = await launchBrowser();
    this.context = await newContext(this.browser, this.project);
    const page = (this.page = await this.context.newPage());
    await login(page, this.project);

    await page.exposeBinding('__izaroRecord', (source, evt: RawEvent) => {
      if (source.frame !== page.mainFrame()) return;
      this.onRecorded(evt);
    });
    await page.addInitScript(RECORDER_SCRIPT);
    page.on('framenavigated', (f) => {
      if (f === page.mainFrame()) this.emitMessage({ type: 'url', url: f.url() });
    });

    const url = new URL(this.startUrl, this.project.baseUrl).toString();
    await page.goto(url);
    this.addStep({ action: 'navigate', selectors: [], url, label: `Open ${url}`, screenshot: 'viewport' });

    this.cdp = await this.context.newCDPSession(page);
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

  private addStep(step: Omit<Step, 'id'>) {
    this.steps.push({ id: newId('step'), ...step });
    this.emitMessage({ type: 'steps', steps: this.steps });
  }

  private onRecorded(evt: RawEvent) {
    const last = this.steps[this.steps.length - 1];
    // Typing produces one input event per keystroke; keep only the final value.
    if (evt.action === 'fill' && last?.action === 'fill' && last.selectors[0] === evt.selectors[0]) {
      last.value = evt.secret ? SECRET_PLACEHOLDER : evt.value;
      this.emitMessage({ type: 'steps', steps: this.steps });
      return;
    }
    this.addStep({
      action: evt.action,
      selectors: evt.selectors,
      value: evt.secret ? SECRET_PLACEHOLDER : evt.value,
      secret: evt.secret || undefined,
      label: `${evt.action} ${evt.label}`.trim(),
      screenshot: 'viewport',
    });
  }

  private queue: Promise<void> = Promise.resolve();

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
        await page.mouse.move(msg.x, msg.y);
        if (msg.event === 'down') await page.mouse.down({ button: msg.button ?? 'left' });
        if (msg.event === 'up') await page.mouse.up({ button: msg.button ?? 'left' });
        break;
      case 'wheel':
        await page.mouse.move(msg.x, msg.y);
        await page.mouse.wheel(msg.deltaX, msg.deltaY);
        break;
      case 'key':
        if (msg.event === 'down') await page.keyboard.down(msg.key);
        else await page.keyboard.up(msg.key);
        break;
      case 'navigate': {
        const url = new URL(msg.url, this.project.baseUrl).toString();
        await page.goto(url);
        this.addStep({ action: 'navigate', selectors: [], url, label: `Open ${url}`, screenshot: 'viewport' });
        break;
      }
      case 'inspect': {
        const element = (await page
          .evaluate(([x, y]) => (window as unknown as { __izaro?: { inspect(x: number, y: number): unknown } }).__izaro?.inspect(x, y) ?? null, [msg.x, msg.y] as const)
          .catch(() => null)) as InspectedElement | null;
        this.emitMessage({ type: 'inspected', element });
        break;
      }
      case 'assert':
        this.addAssertion(msg.selectors, msg.assertion, page.url());
        break;
      case 'deleteStep':
        this.steps = this.steps.filter((s) => s.id !== msg.stepId);
        this.emitMessage({ type: 'steps', steps: this.steps });
        break;
    }
  }

  private addAssertion(selectors: string[], assertion: Assertion, url: string) {
    const label =
      assertion.kind === 'text'
        ? `assert text ${assertion.op} "${assertion.expected}"`
        : assertion.kind === 'value'
          ? `assert value = "${assertion.expected}"`
          : assertion.kind === 'url'
            ? `assert URL matches ${assertion.pattern}`
            : assertion.kind === 'visual'
              ? 'visual checkpoint'
              : 'assert visible';
    this.addStep({
      action: 'assert',
      selectors: assertion.kind === 'url' ? [] : selectors,
      assertion,
      url: assertion.kind === 'url' ? url : undefined,
      label,
      screenshot: assertion.kind === 'visual' ? 'element' : 'none',
    });
  }

  async stop(): Promise<void> {
    await this.cdp?.send('Page.stopScreencast').catch(() => {});
    await this.browser?.close().catch(() => {});
    this.removeAllListeners();
  }
}

export class RecorderRegistry {
  private sessions = new Map<string, RecorderSession>();

  async create(project: Project, startUrl: string) {
    const s = new RecorderSession(project, startUrl);
    await s.start();
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
