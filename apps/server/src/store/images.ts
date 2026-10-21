import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Content-addressed image storage on local disk. Identical screenshots share one
 * file. Swap for an S3 implementation with the same interface in production.
 */
export class ImageStore {
  constructor(private root: string) {}

  async put(png: Buffer): Promise<string> {
    const hash = createHash('sha256').update(png).digest('hex');
    const key = `${hash.slice(0, 2)}/${hash}.png`;
    const file = this.path(key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, png, { flag: 'w' });
    return key;
  }

  get(key: string): Promise<Buffer> {
    return fs.readFile(this.path(key));
  }

  path(key: string): string {
    if (!/^[0-9a-f]{2}\/[0-9a-f]{64}\.png$/.test(key)) throw new Error(`Invalid image key: ${key}`);
    return path.join(this.root, key);
  }
}
