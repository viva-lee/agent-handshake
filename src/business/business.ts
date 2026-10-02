// Reference business endpoint ("Counter Lite"): CP-Commit API + the business side of CP-Handshake.
import { EventEmitter } from 'node:events';
import { decodeJws, generateKeyPair, signJws, thumbprint, verifyJws, type KeyPair, type PublicJwk } from '../crypto/jws.ts';
import {
  HttpError,
  Router,
  createClient,
  json,
  obj,
  optStr,
  str,
  type HttpClient,
  type NetTrace,
  type Request,
} from '../net/http.ts';
import {
  API_PREFIX,
  CP_VERSION,
  SCOPES,
  type AgentIdentity,
  type Booking,
  type BusinessCard,
  type Hold,
  type Mandate,
  type Offer,
  type Proof,
  type Receipt,
  type ServiceInfo,
  type Slot,
} from '../protocol/types.ts';
import {
  localParts,
  localToMs,
  nowSeconds,
  parseHm,
  parseOffset,
  randomDigits,
  randomId,
  randomToken,
  systemClock,
  toLocalIso,
  type Clock,
} from '../protocol/util.ts';

export type BusinessConfig = Omit<BusinessCard, 'cp_version' | 'api' | 'keys'>;

export type Trust = 'operator-verified' | 'self-asserted';

export interface Session {
  token: string;
  via: 'handshake' | 'direct';
  session_id: string;
  agent: AgentIdentity;
  trust: Trust;
  mandate: Mandate;
  bound: boolean;
  bind_code?: string;
  bind_deadline?: number;
  bind_attempts: number;
  expires_at: number;
}

interface PendingHandshake {
  session_id: string;
  code: string;
  expires_at: number;
  accepted: boolean;
}

interface HoldRecord {
  hold: Hold;
  owner: string;
  expires: number;
}

interface WaitEntry {
  waitlist_id: string;
  owner: string;
  service_id: string;
  staff_id?: string;
  from: number;
  to: number;
  callback_url: string;
  active: boolean;
}

interface OfferRecord {
  offer: Offer;
  owners: Set<string>;
  waitlist_ids: string[];
  expires: number;
  claimed_by?: string;
}

const SLOT_STEP_MIN = 30;
const MIN_LEAD_MIN = 30;
const BIND_WINDOW_MS = 15_000;
const SESSION_TTL_MS = 15 * 60_000;
const OFFER_TTL_MS = 120_000;
const PROOF_SKEW_S = 120;

const overlaps = (a0: number, a1: number, b0: number, b1: number): boolean => a0 < b1 && b0 < a1;

export interface BusinessOptions {
  clock?: Clock;
  keys?: KeyPair;
}

export class Business {
  config: BusinessConfig;
  clock: Clock;
  keys: KeyPair;
  offsetMin: number;
  events = new EventEmitter();
  api = '';
  registryUrl = '';
  onTrace?: (t: NetTrace) => void;

  bookings = new Map<string, Booking>();
  holds = new Map<string, HoldRecord>();
  sessions = new Map<string, Session>();
  handshakes = new Map<string, PendingHandshake>();
  sessionByHandshake = new Map<string, string>();
  waitlist = new Map<string, WaitEntry>();
  offers = new Map<string, OfferRecord>();
  operatorKeys = new Map<string, PublicJwk | null>();

  constructor(config: BusinessConfig, opts: BusinessOptions = {}) {
    this.config = config;
    this.clock = opts.clock ?? systemClock;
    this.keys = opts.keys ?? generateKeyPair();
    this.offsetMin = parseOffset(config.utc_offset);
  }

  get http(): HttpClient {
    return createClient('business', (t) => this.onTrace?.(t));
  }

  card(): BusinessCard {
    return { cp_version: CP_VERSION, ...this.config, api: this.api, keys: [this.keys.publicJwk] };
  }

  // ------------------------------------------------------------ slots

