// Scripted dialog for the simulated voice channel, in Korean and English.
import type { Lang } from '../protocol/types.ts';

const KO_DAYS = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];
const EN_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function parts(iso: string): { dow: number; hh: number; mm: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  if (!m) throw new Error(`bad iso ${iso}`);
  const dow = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
  return { dow, hh: Number(m[4]), mm: Number(m[5]) };
}

/** Korean object particle 로/으로 after the last syllable. */
function ro(word: string): string {
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  if (code < 0 || code > 11171) return `${word}로`;
  const batchim = code % 28;
  return batchim === 0 || batchim === 8 ? `${word}로` : `${word}으로`;
}

export function dayName(iso: string, lang: Lang): string {
  const { dow } = parts(iso);
  return lang === 'ko' ? KO_DAYS[dow] : EN_DAYS[dow];
}

export function timeLabel(iso: string, lang: Lang): string {
  const { hh, mm } = parts(iso);
  if (lang === 'ko') {
    const half = hh < 12 ? '오전' : '오후';
    const h12 = hh % 12 === 0 ? 12 : hh % 12;
    return `${half} ${h12}시${mm ? ` ${mm}분` : ''}`;
  }
  const suffix = hh < 12 ? 'AM' : 'PM';
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}:${String(mm).padStart(2, '0')} ${suffix}`;
}

export function whenLabel(iso: string, lang: Lang): string {
  return lang === 'ko' ? `${dayName(iso, lang)} ${timeLabel(iso, lang)}` : `${dayName(iso, lang)} at ${timeLabel(iso, lang)}`;
}

export function priceLabel(amount: number, currency: string, lang: Lang): string {
  if (currency === 'KRW') return lang === 'ko' ? `${amount.toLocaleString('ko-KR')}원` : `₩${amount.toLocaleString('en-US')}`;
  if (currency === 'USD') return `$${amount.toLocaleString('en-US')}`;
  return `${amount} ${currency}`;
}

export function optionLabel(iso: string, staffName: string, lang: Lang): string {
  return lang === 'ko' ? `${staffName} ${timeLabel(iso, lang)}` : `${timeLabel(iso, lang)} with ${staffName}`;
}

export interface Phrases {
  greet(business: string): string;
  disclose(principal: string): string;
  request(service: string, when: string): string;
  requestHuman(service: string, when: string): string;
  offerAnnounce: string;
  fallback: string;
  askHow: string;
  propose(service: string, day: string, options: string[]): string;
  choose(option: string): string;
  askName: string;
  name(n: string): string;
  askPhone: string;
  phone(p: string): string;
  confirm(o: { name: string; service: string; when: string; staff: string; price: string; freeHours: number }): string;
  noMore: string;
  bye(day: string): string;
  summary(o: { service: string; when: string; staff: string }): string;
  noSlots: string;
}

const ko: Phrases = {
  greet: (b) => `안녕하세요, ${b} AI 응대입니다. 무엇을 도와드릴까요?`,
  disclose: (p) => `안녕하세요, ${p} 님 대신 전화드린 AI 비서입니다.`,
  request: (s, w) => `${w} ${s} 예약하고 싶습니다.`,
  requestHuman: (s, w) => `안녕하세요, ${w} ${s} 예약하고 싶은데요.`,
  offerAnnounce: '에이전트 연결을 지원합니다.',
  fallback: '네, 음성으로 계속 도와드릴게요.',
  askHow: '네, 어떤 예약을 도와드릴까요?',
  propose: (_s, d, opts) => `${d} 오후에는 ${opts.join(', ')} 예약이 가능합니다. 어느 쪽이 좋으세요?`,
  choose: (o) => `${ro(o)} 할게요.`,
  askName: '좋습니다. 예약자 성함을 알려주시겠어요?',
  name: (n) => `${n}입니다.`,
  askPhone: '확인 문자를 받으실 연락처도 부탁드립니다.',
  phone: (p) => `${p}입니다.`,
  confirm: (o) =>
    `${o.name} 님, ${o.when} ${o.staff} ${ro(o.service)} 예약됐습니다. 가격은 ${o.price}이고, ${o.freeHours}시간 전까지 무료로 취소하실 수 있어요. 더 필요하신 건 있으세요?`,
  noMore: '아니요, 감사합니다!',
  bye: (d) => `감사합니다. ${d}에 뵙겠습니다!`,
  summary: (o) => `에이전트로 예약이 완료됐습니다. ${o.when}, ${o.staff} ${o.service}입니다. 감사합니다!`,
  noSlots: '죄송합니다, 그 시간에는 가능한 자리가 없습니다.',
};

const en: Phrases = {
  greet: (b) => `Hi, you've reached ${b}. This is the AI receptionist. How can I help?`,
  disclose: (p) => `Hi, I'm an AI assistant calling on behalf of ${p}.`,
  request: (s, w) => `I'd like to book a ${s} ${w}.`,
  requestHuman: (s, w) => `Hi, I'd like to book a ${s} ${w}.`,
  offerAnnounce: 'Agent connect is available on this line.',
  fallback: "No problem, let's continue by voice.",
  askHow: 'Sure, what would you like to book?',
  propose: (s, d, opts) =>
    `For a ${s} on ${d} afternoon, I have ${opts.length > 1 ? `${opts.slice(0, -1).join(', ')} or ${opts.at(-1)}` : opts[0]}. Which works best?`,
  choose: (o) => `${o}, please.`,
  askName: 'Great. Can I get the name for the booking?',
  name: (n) => `It's ${n}.`,
  askPhone: 'And a mobile number for the confirmation text?',
  phone: (p) => `It's ${p}.`,
  confirm: (o) =>
    `Thanks, ${o.name.split(' ')[0]}. You're booked for a ${o.service} on ${o.when} with ${o.staff}. It's ${o.price}, and you can cancel free up to ${o.freeHours} hours before. Anything else?`,
  noMore: "No, that's everything. Thanks!",
  bye: (d) => `Thank you. See you on ${d}!`,
  summary: (o) => `Booked through your agent: ${o.service}, ${o.when}, with ${o.staff}. Goodbye!`,
  noSlots: 'Sorry, nothing is available then.',
};

export const PHRASES: Record<Lang, Phrases> = { ko, en };
