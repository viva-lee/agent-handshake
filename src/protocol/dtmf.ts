// In-band handshake frames carried as DTMF digits (spec/handshake.md §3).
//
//   frame  = "*#" type payload check "#"
//   type   = "1" OFFER  (callee -> caller)  payload = registry(1) + rendezvous code(10)
//            "2" PROBE  (caller -> callee)  payload = (none)
//            "3" BIND   (caller -> callee)  payload = bind code(6)
//   check  = Luhn mod-10 digit over type + payload
//
// Only 0-9, * and # are used because many telephony APIs cannot send A-D.

export const DTMF_TONE_MS = 80;
export const DTMF_GAP_MS = 60;

export type Frame =
  | { type: 'offer'; registry: string; code: string }
  | { type: 'probe' }
  | { type: 'bind'; bindCode: string };

const TYPE_DIGIT = { offer: '1', probe: '2', bind: '3' } as const;

function assertDigits(value: string, length: number, name: string): void {
  if (!new RegExp(`^\\d{${length}}$`).test(value)) {
    throw new Error(`${name} must be exactly ${length} digits`);
  }
}

export function luhnCheckDigit(digits: string): string {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return String((10 - (sum % 10)) % 10);
}

export function luhnValid(digitsWithCheck: string): boolean {
  if (digitsWithCheck.length < 2) return false;
  return luhnCheckDigit(digitsWithCheck.slice(0, -1)) === digitsWithCheck.slice(-1);
}

export function encodeFrame(frame: Frame): string {
  let body: string;
  switch (frame.type) {
    case 'offer':
      assertDigits(frame.registry, 1, 'registry');
      assertDigits(frame.code, 10, 'code');
      body = TYPE_DIGIT.offer + frame.registry + frame.code;
      break;
    case 'probe':
      body = TYPE_DIGIT.probe;
      break;
    case 'bind':
      assertDigits(frame.bindCode, 6, 'bindCode');
      body = TYPE_DIGIT.bind + frame.bindCode;
      break;
  }
  return `*#${body}${luhnCheckDigit(body)}#`;
}

/** Extracts every valid frame from a received DTMF digit stream; invalid frames are dropped. */
export function decodeFrames(stream: string): Frame[] {
  const frames: Frame[] = [];
  for (const match of stream.matchAll(/\*#(\d+)#/g)) {
    const digits = match[1];
    if (!luhnValid(digits)) continue;
    const type = digits[0];
    const payload = digits.slice(1, -1);
    if (type === TYPE_DIGIT.offer && payload.length === 11) {
      frames.push({ type: 'offer', registry: payload[0], code: payload.slice(1) });
    } else if (type === TYPE_DIGIT.probe && payload.length === 0) {
      frames.push({ type: 'probe' });
    } else if (type === TYPE_DIGIT.bind && payload.length === 6) {
      frames.push({ type: 'bind', bindCode: payload });
    }
  }
  return frames;
}

export function dtmfDurationMs(digits: string): number {
  return digits.length * (DTMF_TONE_MS + DTMF_GAP_MS);
}
