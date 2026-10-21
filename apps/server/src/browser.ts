import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import type { Project, Step } from '@izaro/shared';
import { config } from './config.js';
import { expand } from './template.js';

export function launchBrowser(): Promise<Browser> {
  return chromium.launch({ headless: config.headless, executablePath: config.chromiumPath });
}

/**
 * Recording and replay share these settings so screenshots are comparable:
 * fixed viewport, scale, locale and timezone, and no motion.
 */
export function newContext(browser: Browser, project: Project): Promise<BrowserContext> {
  return browser.newContext({
    viewport: project.viewport,
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
    colorScheme: 'light',
  });
}

export async function login(page: Page, project: Project): Promise<void> {
  const auth = project.auth;
  if (!auth) return;
  await page.goto(new URL(auth.loginUrl, project.baseUrl).toString());
  await page.locator(auth.usernameSelector).fill(expand(auth.username));
  await page.locator(auth.passwordSelector).fill(expand(auth.password));
  await page.locator(auth.submitSelector).click();
  if (auth.successSelector) await page.locator(auth.successSelector).waitFor({ state: 'visible', timeout: 15_000 });
  else await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
}

/** Waits until the page is quiet enough that a screenshot is reproducible. */
export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('load', { timeout: 10_000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
  await page
    .evaluate(
      () =>
        new Promise<void>((resolve) => {
          // Resolve once the layout has stopped changing for 300ms (max 3s).
          let last = '';
          let stableSince = performance.now();
          const started = performance.now();
          const tick = () => {
            const sig = `${document.documentElement.scrollHeight}:${document.body?.innerText.length ?? 0}`;
            if (sig !== last) {
              last = sig;
              stableSince = performance.now();
            }
            if (performance.now() - stableSince > 300 || performance.now() - started > 3000) resolve();
            else requestAnimationFrame(tick);
          };
          tick();
        }),
    )
    .catch(() => {});
}

export async function capture(page: Page, step: Step, element?: Locator): Promise<Buffer | undefined> {
  if (step.screenshot === 'none') return undefined;
  const mask = (step.masks ?? []).map((s) => page.locator(s));
  const opts = { animations: 'disabled' as const, caret: 'hide' as const, mask, scale: 'css' as const };
  if (step.screenshot === 'element' && element) return element.screenshot(opts);
  return page.screenshot(opts);
}
