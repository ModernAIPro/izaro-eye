import type { Project, Step, TestCase } from '@izaro/shared';

const q = (s: string) => JSON.stringify(s);
const val = (v: string | undefined) => {
  const m = /^\{\{env:([A-Za-z_][A-Za-z0-9_]*)\}\}$/.exec(v ?? '');
  return m ? `process.env.${m[1]}!` : q(v ?? '');
};

function line(step: Step): string {
  const loc = `page.locator(${q(step.selectors[0] ?? '')})`;
  switch (step.action) {
    case 'navigate':
      return `await page.goto(${q(step.url ?? '')});`;
    case 'click':
      return `await ${loc}.click();`;
    case 'fill':
      return `await ${loc}.fill(${val(step.value)});`;
    case 'select':
      return `await ${loc}.selectOption(${q(step.value ?? '')});`;
    case 'check':
      return `await ${loc}.check();`;
    case 'uncheck':
      return `await ${loc}.uncheck();`;
    case 'press':
      return `await ${loc}.press(${q(step.value ?? 'Enter')});`;
    case 'assert': {
      const a = step.assertion!;
      if (a.kind === 'url') return `await expect(page).toHaveURL(new RegExp(${q(a.pattern)}));`;
      if (a.kind === 'visible') return `await expect(${loc}).toBeVisible();`;
      if (a.kind === 'value') return `await expect(${loc}).toHaveValue(${q(a.expected)});`;
      if (a.kind === 'text') return a.op === 'equals' ? `await expect(${loc}).toHaveText(${q(a.expected)});` : `await expect(${loc}).toContainText(${q(a.expected)});`;
      return `await expect(${loc}).toHaveScreenshot();`;
    }
  }
}

/** Exports a recorded test as a standalone Playwright spec. */
export function toPlaywrightSpec(project: Project, test: TestCase): string {
  const out = [
    `import { test, expect } from '@playwright/test';`,
    ``,
    `test.use({ viewport: ${JSON.stringify(project.viewport)}, locale: 'en-US', timezoneId: 'UTC' });`,
    ``,
    `test(${q(test.name)}, async ({ page }) => {`,
  ];
  const a = project.auth;
  if (a) {
    out.push(
      `  // Login (${project.name})`,
      `  await page.goto(${q(new URL(a.loginUrl, project.baseUrl).toString())});`,
      `  await page.locator(${q(a.usernameSelector)}).fill(${val(a.username)});`,
      `  await page.locator(${q(a.passwordSelector)}).fill(${val(a.password)});`,
      `  await page.locator(${q(a.submitSelector)}).click();`,
      '',
    );
  }
  for (const s of test.steps) {
    out.push(`  // ${s.label}`, `  ${line(s)}`);
    if (s.screenshot === 'viewport' && s.action !== 'assert') out.push(`  await expect(page).toHaveScreenshot();`);
  }
  out.push(`});`, ``);
  return out.join('\n');
}
