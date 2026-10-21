// Sends one baseline/rerun pair to jev-img and prints the raw response, to
// confirm the API key and request format. Usage: pnpm --filter @izaro/server jev:check
import './load-env.js';
import { PNG } from 'pngjs';
import { config } from './config.js';
import { parseJevResponse, TypeSafeJevClassifier } from './compare/jev.js';
import { fitForJev } from './compare/prepare.js';

const image = (shifted: boolean) => {
  const png = new PNG({ width: 800, height: 500 });
  for (let y = 0; y < 500; y++)
    for (let x = 0; x < 800; x++) {
      const card = x >= (shifted ? 300 : 40) && x < (shifted ? 600 : 340) && y >= 60 && y < 260;
      png.data.set(card ? [47, 111, 222, 255] : [244, 245, 247, 255], (y * 800 + x) * 4);
    }
  return PNG.sync.write(png);
};

if (!config.typesafe.apiKey) {
  console.error('TYPESAFE_API_KEY is not set (put it in apps/server/.env)');
  process.exit(1);
}
const jev = new TypeSafeJevClassifier();
const [a, b] = await Promise.all([fitForJev(image(false)), fitForJev(image(true))]);
const input = { baseline: a, candidate: b, diffRatio: 0.2, context: { stepLabel: 'jev-check' } };
const res = await fetch(config.typesafe.url, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${config.typesafe.apiKey}`,
    'Content-Type': 'application/json',
    'TypeSafe-Danger-Zone-Images': 'true',
  },
  body: JSON.stringify(jev.buildRequest(a, b, input)),
});
const body = await res.text();
console.log(`HTTP ${res.status}\n${body}`);
if (res.ok) console.log('\nParsed:', parseJevResponse(JSON.parse(body), input));
