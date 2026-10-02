// A simulated phone call with a virtual clock.
//
// Speech and DTMF advance the clock by an estimated duration; HTTP calls advance it by the
// measured localhost time plus an assumed internet round trip. Speech recognition is simulated:
// each utterance carries `meta` (the intent a real ASR + NLU stack would extract).
import { decodeFrames, dtmfDurationMs } from '../protocol/dtmf.ts';
import type { NetTrace } from '../net/http.ts';

export type Side = 'caller' | 'callee';
export type Party = Side | 'registry' | 'business' | 'agent';

export interface SpeechMeta {
  intent: string;
  [key: string]: unknown;
}

export type CallEvent =
  | { kind: 'speech'; text: string; meta: SpeechMeta }
  | { kind: 'dtmf'; digits: string }
  | { kind: 'hangup' };

export interface TimelineEvent {
  seq: number;
  t: number;
  dur: number;
  channel: 'voice' | 'dtmf' | 'net' | 'system';
  from: Party;
  to?: Party;
  text?: string;
  intent?: string;
  digits?: string;
  frame?: string;
  http?: {
    method: string;
    path: string;
    status: number;
    measured_ms: number;
    request?: unknown;
    response?: unknown;
  };
}

export class Timeline {
  now = 0;
  seq = 0;
  events: TimelineEvent[] = [];
  assumedRttMs: number;

  constructor(assumedRttMs: number) {
    this.assumedRttMs = assumedRttMs;
  }

  add(e: Omit<TimelineEvent, 'seq' | 't'>): TimelineEvent {
    const ev: TimelineEvent = { ...e, seq: ++this.seq, t: this.now };
    this.events.push(ev);
    this.now += e.dur;
    return ev;
  }

  net(trace: NetTrace): void {
    const from = (trace.from === 'business' ? 'business' : trace.from) as Party;
    const to = (trace.to === 'business' ? 'callee' : trace.to) as Party;
    this.add({
      channel: 'net',
      from,
      to,
      dur: Math.round(this.assumedRttMs + trace.ms),
      http: {
        method: trace.method,
        path: trace.path,
        status: trace.status,
        measured_ms: Math.round(trace.ms * 10) / 10,
        request: preview(trace.request),
        response: preview(trace.response),
      },
    });
  }

  totals(): Record<string, number> {
    const sum = (ch: TimelineEvent['channel']) =>
      this.events.filter((e) => e.channel === ch).reduce((acc, e) => acc + e.dur, 0);
    return {
      total_ms: this.now,
      voice_ms: sum('voice'),
      dtmf_ms: sum('dtmf'),
      net_ms: sum('net'),
      net_calls: this.events.filter((e) => e.channel === 'net').length,
      utterances: this.events.filter((e) => e.channel === 'voice').length,
    };
  }
}

/** Shortens long strings and expands JWS values so the playground can show what was signed. */
export function preview(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    if (/^eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+$/.test(value) && depth < 3) {
      try {
        const payload = JSON.parse(Buffer.from(value.split('.')[1], 'base64url').toString('utf8')) as unknown;
        return { jws: `${value.slice(0, 16)}…`, payload: preview(payload, depth + 1) };
      } catch {
        // not a JWS after all
      }
    }
    return value.length > 44 ? `${value.slice(0, 20)}…(${value.length})` : value;
  }
  if (Array.isArray(value)) return value.slice(0, 4).map((v) => preview(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = depth > 4 ? '…' : preview(v, depth + 1);
    return out;
  }
  return value;
}

export interface Line {
  readonly side: Side;
  readonly ended: boolean;
  say(text: string, meta: SpeechMeta): Promise<void>;
  dtmf(digits: string): Promise<void>;
  hangup(): Promise<void>;
}

export interface Participant {
  onConnect?(line: Line): Promise<void>;
  onEvent(e: CallEvent, line: Line): Promise<void>;
  onIdle?(line: Line): Promise<void>;
}

export interface VoiceTiming {
  msPerChar: number; // speaking rate
  turnGapMs: number; // pause before each utterance
}

export class SimCall {
  caller: Participant;
  callee: Participant;
  timeline: Timeline;
  timing: VoiceTiming;
  maxMs: number;
  ended = false;

  constructor(caller: Participant, callee: Participant, timeline: Timeline, timing: VoiceTiming, maxMs = 300_000) {
    this.caller = caller;
    this.callee = callee;
    this.timeline = timeline;
    this.timing = timing;
    this.maxMs = maxMs;
  }

  line(side: Side): Line {
    const call = this;
    return {
      side,
      get ended() {
        return call.ended;
      },
      say: (text, meta) => call.send(side, { kind: 'speech', text, meta }),
      dtmf: (digits) => call.send(side, { kind: 'dtmf', digits }),
      hangup: () => call.send(side, { kind: 'hangup' }),
    };
  }

  async send(from: Side, e: CallEvent): Promise<void> {
    if (this.ended) return;
    if (this.timeline.now > this.maxMs) {
      this.end(from, 'call ended (time limit)');
      return;
    }
    const to: Side = from === 'caller' ? 'callee' : 'caller';
    if (e.kind === 'hangup') {
      this.end(from, 'hangup');
      return;
    }
    if (e.kind === 'speech') {
      this.timeline.add({
        channel: 'voice',
        from,
        to,
        dur: this.timing.turnGapMs + [...e.text].length * this.timing.msPerChar,
        text: e.text,
        intent: e.meta.intent,
      });
    } else {
      this.timeline.add({
        channel: 'dtmf',
        from,
        to,
        dur: dtmfDurationMs(e.digits),
        digits: e.digits,
        frame: decodeFrames(e.digits).map((f) => f.type.toUpperCase()).join(' ') || 'noise',
      });
    }
    await (to === 'caller' ? this.caller : this.callee).onEvent(e, this.line(to));
  }

  end(from: Side, text: string): void {
    this.timeline.add({ channel: 'system', from, dur: 0, text });
    this.ended = true;
  }

  async run(): Promise<void> {
    this.timeline.add({ channel: 'system', from: 'caller', to: 'callee', dur: 0, text: 'call connected' });
    await this.callee.onConnect?.(this.line('callee'));
    let quietRounds = 0;
    while (!this.ended && quietRounds < 2) {
      const before = this.timeline.seq;
      await this.callee.onIdle?.(this.line('callee'));
      if (!this.ended) await this.caller.onIdle?.(this.line('caller'));
      quietRounds = this.timeline.seq === before ? quietRounds + 1 : 0;
    }
    if (!this.ended) this.end('callee', 'call ended (silence)');
  }
}
