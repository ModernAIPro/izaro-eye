// Calls each jev-img question once on synthetic screens and prints the answers
// and timings, to confirm the API key and measure latency.
// Usage: pnpm --filter @izaro/server jev:check
import './load-env.js';
import sharp from 'sharp';
import { config } from './config.js';
import { JevVision } from './compare/jev.js';

const W = 1280, H = 800;
const screen = (cardX: number) =>
  sharp({ create: { width: W, height: H, channels: 3, background: '#f4f5f7' } })
    .composite([
      {
        input: Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
          <rect width="${W}" height="64" fill="#243b6b"/><text x="24" y="42" font-size="24" fill="#fff" font-family="Arial">Acme Portal</text>
          <rect x="${cardX}" y="120" width="420" height="200" rx="8" fill="#fff"/>
          <text x="${cardX + 24}" y="170" font-size="26" font-family="Arial">Welcome, admin</text>
          <rect x="${cardX + 24}" y="230" width="200" height="44" rx="4" fill="#1f8a4c"/>
          <text x="${cardX + 44}" y="259" font-size="18" fill="#fff" font-family="Arial">Shop plans</text></svg>`),
      },
    ])
    .png()
    .toBuffer();

if (!config.typesafe.apiKey) {
  console.error('TYPESAFE_API_KEY is not set (put it in apps/server/.env)');
  process.exit(1);
}
const jev = new JevVision();
const [a, b] = await Promise.all([screen(40), screen(400)]);
const timed = async <T>(name: string, f: () => Promise<T>) => {
  const t = Date.now();
  try {
    console.log(name.padEnd(12), JSON.stringify(await f()), `${Date.now() - t}ms`);
  } catch (e) {
    console.log(name.padEnd(12), 'FAILED', (e as Error).message);
  }
};
await timed('classify', () => jev.classify({ baseline: a, candidate: b, diffRatio: 0.2, context: { stepLabel: 'jev-check' } }));
await timed('findElement', () => jev.findElement(b, { label: 'Shop plans' }));
await timed('sameScreen', () => jev.sameScreen(a, b));
await timed('seesText', () => jev.seesText(b, 'Welcome, admin'));
await timed('elementAt', () => jev.elementAt(a, { x: 164, y: 252 }));
console.log('Expected: layout change; Shop plans near x 0.33-0.49, y 0.29-0.34; same screen high; text high; elementAt near x 0.05-0.2, y 0.29-0.34');
