import path from 'node:path';

const num = (v: string | undefined, d: number) => (v === undefined || v === '' ? d : Number(v));

export const config = {
  port: num(process.env.PORT, 4000),
  dataDir: path.resolve(process.env.DATA_DIR ?? './data'),
  headless: process.env.HEADLESS !== 'false',
  chromiumPath: process.env.CHROMIUM_PATH || undefined,
  /** e.g. `chrome` to use the locally installed Google Chrome instead of Playwright's Chromium. */
  browserChannel: process.env.BROWSER_CHANNEL || undefined,
  pixelIdenticalThreshold: num(process.env.PIXEL_IDENTICAL_THRESHOLD, 0.0005),
  typesafe: {
    apiKey: process.env.TYPESAFE_API_KEY || '',
    url: process.env.TYPESAFE_API_URL || 'https://api.typesafe.ai/v1/systemone',
    model: process.env.JEV_MODEL || 'jev-1.14.0',
  },
  /** Optional: Claude writes a plain-language summary on the Insights tab. Off unless ANTHROPIC_API_KEY is set. */
  claude: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    model: process.env.CLAUDE_MODEL || 'claude-opus-5-5',
  },
};
