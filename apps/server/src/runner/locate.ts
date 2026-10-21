import type { Locator, Page } from 'playwright';

export interface Located {
  locator: Locator;
  selector: string;
  /** True when the primary selector failed and a fallback matched. */
  healed: boolean;
}

/** Tries each recorded selector in rank order and returns the first that matches exactly one element. */
export async function locate(page: Page, selectors: string[], timeoutMs = 10_000): Promise<Located> {
  if (selectors.length === 0) throw new Error('Step has no selectors');
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  do {
    for (let i = 0; i < selectors.length; i++) {
      const locator = page.locator(selectors[i]);
      try {
        const n = await locator.count();
        if (n === 1 && (await locator.isVisible())) return { locator, selector: selectors[i], healed: i > 0 };
        if (n > 1) lastError = `${selectors[i]} matched ${n} elements`;
      } catch (e) {
        lastError = (e as Error).message;
      }
    }
    await page.waitForTimeout(250);
  } while (Date.now() < deadline);
  throw new Error(`No selector matched: ${selectors.join(' | ')}${lastError ? ` (${lastError})` : ''}`);
}
