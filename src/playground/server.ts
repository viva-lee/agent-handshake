// `npm run playground` → http://127.0.0.1:4317
import { readFile } from 'node:fs/promises';
import { SCENARIOS, runScenario, type ScenarioName } from '../demo/scenarios.ts';
import { HttpError, Router, json, listen } from '../net/http.ts';

const here = new URL('./', import.meta.url);
const TYPES: Record<string, string> = {
  woff2: 'font/woff2',
  svg: 'image/svg+xml',
  png: 'image/png',
  txt: 'text/plain; charset=utf-8',
};

async function asset(path: string): Promise<{ raw: Buffer; contentType: string }> {
  // Only plain file names inside assets/ (no traversal).
  if (!/^(fonts\/)?[\w.-]+\.(woff2|svg|png|txt)$/.test(path)) throw new HttpError(404, 'not_found');
  const ext = path.split('.').pop() ?? '';
  const data = await readFile(new URL(`assets/${path}`, here)).catch(() => {
    throw new HttpError(404, 'not_found');
  });
  return { raw: data, contentType: TYPES[ext] ?? 'application/octet-stream' };
}

// CP_CACHE=1 replays the first run of each scenario (stable codes and timings, used to record media).
const cache = new Map<string, unknown>();
const cached = process.env.CP_CACHE === '1';

const router = new Router()
  .on('GET', '/', async () => ({ raw: await readFile(new URL('index.html', here), 'utf8'), contentType: 'text/html; charset=utf-8' }))
  .on('GET', '/assets/:file', (req) => asset(req.params.file))
  .on('GET', '/assets/fonts/:file', (req) => asset(`fonts/${req.params.file}`))
  .on('GET', '/api/run', async (req) => {
    const scenario = req.query.get('scenario') ?? 'handshake';
    if (!(SCENARIOS as string[]).includes(scenario)) throw new HttpError(400, 'unknown_scenario');
    const lang = req.query.get('lang') === 'ko' ? 'ko' : 'en';
    const key = `${scenario}:${lang}`;
    if (cached && cache.has(key)) return json(cache.get(key));
    const result = await runScenario(scenario as ScenarioName, { lang });
    if (cached) cache.set(key, result);
    return json(result);
  });

const port = Number(process.env.PORT ?? 4317);
const srv = await listen(router, port);
console.log(`Agent Handshake playground → ${srv.url}`);
