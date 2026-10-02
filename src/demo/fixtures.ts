// Demo businesses, principals and requests for the simulation (fictional names and numbers).
import type { BookingRequest } from '../agents/customer-agent.ts';
import type { Business, BusinessConfig } from '../business/business.ts';
import type { Lang } from '../protocol/types.ts';
import { localToMs, nextWeekdayDate, parseHm, parseOffset, toLocalIso } from '../protocol/util.ts';

export interface DemoFixture {
  lang: Lang;
  config: BusinessConfig;
  principal: { id: string; display_name: string; contact: string };
  request: BookingRequest;
  seed: { staff_id: string; service_id: string; time: string }[];
}

const SATURDAY = 6;

export function demoFixture(lang: Lang, nowMs = Date.now()): DemoFixture {
  const config: BusinessConfig =
    lang === 'ko'
      ? {
          business_id: 'seongsu-hair',
          name: '성수 헤어 스튜디오',
          tel: '+82-2-555-0123',
          locale: 'ko-KR',
          timezone: 'Asia/Seoul',
          utc_offset: '+09:00',
          currency: 'KRW',
          hours: { open: '10:00', close: '20:00', days: [0, 2, 3, 4, 5, 6] },
          services: [
            { id: 'cut-women', name: '여성 커트', duration_min: 60, price: 35000 },
            { id: 'cut-men', name: '남성 커트', duration_min: 30, price: 25000 },
            { id: 'perm', name: '펌', duration_min: 120, price: 120000 },
          ],
          staff: [
            { id: 'kim', name: '김 디자이너' },
            { id: 'lee', name: '이 디자이너' },
          ],
          policies: {
            hold_ttl_s: 300,
            cancellation: { free_until_h: 24, late_fee: 10000 },
            deposit: { amount: 10000, required: 'none' },
          },
        }
      : {
          business_id: 'desert-bloom',
          name: 'Desert Bloom Salon',
          tel: '+1-602-555-0123',
          locale: 'en-US',
          timezone: 'America/Phoenix',
          utc_offset: '-07:00',
          currency: 'USD',
          hours: { open: '09:00', close: '19:00', days: [2, 3, 4, 5, 6] },
          services: [
            { id: 'cut-women', name: "women's cut", duration_min: 60, price: 65 },
            { id: 'cut-men', name: "men's cut", duration_min: 30, price: 40 },
            { id: 'color', name: 'color', duration_min: 120, price: 150 },
          ],
          staff: [
            { id: 'kim', name: 'Kim' },
            { id: 'lee', name: 'Lee' },
          ],
          policies: {
            hold_ttl_s: 300,
            cancellation: { free_until_h: 24, late_fee: 20 },
            deposit: { amount: 20, required: 'none' },
          },
        };

  const offset = parseOffset(config.utc_offset);
  const date = nextWeekdayDate(nowMs, offset, SATURDAY, 1);
  const [y, m, d] = date.split('-').map(Number);
  const at = (hm: string) => toLocalIso(localToMs(y, m, d, 0, 0, offset) + parseHm(hm) * 60_000, offset);
  const longService = lang === 'ko' ? 'perm' : 'color';

  return {
    lang,
    config,
    principal:
      lang === 'ko'
        ? { id: 'principal_7f3a', display_name: '박지우', contact: '010-5555-0199' }
        : { id: 'principal_7f3a', display_name: 'Alex Rivera', contact: '602-555-0199' },
    request: {
      service_id: 'cut-women',
      service_label: config.services[0].name,
      when_label: lang === 'ko' ? '이번 주 토요일 오후에' : 'this Saturday afternoon',
      date,
      after: '12:00',
      before: '18:00',
      from_iso: at('12:00'),
      to_iso: at('18:00'),
    },
    // Fill the early afternoon so the first free slots are 14:00 (kim) and 15:30 (lee).
    seed: [
      { staff_id: 'kim', service_id: 'cut-women', time: '12:00' },
      { staff_id: 'kim', service_id: 'cut-women', time: '13:00' },
      { staff_id: 'lee', service_id: longService, time: '12:00' },
      { staff_id: 'lee', service_id: 'cut-women', time: '14:00' },
      { staff_id: 'lee', service_id: 'cut-men', time: '15:00' },
    ],
  };
}

export function seedBookings(business: Business, fx: DemoFixture): void {
  const offset = parseOffset(fx.config.utc_offset);
  const [y, m, d] = fx.request.date.split('-').map(Number);
  for (const s of fx.seed) {
    const start = localToMs(y, m, d, 0, 0, offset) + parseHm(s.time) * 60_000;
    const hold = business.createHold(business.encodeSlotId(s.staff_id, s.service_id, start), 'staff:seed');
    business.createBooking(hold.hold_id, 'staff:seed', { display_name: 'walk-in' }, { channel: 'staff' });
  }
}
