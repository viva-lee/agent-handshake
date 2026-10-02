// Terminal demo: `npm run demo` (all scenarios) or `npm run demo -- handshake --lang ko`.
import { SCENARIOS, runScenario, type ScenarioName, type ScenarioResult } from './demo/scenarios.ts';
import type { TimelineEvent } from './agents/sim-call.ts';
import type { Lang } from './protocol/types.ts';

const args = process.argv.slice(2);
const lang: Lang = args.includes('--lang') && args[args.indexOf('--lang') + 1] === 'ko' ? 'ko' : 'en';
const picked = args.filter((a) => (SCENARIOS as string[]).includes(a)) as ScenarioName[];
const verbose = args.includes('--verbose') || picked.length === 1;

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const sec = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

function line(e: TimelineEvent): string {
  const t = c('2', sec(e.t).padStart(6));
  const who = (e.from === 'caller' ? c('36', 'caller') : e.from === 'callee' ? c('35', 'callee') : c('33', e.from)).padEnd(color ? 15 : 6);
  switch (e.channel) {
    case 'voice':
      return `${t}  ${who}  🗣  ${e.text}`;
    case 'dtmf':
      return `${t}  ${who}  ${c('33', '♫')}  ${e.digits}  ${c('2', `(${e.frame})`)}`;
    case 'net':
      return `${t}  ${who}  ${c('34', '⇄')}  ${e.http?.method} ${e.http?.path} → ${e.http?.status} ${c('2', `→ ${e.to}`)}`;
    default:
      return `${t}  ${who}  ${c('2', `· ${e.text}`)}`;
  }
}

function summary(r: ScenarioResult): string {
  const o = r.outcome;
  const booked = o.booking ? `${o.booking.service} · ${o.booking.slot.start} · ${o.booking.staff}` : '—';
  return [
    r.scenario.padEnd(10),
    sec(r.totals.total_ms).padStart(7),
    String(r.totals.utterances).padStart(5),
    o.handshake.padEnd(16),
    o.via.padEnd(10),
    booked,
  ].join('  ');
}

const results: ScenarioResult[] = [];
for (const name of picked.length ? picked : SCENARIOS.filter((s) => s !== 'direct')) {
  const r = await runScenario(name, { lang });
  results.push(r);
  if (verbose) {
    console.log(`\n${c('1', `▶ ${name}`)}  ${r.business.name} (${r.business.tel}) · ${r.principal}`);
    for (const e of r.events) console.log(line(e));
  }
}

console.log(`\n${c('1', 'scenario    total  turns  handshake         via         booking')}`);
for (const r of results) console.log(summary(r));
console.log(c('2', `\n${results[0]?.assumptions.note} Assumed RTT ${results[0]?.assumptions.assumed_rtt_ms} ms.`));
