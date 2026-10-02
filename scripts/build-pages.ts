// `npm run build:pages` → a static copy of the playground in docs/ for GitHub Pages.
// The page runs without the Node server: every scenario is pre-recorded into docs/data/.
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { SCENARIOS, runScenario } from '../src/demo/scenarios.ts';
import type { Lang } from '../src/protocol/types.ts';

const root = new URL('../', import.meta.url);
const out = new URL('docs/', root);
const LANGS: Lang[] = ['en', 'ko'];

await mkdir(new URL('data/', out), { recursive: true });

const html = await readFile(new URL('src/playground/index.html', root), 'utf8');
if (!html.includes('<html lang="en">')) throw new Error('index.html: <html lang="en"> marker not found');
await writeFile(new URL('index.html', out), html.replace('<html lang="en">', '<html lang="en" data-static="1">'));
await cp(new URL('src/playground/assets/', root), new URL('assets/', out), { recursive: true });
await writeFile(new URL('.nojekyll', out), ''); // serve files as they are

let bytes = 0;
for (const scenario of SCENARIOS) {
  for (const lang of LANGS) {
    const json = JSON.stringify(await runScenario(scenario, { lang }));
    bytes += json.length;
    await writeFile(new URL(`data/${scenario}-${lang}.json`, out), json);
  }
}
console.log(`docs/: index.html, assets/, ${SCENARIOS.length * LANGS.length} recorded runs (${Math.round(bytes / 1024)} KB)`);
