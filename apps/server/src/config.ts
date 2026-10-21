import path from 'node:path';

const num = (v: string | undefined, d: number) => (v === undefined || v === '' ? d : Number(v));

export const config = {
  port: num(process.env.PORT, 4000),
  dataDir: path.resolve(process.env.DATA_DIR ?? './data'),
  headless: process.env.HEADLESS !== 'false',
  chromiumPath: process.env.CHROMIUM_PATH || undefined,
  pixelIdenticalThreshold: num(process.env.PIXEL_IDENTICAL_THRESHOLD, 0.0005),
  typesafe: {
    apiKey: process.env.TYPESAFE_API_KEY || '',
    url: process.env.TYPESAFE_API_URL || 'https://api.typesafe.ai/v1/systemone',
    model: process.env.JEV_MODEL || 'jev-1.14.0',
  },
};
