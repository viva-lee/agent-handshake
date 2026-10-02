// The callee: a business's AI receptionist. Talks by voice, and upgrades to CP-Handshake
// when the caller is an agent (spec/handshake.md §4).
import type { Business } from '../business/business.ts';
import type { NetTrace } from '../net/http.ts';
import { decodeFrames, encodeFrame } from '../protocol/dtmf.ts';
import type { Booking, Lang, Slot } from '../protocol/types.ts';
import { PHRASES, dayName, optionLabel, priceLabel, whenLabel, type Phrases } from './phrases.ts';
import type { CallEvent, Line, Participant } from './sim-call.ts';

type State = 'greeting' | 'offered' | 'digital' | 'voice' | 'done';

export interface ReceptionistOptions {
  business: Business;
  lang: Lang;
  cpEnabled?: boolean;
}

export class Receptionist implements Participant {
  business: Business;
  lang: Lang;
  p: Phrases;
  cpEnabled: boolean;
  onTrace?: (t: NetTrace) => void;

  state: State = 'greeting';
  offered = false;
  accepted = false;
  handshakeSession?: string;
  digitalBooking?: Booking;
  summarized = false;

  request?: { service_id: string; from: string; to: string };
  chosen?: string;
  customerName = '';
  contact = '';
  booking?: Booking;

  constructor(opts: ReceptionistOptions) {
    this.business = opts.business;
    this.lang = opts.lang;
    this.p = PHRASES[opts.lang];
    this.cpEnabled = opts.cpEnabled ?? true;
    this.business.events.on('handshake_accepted', (e: { session_id: string }) => {
      if (e.session_id === this.handshakeSession) this.accepted = true;
    });
    this.business.events.on('booked', (e: { booking: Booking; session_id?: string }) => {
      if (e.session_id && e.session_id === this.handshakeSession) this.digitalBooking = e.booking;
    });
  }

  async onConnect(line: Line): Promise<void> {
    await line.say(this.p.greet(this.business.config.name), { intent: 'greet' });
  }

  async onEvent(e: CallEvent, line: Line): Promise<void> {
    if (e.kind === 'dtmf') {
      for (const frame of decodeFrames(e.digits)) {
        if (frame.type === 'probe' && this.cpEnabled && !this.offered) await this.offer(line);
        if (frame.type === 'bind' && this.handshakeSession) {
          if (this.business.bindHandshake(this.handshakeSession, frame.bindCode)) this.state = 'digital';
        }
      }
      return;
    }
    if (e.kind !== 'speech') return;
    const m = e.meta;
    switch (m.intent) {
      case 'disclose':
        if (this.cpEnabled && !this.offered) await this.offer(line);
        else await line.say(this.p.askHow, { intent: 'ask_how' });
        return;
      case 'request':
        this.request = { service_id: String(m.service_id), from: String(m.from), to: String(m.to) };
        // An agent that discloses itself gets an OFFER; humans never hear the tones.
        if (m.is_ai === true && this.cpEnabled && !this.offered) {
          await this.offer(line);
          return;
        }
        this.state = 'voice';
        await this.propose(line, false);
        return;
      case 'choose':
        this.chosen = String(m.slot_id);
        await line.say(this.p.askName, { intent: 'ask_name' });
        return;
      case 'name':
        this.customerName = String(m.name);
        await line.say(this.p.askPhone, { intent: 'ask_phone' });
        return;
      case 'phone':
        this.contact = String(m.phone);
        await this.bookByVoice(line);
        return;
      case 'bye':
        this.state = 'done';
        await line.say(this.p.bye(dayName(this.booking?.slot.start ?? new Date().toISOString(), this.lang)), {
          intent: 'bye',
        });
        await line.hangup();
        return;
    }
  }

  async onIdle(line: Line): Promise<void> {
    if (this.state === 'offered') {
      // The caller did not complete the handshake (not an agent that speaks CP, or it failed): keep talking.
      this.state = 'voice';
      if (this.request) await this.propose(line, true);
      else await line.say(`${this.p.fallback} ${this.p.askHow}`, { intent: 'ask_how' });
      return;
    }
    if (this.state === 'digital') {
      if (this.digitalBooking && !this.summarized) {
        this.summarized = true;
        const b = this.digitalBooking;
        await line.say(
          this.p.summary({
            service: this.serviceName(b.slot.service_id),
            when: whenLabel(b.slot.start, this.lang),
            staff: this.staffName(b.slot.staff_id),
          }),
          { intent: 'summary', booking_id: b.booking_id },
        );
        return;
      }
      if (this.summarized) {
        await line.hangup();
        return;
      }
      this.state = 'voice';
      await line.say(`${this.p.fallback} ${this.p.askHow}`, { intent: 'ask_how' });
      return;
    }
    if (this.state === 'done') await line.hangup();
  }

  async offer(line: Line): Promise<void> {
    this.offered = true;
    const rv = await this.business.requestRendezvous((t) => this.onTrace?.(t));
    this.handshakeSession = rv.session_id;
    this.state = 'offered';
    await line.say(this.p.offerAnnounce, { intent: 'offer_announce' });
    await line.dtmf(encodeFrame({ type: 'offer', registry: rv.registry_id, code: rv.code }));
  }

  async propose(line: Line, afterFallback: boolean): Promise<void> {
    if (!this.request) return;
    const slots = this.business.availability({ ...this.request, limit: 50 });
    const picks: Slot[] = [];
    for (const s of slots) {
      if (!picks.some((x) => x.staff_id === s.staff_id)) picks.push(s);
      if (picks.length === 2) break;
    }
    if (picks.length === 0) {
      this.state = 'done';
      await line.say(this.p.noSlots, { intent: 'no_slots' });
      return;
    }
    const options = picks.map((s) => ({ slot_id: s.slot_id, label: optionLabel(s.start, this.staffName(s.staff_id), this.lang) }));
    const text = this.p.propose(
      this.serviceName(this.request.service_id),
      dayName(picks[0].start, this.lang),
      options.map((o) => o.label),
    );
    await line.say(afterFallback ? `${this.p.fallback} ${text}` : text, { intent: 'propose', options });
  }

  async bookByVoice(line: Line): Promise<void> {
    if (!this.chosen) return;
    const hold = this.business.createHold(this.chosen, 'staff:voice');
    const { booking } = this.business.createBooking(
      hold.hold_id,
      'staff:voice',
      { display_name: this.customerName, contact: this.contact },
      { channel: 'voice' },
    );
    this.booking = booking;
    await line.say(
      this.p.confirm({
        name: this.customerName,
        service: this.serviceName(booking.slot.service_id),
        when: whenLabel(booking.slot.start, this.lang),
        staff: this.staffName(booking.slot.staff_id),
        price: priceLabel(booking.price, booking.currency, this.lang),
        freeHours: this.business.config.policies.cancellation.free_until_h,
      }),
      { intent: 'confirm', booking_id: booking.booking_id },
    );
  }

  serviceName(id: string): string {
    return this.business.config.services.find((s) => s.id === id)?.name ?? id;
  }

  staffName(id: string): string {
    return this.business.config.staff.find((s) => s.id === id)?.name ?? id;
  }
}
