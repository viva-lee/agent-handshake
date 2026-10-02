import { randomBytes, randomInt } from 'node:crypto';

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export const randomId = (prefix: string): string => `${prefix}_${randomBytes(9).toString('base64url')}`;
export const randomToken = (): string => randomBytes(32).toString('base64url');
export const randomDigits = (n: number): string => Array.from({ length: n }, () => String(randomInt(10))).join('');

export const nowSeconds = (clock: Clock): number => Math.floor(clock.now() / 1000);

/** "+09:00" -> 540, "-07:00" -> -420 */
export function parseOffset(offset: string): number {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
  if (!m) throw new Error(`bad utc offset ${offset}`);
  const minutes = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === '-' ? -minutes : minutes;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Formats an instant as RFC 3339 in a fixed offset, e.g. 2026-10-03T14:00:00+09:00 */
export function toLocalIso(ms: number, offsetMin: number): string {
  const d = new Date(ms + offsetMin * 60_000);
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

export interface LocalParts {
  y: number;
  m: number;
  d: number;
  dow: number;
  hh: number;
  mm: number;
}

export function localParts(ms: number, offsetMin: number): LocalParts {
  const d = new Date(ms + offsetMin * 60_000);
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    dow: d.getUTCDay(),
    hh: d.getUTCHours(),
    mm: d.getUTCMinutes(),
  };
}

export function localToMs(y: number, m: number, d: number, hh: number, mm: number, offsetMin: number): number {
  return Date.UTC(y, m - 1, d, hh, mm) - offsetMin * 60_000;
}

/** "14:30" -> 870 */
export function parseHm(hm: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(hm);
  if (!m) throw new Error(`bad HH:MM ${hm}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Local calendar date ("YYYY-MM-DD") of the next given weekday at least `minDaysAhead` days out. */
export function nextWeekdayDate(nowMs: number, offsetMin: number, dow: number, minDaysAhead = 1): string {
  for (let i = minDaysAhead; i < minDaysAhead + 8; i++) {
    const p = localParts(nowMs + i * 86_400_000, offsetMin);
    if (p.dow === dow) return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
  }
  throw new Error('unreachable');
}

export function normalizeTel(tel: string): string {
  return tel.replace(/[^\d+]/g, '');
}
