import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { Project, Rect } from '@izaro/shared';
import sharp from 'sharp';
import { config } from './config.js';

// Playwright is only the hands and eyes here: it moves the mouse, presses keys
// and takes screenshots. Nothing reads or queries the page's DOM.

export function launchBrowser(): Promise<Browser> {
  return chromium.launch({ headless: config.headless, executablePath: config.chromiumPath, channel: config.browserChannel, timeout: 60_000 });
}

/**
 * Recording and execution share these settings so screenshots are comparable:
 * fixed viewport, scale, locale and timezone, and no motion.
 */
export function newContext(browser: Browser, project: Project, opts: { videoDir?: string } = {}): Promise<BrowserContext> {
  return browser.newContext({
    recordVideo: opts.videoDir ? { dir: opts.videoDir, size: project.viewport } : undefined,
    viewport: project.viewport,
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
    colorScheme: 'light',
  });
}

export function screenshot(page: Page): Promise<Buffer> {
  return page.screenshot({ animations: 'disabled', caret: 'hide', scale: 'css' });
}

/**
 * Waits for loading to finish and then until two screenshots 300ms apart are
 * identical (max `timeoutMs`). Returns the last screenshot.
 */
export async function settle(page: Page, timeoutMs = 5_000): Promise<Buffer> {
  await page.waitForLoadState('load', { timeout: timeoutMs }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: timeoutMs }).catch(() => {});
  const deadline = Date.now() + timeoutMs;
  let prev = await screenshot(page);
  while (Date.now() < deadline) {
    await page.waitForTimeout(300);
    const next = await screenshot(page);
    if (next.equals(prev)) return next;
    prev = next;
  }
  return prev;
}

export async function crop(png: Buffer, r: Rect): Promise<Buffer> {
  const { width = 0, height = 0 } = await sharp(png).metadata();
  const left = Math.max(0, Math.min(width - 1, Math.round(r.x)));
  const top = Math.max(0, Math.min(height - 1, Math.round(r.y)));
  return sharp(png)
    .extract({ left, top, width: Math.max(1, Math.min(width - left, Math.round(r.width))), height: Math.max(1, Math.min(height - top, Math.round(r.height))) })
    .png()
    .toBuffer();
}
