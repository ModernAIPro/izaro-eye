import type { Project, Rect, Screen, ScreenElement } from '@izaro/shared';
import { UNLABELLED } from '@izaro/shared';
import { pixelDiff } from './compare/pixel.js';
import type { Vision } from './compare/jev.js';
import { newId, now } from './ids.js';
import type { Store } from './store/db.js';
import type { ImageStore } from './store/images.js';

/** At the same address, screens closer than this in pixels are the same screen without asking jev-img. */
const SAME_SCREEN_PIXEL_RATIO = 0.03;
/** At a different address only a near-identical screenshot counts (e.g. the same page under two URLs). */
const OTHER_ADDRESS_PIXEL_RATIO = 0.002;
/** jev-img must be this sure before two different-looking shots count as one screen. */
const SAME_SCREEN_MIN = 0.8;
const MAX_JEV_CANDIDATES = 3;

const pathOf = (url: string) => {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return url;
  }
};

const overlap = (a: Rect, b: Rect) => {
  const x = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const inter = x * y;
  return inter / (a.width * a.height + b.width * b.height - inter || 1);
};

/** The screen library: every distinct screen of the application, captured as images. */
export class Library {
  constructor(
    private store: Store,
    private images: ImageStore,
    private vision: Vision,
  ) {}

  /** The same library, asking a different vision client (e.g. one with the project's own TypeSafe key). */
  withVision(vision: Vision): Library {
    return vision === this.vision ? this : new Library(this.store, this.images, vision);
  }

  /** Returns the library screen this screenshot shows, if any. */
  async identify(projectId: string, png: Buffer, url: string): Promise<Screen | undefined> {
    const screens = this.store.listScreens(projectId);
    const samePath = screens.filter((s) => pathOf(s.url) === pathOf(url));
    const ordered = [...samePath, ...screens.filter((s) => !samePath.includes(s))];
    for (const s of ordered) {
      const d = pixelDiff(await this.images.get(s.imageKey), png);
      const limit = samePath.includes(s) ? SAME_SCREEN_PIXEL_RATIO : OTHER_ADDRESS_PIXEL_RATIO;
      if (!d.sizeMismatch && d.ratio <= limit) return s;
    }
    // Same address but different pixels (other data, an open menu): ask jev-img.
    for (const s of samePath.slice(0, MAX_JEV_CANDIDATES)) {
      try {
        if ((await this.vision.sameScreen(await this.images.get(s.imageKey), png)) >= SAME_SCREEN_MIN) return s;
      } catch {
        break;
      }
    }
    return undefined;
  }

  async add(project: Project, png: Buffer, url: string, title: string): Promise<Screen> {
    const taken = new Set(this.store.listScreens(project.id).map((s) => s.name.toLowerCase()));
    let base = title.trim() || new URL(url).pathname.replace(/^\/|\/$/g, '') || 'Home';
    base = base.slice(0, 60);
    let name = base;
    for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base} (${i})`;
    const screen: Screen = {
      id: newId('scr'),
      projectId: project.id,
      name,
      url,
      title,
      imageKey: await this.images.put(png),
      elements: [],
      next: [],
      createdAt: now(),
      updatedAt: now(),
    };
    return this.store.saveScreen(screen);
  }

  async identifyOrAdd(project: Project, png: Buffer, url: string, title: string): Promise<{ screen: Screen; isNew: boolean }> {
    const found = await this.identify(project.id, png, url);
    return found ? { screen: found, isNew: false } : { screen: await this.add(project, png, url, title), isNew: true };
  }

  /** Adds (or reuses) an element on a screen. */
  async addElement(screenId: string, rect: Rect, crop: Buffer): Promise<ScreenElement> {
    const screen = this.store.getScreen(screenId)!;
    const existing = screen.elements.find((e) => overlap(e.rect, rect) > 0.6);
    if (existing) return existing;
    const el: ScreenElement = { id: newId('el'), label: UNLABELLED, rect, cropKey: await this.images.put(crop) };
    screen.elements.push(el);
    this.store.saveScreen({ ...screen, updatedAt: now() });
    return el;
  }

  linkTransition(fromId: string, elementId: string, toId: string) {
    const from = this.store.getScreen(fromId);
    if (!from || from.next.some((n) => n.elementId === elementId && n.screenId === toId)) return;
    from.next.push({ elementId, screenId: toId });
    this.store.saveScreen({ ...from, updatedAt: now() });
  }

  setElementLabel(screenId: string, elementId: string, label: string) {
    const s = this.store.getScreen(screenId);
    const el = s?.elements.find((e) => e.id === elementId);
    if (!s || !el || el.label === label) return;
    el.label = label;
    this.store.saveScreen({ ...s, updatedAt: now() });
  }

  /** Finds an element by label, preferring the given screen. */
  findByLabel(projectId: string, label: string, preferScreenId?: string): { screen: Screen; element: ScreenElement } | undefined {
    const want = label.trim().toLowerCase();
    const screens = this.store.listScreens(projectId).sort((a, b) => (a.id === preferScreenId ? -1 : b.id === preferScreenId ? 1 : 0));
    for (const screen of screens) {
      const element = screen.elements.find((e) => e.label.trim().toLowerCase() === want);
      if (element) return { screen, element };
    }
    return undefined;
  }

  findScreenByName(projectId: string, name: string): Screen | undefined {
    const want = name.trim().toLowerCase();
    return this.store.listScreens(projectId).find((s) => s.name.trim().toLowerCase() === want);
  }
}
