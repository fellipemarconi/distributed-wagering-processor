import type { INestApplication } from '@nestjs/common';

export const scrape = async (app: INestApplication): Promise<string> =>
  (await fetch(`${await app.getUrl()}/metrics`)).text();

/** Soma das séries de `name` cujas labels contêm `labels` (0 se nenhuma existe ainda). */
export function valueOf(text: string, name: string, labels: Record<string, string> = {}): number {
  let total = 0;
  for (const line of text.split('\n')) {
    const match = /^([a-zA-Z_:][\w:]*)(?:\{(.*)\})?\s+(\S+)$/.exec(line);
    if (!match || match[1] !== name) continue;
    const have = Object.fromEntries([...(match[2] ?? '').matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
    if (Object.entries(labels).every(([key, value]) => have[key] === value)) total += Number(match[3]);
  }
  return total;
}

export const metric = async (app: INestApplication, name: string, labels: Record<string, string> = {}) =>
  valueOf(await scrape(app), name, labels);