  service(id: string): ServiceInfo {
    const s = this.config.services.find((x) => x.id === id);
    if (!s) throw new HttpError(404, 'unknown_service');
    return s;
  }

  encodeSlotId(staffId: string, serviceId: string, startMs: number): string {
    return Buffer.from(JSON.stringify([staffId, serviceId, startMs])).toString('base64url');
  }

  decodeSlotId(slotId: string): { staff_id: string; service_id: string; start: number } {
    try {
      const [staff_id, service_id, start] = JSON.parse(Buffer.from(slotId, 'base64url').toString('utf8')) as [
        string,
        string,
        number,
      ];
      if (typeof staff_id === 'string' && typeof service_id === 'string' && Number.isFinite(start)) {
        return { staff_id, service_id, start };
      }
    } catch {
      // fall through
    }
    throw new HttpError(400, 'bad_slot_id');
  }

  makeSlot(staffId: string, serviceId: string, startMs: number): Slot {
    const end = startMs + this.service(serviceId).duration_min * 60_000;
    return {
      slot_id: this.encodeSlotId(staffId, serviceId, startMs),
      service_id: serviceId,
      staff_id: staffId,
      start: toLocalIso(startMs, this.offsetMin),
      end: toLocalIso(end, this.offsetMin),
    };
  }

  withinHours(startMs: number, durationMin: number): boolean {
    const p = localParts(startMs, this.offsetMin);
    if (!this.config.hours.days.includes(p.dow)) return false;
    const minute = p.hh * 60 + p.mm;
    return minute >= parseHm(this.config.hours.open) && minute + durationMin <= parseHm(this.config.hours.close);
  }

  isFree(staffId: string, start: number, end: number, ignoreHold?: string): boolean {
    const now = this.clock.now();
    for (const b of this.bookings.values()) {
      if (b.status !== 'confirmed' || b.slot.staff_id !== staffId) continue;
      if (overlaps(Date.parse(b.slot.start), Date.parse(b.slot.end), start, end)) return false;
    }
    for (const [id, h] of this.holds) {
      if (h.expires <= now) {
        this.holds.delete(id);
        continue;
      }
      if (id === ignoreHold || h.hold.slot.staff_id !== staffId) continue;
      if (overlaps(Date.parse(h.hold.slot.start), Date.parse(h.hold.slot.end), start, end)) return false;
    }
    return true;
  }

  availability(q: { service_id: string; staff_id?: string; from: string; to: string; limit?: number }): Slot[] {
    const svc = this.service(q.service_id);
    const staffIds = q.staff_id ? [q.staff_id] : this.config.staff.map((s) => s.id);
    if (q.staff_id && !this.config.staff.some((s) => s.id === q.staff_id)) throw new HttpError(404, 'unknown_staff');
    const from = Math.max(Date.parse(q.from), this.clock.now() + MIN_LEAD_MIN * 60_000);
    const to = Date.parse(q.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new HttpError(400, 'bad_window');
    const limit = Math.min(q.limit ?? 20, 50);
    const open = parseHm(this.config.hours.open);
    const close = parseHm(this.config.hours.close);
    const out: Slot[] = [];
    const first = localParts(from, this.offsetMin);
    for (let day = 0; day < 31 && out.length < limit; day++) {
      const dayStart = localToMs(first.y, first.m, first.d + day, 0, 0, this.offsetMin);
      if (dayStart >= to) break;
      if (!this.config.hours.days.includes(localParts(dayStart, this.offsetMin).dow)) continue;
      for (let minute = open; minute + svc.duration_min <= close; minute += SLOT_STEP_MIN) {
        const start = dayStart + minute * 60_000;
        if (start < from || start >= to) continue;
        for (const staffId of staffIds) {
          if (this.isFree(staffId, start, start + svc.duration_min * 60_000)) {
            out.push(this.makeSlot(staffId, svc.id, start));
            if (out.length >= limit) return out;
          }
        }
      }
    }
    return out;
  }

  // ------------------------------------------------------------ holds and bookings

  createHold(slotId: string, owner: string): Hold {
    const { staff_id, service_id, start } = this.decodeSlotId(slotId);
    const svc = this.service(service_id);
    if (!this.config.staff.some((s) => s.id === staff_id)) throw new HttpError(404, 'unknown_staff');
    const end = start + svc.duration_min * 60_000;
    const now = this.clock.now();
    if (start < now || !this.withinHours(start, svc.duration_min) || !this.isFree(staff_id, start, end)) {
      throw new HttpError(409, 'slot_unavailable');
    }
    const expires = now + this.config.policies.hold_ttl_s * 1000;
    const hold: Hold = {
      hold_id: randomId('hold'),
      slot: this.makeSlot(staff_id, service_id, start),
      expires_at: new Date(expires).toISOString(),
    };
    this.holds.set(hold.hold_id, { hold, owner, expires });
    return hold;
  }

  takeHold(holdId: string, owner: string): HoldRecord {
    const rec = this.holds.get(holdId);
    if (!rec || rec.owner !== owner) throw new HttpError(404, 'unknown_hold');
    if (rec.expires <= this.clock.now()) {
      this.holds.delete(holdId);
      throw new HttpError(410, 'hold_expired');
    }
    this.holds.delete(holdId);
    return rec;
  }

  createBooking(
    holdId: string,
    owner: string,
    customer: { display_name: string; contact?: string },
    meta: { channel: Booking['channel']; session?: Session; payment_token?: string },
  ): { booking: Booking; receipt: string } {
    const rec = this.holds.get(holdId);
    if (!rec || rec.owner !== owner) throw new HttpError(404, 'unknown_hold');
    const svc = this.service(rec.hold.slot.service_id);
    if (meta.session) this.checkSpend(meta.session, svc.price, meta.payment_token);
    this.takeHold(holdId, owner);
    const nowIso = new Date(this.clock.now()).toISOString();
    const booking: Booking = {
      booking_id: randomId('bk'),
      status: 'confirmed',
      slot: rec.hold.slot,
      customer,
      price: svc.price,
      currency: this.config.currency,
      channel: meta.channel,
      agent_id: meta.session?.agent.agent_id,
      principal: meta.session?.mandate.sub,
      created_at: nowIso,
      updated_at: nowIso,
    };
    this.bookings.set(booking.booking_id, booking);
    const receipt = this.receipt('booked', booking, 0, meta.session);
    this.events.emit('booked', { booking, session_id: meta.session?.session_id });
    return { booking, receipt };
  }

  checkSpend(session: Session, price: number, paymentToken?: string): void {
    const limit = session.mandate.max_amount;
    if (limit && (limit.currency !== this.config.currency || price > limit.value)) {
      throw new HttpError(403, 'over_mandate_limit');
    }
    const { required, amount } = this.config.policies.deposit;
    const needsDeposit = required === 'all' || (required === 'self-asserted' && session.trust === 'self-asserted');
    if (needsDeposit && !paymentToken) {
      throw new HttpError(402, 'deposit_required', 'a deposit is required for this booking', {
        amount,
        currency: this.config.currency,
      });
    }
  }

  feeFor(booking: Booking): number {
    const hoursUntil = (Date.parse(booking.slot.start) - this.clock.now()) / 3_600_000;
    const { free_until_h, late_fee } = this.config.policies.cancellation;
    return hoursUntil < free_until_h ? late_fee : 0;
  }

  ownBooking(bookingId: string, principal: string | undefined): Booking {
    const b = this.bookings.get(bookingId);
    if (!b) throw new HttpError(404, 'unknown_booking');
    if (principal !== undefined && b.principal !== principal) throw new HttpError(403, 'forbidden');
    return b;
  }

  async modifyBooking(
    bookingId: string,
    newHoldId: string,
    owner: string,
    session?: Session,
  ): Promise<{ booking: Booking; fee: number; receipt: string }> {
    const b = this.ownBooking(bookingId, session?.mandate.sub);
    if (b.status !== 'confirmed') throw new HttpError(409, 'not_confirmed');
    const rec = this.takeHold(newHoldId, owner);
    const fee = this.feeFor(b);
    const freed = b.slot;
    b.slot = rec.hold.slot;
    b.price = this.service(rec.hold.slot.service_id).price;
    b.updated_at = new Date(this.clock.now()).toISOString();
    const receipt = this.receipt('modified', b, fee, session);
    await this.notifyWaitlist(freed);
    return { booking: b, fee, receipt };
  }

  async cancelBooking(bookingId: string, session?: Session): Promise<{ booking: Booking; fee: number; receipt: string }> {
    const b = this.ownBooking(bookingId, session?.mandate.sub);
    if (b.status !== 'confirmed') throw new HttpError(409, 'not_confirmed');
    const fee = this.feeFor(b);
    b.status = 'cancelled';
    b.updated_at = new Date(this.clock.now()).toISOString();
    const receipt = this.receipt('cancelled', b, fee, session);
    await this.notifyWaitlist(b.slot);
    return { booking: b, fee, receipt };
  }

  receipt(action: Receipt['action'], b: Booking, fee: number, session?: Session): string {
    const r: Receipt = {
      typ: 'cp.receipt',
      action,
      booking_id: b.booking_id,
      business_id: this.config.business_id,
      slot: b.slot,
      price: b.price,
      currency: b.currency,
      fee,
      agent_id: session?.agent.agent_id,
      session_id: session?.session_id,
      iat: nowSeconds(this.clock),
    };
    return signJws(r, this.keys);
  }

  // ------------------------------------------------------------ waitlist and offers

  joinWaitlist(
    owner: string,
    q: { service_id: string; staff_id?: string; from: string; to: string; callback_url: string },
  ): WaitEntry {
    this.service(q.service_id);
    const entry: WaitEntry = {
      waitlist_id: randomId('wl'),
      owner,
      service_id: q.service_id,
      staff_id: q.staff_id,
      from: Date.parse(q.from),
      to: Date.parse(q.to),
      callback_url: q.callback_url,
      active: true,
    };
    if (!Number.isFinite(entry.from) || !Number.isFinite(entry.to)) throw new HttpError(400, 'bad_window');
    this.waitlist.set(entry.waitlist_id, entry);
    return entry;
  }

  /** Broadcasts a freed slot to every matching waitlist entry; the first claim wins. */
  async notifyWaitlist(freed: Slot): Promise<void> {
    const start = Date.parse(freed.start);
    const room = Date.parse(freed.end) - start;
    const matches = [...this.waitlist.values()].filter(
      (w) =>
        w.active &&
        (!w.staff_id || w.staff_id === freed.staff_id) &&
        start >= w.from &&
        start < w.to &&
        this.service(w.service_id).duration_min * 60_000 <= room,
    );
    const byService = new Map<string, WaitEntry[]>();
    for (const w of matches) byService.set(w.service_id, [...(byService.get(w.service_id) ?? []), w]);
    const sends: Promise<unknown>[] = [];
    for (const [serviceId, entries] of byService) {
      const slot = this.makeSlot(freed.staff_id, serviceId, start);
      const expires = this.clock.now() + OFFER_TTL_MS;
      const offer: Offer = {
        typ: 'cp.offer',
        offer_id: randomId('of'),
        business_id: this.config.business_id,
        slot,
        expires_at: new Date(expires).toISOString(),
        iat: nowSeconds(this.clock),
      };
      this.offers.set(offer.offer_id, {
        offer,
        owners: new Set(entries.map((e) => e.owner)),
        waitlist_ids: entries.map((e) => e.waitlist_id),
        expires,
      });
      const signed = signJws(offer, this.keys);
      for (const e of entries) {
        sends.push(this.http.request({ to: 'agent', method: 'POST', url: e.callback_url, body: { offer: signed } }));
      }
    }
    await Promise.allSettled(sends);
  }

  claimOffer(offerId: string, owner: string): Hold {
    const rec = this.offers.get(offerId);
    if (!rec) throw new HttpError(404, 'unknown_offer');
    if (!rec.owners.has(owner)) throw new HttpError(403, 'not_offered');
    if (rec.claimed_by) throw new HttpError(409, 'offer_taken');
    if (rec.expires <= this.clock.now()) throw new HttpError(410, 'offer_expired');
    const hold = this.createHold(rec.offer.slot.slot_id, owner);
    rec.claimed_by = owner;
    for (const id of rec.waitlist_ids) {
      const w = this.waitlist.get(id);
      if (w && w.owner === owner) w.active = false;
    }
    return hold;
  }

  // ------------------------------------------------------------ handshake (business side)

  async enroll(registryUrl: string): Promise<void> {
    this.registryUrl = registryUrl;
    await this.http.request({
      to: 'registry',
      method: 'POST',
      url: `${registryUrl}${API_PREFIX}/businesses`,
      body: { business_id: this.config.business_id, tel: this.config.tel, api: this.api, jwk: this.keys.publicJwk },
    });
  }

  /** Called by the receptionist when it decides to OFFER; returns what goes into the DTMF frame. */
  async requestRendezvous(onTrace?: (t: NetTrace) => void): Promise<{ registry_id: string; code: string; session_id: string }> {
    const client = createClient('callee', onTrace);
    const request = signJws({ business_id: this.config.business_id, iat: nowSeconds(this.clock) }, this.keys);
    const res = await client.request<{ registry_id: string; code: string; session_id: string; expires_at: string }>({
      to: 'registry',
      method: 'POST',
      url: `${this.registryUrl}${API_PREFIX}/rendezvous`,
      body: { request },
    });
    this.handshakes.set(res.session_id, {
      session_id: res.session_id,
      code: res.code,
      expires_at: Date.parse(res.expires_at),
      accepted: false,
    });
    return res;
  }

  async operatorJwk(operatorId: string): Promise<PublicJwk | undefined> {
    if (this.operatorKeys.has(operatorId)) return this.operatorKeys.get(operatorId) ?? undefined;
    try {
      const res = await this.http.request<{ jwk: PublicJwk }>({
        to: 'registry',
        method: 'GET',
        url: `${this.registryUrl}${API_PREFIX}/operators/${encodeURIComponent(operatorId)}`,
      });
      this.operatorKeys.set(operatorId, res.jwk);
      return res.jwk;
    } catch {
      this.operatorKeys.set(operatorId, null);
      return undefined;
    }
  }

  /** Verifies the caller's proof-of-possession and mandate (spec/commit.md §3). */
  async verifyAgent(
    body: Record<string, unknown>,
    sessionId: string | undefined,
  ): Promise<{ agent: AgentIdentity; trust: Trust; mandate: Mandate }> {
    const caller = obj(body, 'caller');
    const agent: AgentIdentity = {
      agent_id: str(caller, 'agent_id'),
      operator: str(caller, 'operator'),
      jwk: obj(caller, 'jwk') as unknown as PublicJwk,
    };
    const nowMs = this.clock.now();
    try {
      const proof = verifyJws<Proof>(str(body, 'proof'), agent.jwk, { nowMs });
      if (proof.typ !== 'cp.proof' || proof.aud !== this.config.business_id) throw new Error('aud');
      if (sessionId !== undefined && proof.session_id !== sessionId) throw new Error('session');
      if (Math.abs(nowSeconds(this.clock) - proof.iat) > PROOF_SKEW_S) throw new Error('stale');
    } catch {
      throw new HttpError(401, 'bad_proof');
    }
    const mandateJws = str(body, 'mandate');
    let mandate: Mandate;
    let trust: Trust;
    try {
      const { header, payload } = decodeJws(mandateJws);
      const operatorKey = typeof payload.iss === 'string' ? await this.operatorJwk(payload.iss) : undefined;
      if (operatorKey && header.kid === (operatorKey.kid ?? thumbprint(operatorKey))) {
        mandate = verifyJws<Mandate>(mandateJws, operatorKey, { nowMs });
        trust = 'operator-verified';
      } else {
        mandate = verifyJws<Mandate>(mandateJws, agent.jwk, { nowMs });
        trust = 'self-asserted';
      }
    } catch {
      throw new HttpError(401, 'bad_mandate');
    }
    if (
      mandate.typ !== 'cp.mandate' ||
      mandate.agent_id !== agent.agent_id ||
      mandate.cnf?.jkt !== thumbprint(agent.jwk) ||
      !Array.isArray(mandate.scope)
    ) {
      throw new HttpError(401, 'bad_mandate');
    }
    return { agent, trust, mandate };
  }

  async acceptHandshake(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sessionId = str(body, 'session_id');
    const hs = this.handshakes.get(sessionId);
    if (!hs || hs.expires_at <= this.clock.now()) throw new HttpError(404, 'unknown_session');
    if (hs.accepted) throw new HttpError(409, 'session_already_accepted');
    const { agent, trust, mandate } = await this.verifyAgent(body, sessionId);
    hs.accepted = true;
    const session: Session = {
      token: randomToken(),
      via: 'handshake',
      session_id: sessionId,
      agent,
      trust,
      mandate,
      bound: false,
      bind_code: randomDigits(6),
      bind_deadline: this.clock.now() + BIND_WINDOW_MS,
      bind_attempts: 0,
      expires_at: this.clock.now() + SESSION_TTL_MS,
    };
    this.sessions.set(session.token, session);
    this.sessionByHandshake.set(sessionId, session.token);
    this.events.emit('handshake_accepted', { session_id: sessionId, trust });
    return {
      session_token: session.token,
      bind_code: session.bind_code,
      bind_deadline: new Date(session.bind_deadline ?? 0).toISOString(),
      expires_at: new Date(session.expires_at).toISOString(),
      trust,
    };
  }

  /** Called by the receptionist when it hears a BIND frame on the call (channel binding). */
  bindHandshake(sessionId: string, bindCode: string): boolean {
    const s = this.sessions.get(this.sessionByHandshake.get(sessionId) ?? '');
    if (!s || s.bound) return false;
    if ((s.bind_deadline ?? 0) <= this.clock.now()) {
      this.sessions.delete(s.token);
      return false;
    }
    if (s.bind_code !== bindCode) {
      s.bind_attempts += 1;
      if (s.bind_attempts >= 3) this.sessions.delete(s.token);
      return false;
    }
    s.bound = true;
    this.events.emit('bound', { session_id: sessionId });
    return true;
  }

  async createDirectSession(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { agent, trust, mandate } = await this.verifyAgent(body, undefined);
    const session: Session = {
      token: randomToken(),
      via: 'direct',
      session_id: randomId('ds'),
      agent,
      trust,
      mandate,
      bound: true,
      bind_attempts: 0,
      expires_at: this.clock.now() + SESSION_TTL_MS,
    };
    this.sessions.set(session.token, session);
    return {
      session_token: session.token,
      session_id: session.session_id,
      expires_at: new Date(session.expires_at).toISOString(),
      trust,
    };
  }

  auth(req: Request, opts: { bound?: boolean; scope?: string } = {}): Session {
    const header = req.headers.authorization;
    const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
    const s = this.sessions.get(token);
    if (!s || s.expires_at <= this.clock.now()) throw new HttpError(401, 'unauthorized');
    if (opts.bound && !s.bound) throw new HttpError(403, 'not_bound');
    if (opts.scope && !s.mandate.scope.includes(opts.scope)) throw new HttpError(403, 'insufficient_scope');
    return s;
  }

  // ------------------------------------------------------------ HTTP surface

  router(): Router {
    const r = new Router();
    const p = API_PREFIX;
    r.on('GET', '/.well-known/cp-card.json', () => json(this.card()));
    r.on('GET', `${p}/card`, () => json(this.card()));
    r.on('POST', `${p}/handshake/accept`, async (req) => json(await this.acceptHandshake(req.body), 201));
    r.on('POST', `${p}/sessions`, async (req) => json(await this.createDirectSession(req.body), 201));
    r.on('GET', `${p}/session`, (req) => {
      const s = this.auth(req);
      return json({ session_id: s.session_id, bound: s.bound, trust: s.trust, agent_id: s.agent.agent_id });
    });
    r.on('POST', `${p}/availability`, (req) => {
      this.auth(req);
      const slots = this.availability({
        service_id: str(req.body, 'service_id'),
        staff_id: optStr(req.body, 'staff_id'),
        from: str(req.body, 'from'),
        to: str(req.body, 'to'),
        limit: typeof req.body.limit === 'number' ? req.body.limit : undefined,
      });
      return json({ slots });
    });
    r.on('POST', `${p}/holds`, (req) => {
      const s = this.auth(req, { bound: true, scope: SCOPES.create });
      return json(this.createHold(str(req.body, 'slot_id'), s.token), 201);
    });
    r.on('DELETE', `${p}/holds/:id`, (req) => {
      const s = this.auth(req);
      this.takeHold(req.params.id, s.token);
      return json({ ok: true });
    });
    r.on('POST', `${p}/bookings`, (req) => {
      const s = this.auth(req, { bound: true, scope: SCOPES.create });
      const customer = obj(req.body, 'customer');
      const out = this.createBooking(
        str(req.body, 'hold_id'),
        s.token,
        { display_name: str(customer, 'display_name'), contact: optStr(customer, 'contact') },
        { channel: 'agent', session: s, payment_token: optStr(req.body, 'payment_token') },
      );
      return json(out, 201);
    });
    r.on('GET', `${p}/bookings/:id`, (req) => {
      const s = this.auth(req);
      return json({ booking: this.ownBooking(req.params.id, s.mandate.sub) });
    });
    r.on('POST', `${p}/bookings/:id/modify`, async (req) => {
      const s = this.auth(req, { bound: true, scope: SCOPES.modify });
      return json(await this.modifyBooking(req.params.id, str(req.body, 'hold_id'), s.token, s));
    });
    r.on('POST', `${p}/bookings/:id/cancel`, async (req) => {
      const s = this.auth(req, { bound: true, scope: SCOPES.cancel });
      return json(await this.cancelBooking(req.params.id, s));
    });
    r.on('POST', `${p}/waitlist`, (req) => {
      const s = this.auth(req, { bound: true, scope: SCOPES.waitlist });
      const w = this.joinWaitlist(s.token, {
        service_id: str(req.body, 'service_id'),
        staff_id: optStr(req.body, 'staff_id'),
        from: str(req.body, 'from'),
        to: str(req.body, 'to'),
        callback_url: str(req.body, 'callback_url'),
      });
      return json({ waitlist_id: w.waitlist_id }, 201);
    });
    r.on('POST', `${p}/offers/:id/claim`, (req) => {
      const s = this.auth(req, { bound: true, scope: SCOPES.create });
      return json(this.claimOffer(req.params.id, s.token), 201);
    });
    r.on('POST', `${p}/handoff`, (req) => {
      this.auth(req);
      return json(
        { ticket_id: randomId('ho'), message: 'A staff member will follow up.', reason: optStr(req.body, 'reason') },
        201,
      );
    });
    return r;
  }
}
