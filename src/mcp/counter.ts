// The MCP tools: a caller agent that finds a shop through the registry and books it over CP-Commit,
// on behalf of whoever runs the MCP client. Every record and receipt is signature-checked.
import { decodeJws, generateKeyPair, JwsError, signJws, thumbprint, verifyJws, type KeyPair, type PublicJwk } from '../crypto/jws.ts';
import { ApiError, createClient } from '../net/http.ts';
import {
  API_PREFIX,
  SCOPES,
  type Booking,
  type BusinessCard,
  type Hold,
  type LookupRecord,
  type Mandate,
  type Proof,
  type Receipt,
  type Slot,
} from '../protocol/types.ts';
import { normalizeTel, parseOffset, randomId, toLocalIso } from '../protocol/util.ts';

export interface RegistryRef {
  url: string;
  jwk: PublicJwk;
}

export interface Operator {
  id: string;
  keys: KeyPair;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, boolean>;
}

interface Shop {
  record: LookupRecord;
  card: BusinessCard;
  token: string;
  trust: string;
}

type Args = Record<string, unknown>;

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const HM = /^\d{2}:\d{2}$/;
const str = (description: string) => ({ type: 'string', description });

export const TOOLS: ToolDef[] = [
  {
    name: 'find_business',
    title: 'Find a business by phone number',
    description:
      "Look up a business by its phone number in the Counter registry. The registry's record is signature-checked and must match the number, then an agent session is opened with the business. Returns the business card: services and prices, staff, opening hours, policies, and today's date in the shop's timezone. Call this before the other tools. Sandbox shops: +1-602-555-0123 (Desert Bloom Salon, Phoenix, USD) and +82-2-555-0123 (성수 헤어 스튜디오, Seoul, KRW).",
    inputSchema: {
      type: 'object',
      properties: { tel: str('Phone number in international format, e.g. +1-602-555-0123') },
      required: ['tel'],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'check_availability',
    title: 'Check free slots',
    description: 'List free slots for one service on one day, in the shop\'s local time. Use the business_id from find_business.',
    inputSchema: {
      type: 'object',
      properties: {
        business_id: str('From find_business'),
        service: str('Service id or name from the business card'),
        date: str('Local date, YYYY-MM-DD'),
        after: str('Earliest start, HH:MM local time (default: opening time)'),
        before: str('Latest end, HH:MM local time (default: closing time)'),
        staff: str('Optional staff id or name'),
      },
      required: ['business_id', 'service', 'date'],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'book',
    title: 'Book a slot',
    description:
      'Hold and book a slot from check_availability. Confirm the slot, price and cancellation policy with the user before calling. Returns the booking and a receipt signed by the business; keep the receipt JWS, it is the proof of what was agreed.',
    inputSchema: {
      type: 'object',
      properties: {
        business_id: str('From find_business'),
        slot_id: str('From check_availability'),
        customer_name: str('Name the booking is under'),
        contact: str('Optional phone or email for the shop'),
      },
      required: ['business_id', 'slot_id', 'customer_name'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'cancel_booking',
    title: 'Cancel a booking',
    description: 'Cancel a booking made through this agent. A late-cancellation fee may apply (see the policies on the business card). Returns a signed cancellation receipt.',
    inputSchema: {
      type: 'object',
      properties: { business_id: str('From find_business'), booking_id: str('From book') },
      required: ['business_id', 'booking_id'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: 'verify_receipt',
    title: 'Verify a receipt',
    description: "Check a receipt JWS against the signing key of the business that issued it. Call find_business for that shop first so its key is known.",
    inputSchema: { type: 'object', properties: { receipt: str('Receipt JWS (three base64url parts joined by dots)') }, required: ['receipt'] },
    annotations: { readOnlyHint: true },
  },
];

export class Counter {
  registry: RegistryRef;
  operator: Operator;
  principalId: string;
  http = createClient('agent');
  keys: KeyPair = generateKeyPair();
  agentId = randomId('agent');
  shops = new Map<string, Shop>();

  constructor(registry: RegistryRef, operator: Operator, principalId = 'principal_mcp') {
    this.registry = registry;
    this.operator = operator;
    this.principalId = principalId;
  }

  call(name: string, args: Args): Promise<unknown> {
    switch (name) {
      case 'find_business':
        return this.findBusiness(arg(args, 'tel'));
      case 'check_availability':
        return this.availability(args);
      case 'book':
        return this.book(args);
      case 'cancel_booking':
        return this.cancel(arg(args, 'business_id'), arg(args, 'booking_id'));
      case 'verify_receipt':
        return Promise.resolve(this.verifyReceipt(arg(args, 'receipt')));
      default:
        throw new Error(`unknown tool ${name}`);
    }
  }

  async findBusiness(tel: string) {
    const { record } = await this.http.request<{ record: string }>({
      to: 'registry',
      method: 'GET',
      url: `${this.registry.url}${API_PREFIX}/lookup?tel=${encodeURIComponent(normalizeTel(tel))}`,
    });
    const rec = verifyJws<LookupRecord>(record, this.registry.jwk);
    if (rec.typ !== 'cp.lookup' || normalizeTel(rec.tel) !== normalizeTel(tel)) throw new Error('bad_record: the registry record does not match this number');
    const { card, trust } = await this.open(rec);
    return {
      business_id: card.business_id,
      name: card.name,
      tel: card.tel,
      registry_record: 'signature verified; number matches',
      session_trust: trust,
      today: toLocalIso(Date.now(), parseOffset(card.utc_offset)).slice(0, 10),
      timezone: card.timezone,
      currency: card.currency,
      hours: { open: card.hours.open, close: card.hours.close, days: card.hours.days.map((d) => DAYS[d]) },
      services: card.services,
      staff: card.staff,
      policies: card.policies,
    };
  }

  async availability(args: Args) {
    const id = arg(args, 'business_id');
    const { card } = this.shop(id);
    const service = pick(card.services, arg(args, 'service'), 'service');
    const staff = typeof args.staff === 'string' && args.staff ? pick(card.staff, args.staff, 'staff') : undefined;
    const date = arg(args, 'date');
    const after = typeof args.after === 'string' ? args.after : card.hours.open;
    const before = typeof args.before === 'string' ? args.before : card.hours.close;
    if (!DATE.test(date)) throw new Error('date must be YYYY-MM-DD');
    if (!HM.test(after) || !HM.test(before)) throw new Error('after and before must be HH:MM');
    const { slots } = await this.request<{ slots: Slot[] }>(id, 'POST', '/availability', {
      service_id: service.id,
      staff_id: staff?.id,
      from: `${date}T${after}:00${card.utc_offset}`,
      to: `${date}T${before}:00${card.utc_offset}`,
    });
    return {
      business_id: id,
      service: service.name,
      price: service.price,
      currency: card.currency,
      date,
      slots: slots.map((s) => ({ slot_id: s.slot_id, start: s.start, end: s.end, staff: nameOf(card.staff, s.staff_id) })),
      ...(slots.length === 0 && { note: 'No free slots in that window. Try another time or day.' }),
    };
  }

  async book(args: Args) {
    const id = arg(args, 'business_id');
    const contact = typeof args.contact === 'string' && args.contact ? args.contact : undefined;
    const hold = await this.request<Hold>(id, 'POST', '/holds', { slot_id: arg(args, 'slot_id') });
    const out = await this.request<{ booking: Booking; receipt: string }>(id, 'POST', '/bookings', {
      hold_id: hold.hold_id,
      customer: { display_name: arg(args, 'customer_name'), contact },
    });
    const { card } = this.shop(id);
    return { ...this.summary(card, out.booking), cancellation_policy: card.policies.cancellation, receipt: this.verifyReceipt(out.receipt) };
  }

  async cancel(id: string, bookingId: string) {
    const out = await this.request<{ booking: Booking; fee: number; receipt: string }>(
      id,
      'POST',
      `/bookings/${encodeURIComponent(bookingId)}/cancel`,
      {},
    );
    return { ...this.summary(this.shop(id).card, out.booking), fee: out.fee, receipt: this.verifyReceipt(out.receipt) };
  }

  verifyReceipt(jws: string) {
    let businessId: unknown;
    try {
      businessId = decodeJws(jws).payload.business_id;
    } catch {
      return { verified: false, reason: 'not a JWS' };
    }
    const shop = [...this.shops.values()].find((s) => s.card.business_id === businessId);
    if (!shop) return { verified: false, reason: `unknown business ${String(businessId)}: call find_business for it first` };
    try {
      const r = verifyJws<Receipt>(jws, shop.record.business_jwk);
      if (r.typ !== 'cp.receipt') return { verified: false, reason: 'not a receipt' };
      return {
        verified: true,
        signed_by: `${shop.card.name} (Ed25519)`,
        action: r.action,
        booking_id: r.booking_id,
        start: r.slot.start,
        price: r.price,
        currency: r.currency,
        fee: r.fee,
        agent_id: r.agent_id,
        issued_at: new Date(r.iat * 1000).toISOString(),
        jws,
      };
    } catch (e) {
      if (e instanceof JwsError) return { verified: false, reason: e.message };
      throw e;
    }
  }

  // ------------------------------------------------------------ sessions

  shop(id: string): Shop {
    const shop = this.shops.get(id);
    if (!shop) throw new Error(`unknown business_id ${id}: call find_business first`);
    return shop;
  }

  async open(record: LookupRecord): Promise<Shop> {
    const session = await this.http.request<{ session_token: string; trust: string }>({
      to: 'business',
      method: 'POST',
      url: `${record.api}/sessions`,
      body: { caller: { agent_id: this.agentId, operator: this.operator.id, jwk: this.keys.publicJwk }, mandate: this.mandate(), proof: this.proof(record.business_id) },
    });
    const card = await this.http.request<BusinessCard>({ to: 'business', method: 'GET', url: `${record.api}/card`, token: session.session_token });
    const shop = { record, card, token: session.session_token, trust: session.trust };
    this.shops.set(card.business_id, shop);
    return shop;
  }

  async request<T>(id: string, method: string, path: string, body?: unknown): Promise<T> {
    const send = () => this.http.request<T>({ to: 'business', method, url: `${this.shop(id).record.api}${path}`, token: this.shop(id).token, body });
    try {
      return await send();
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) throw e;
      await this.open(this.shop(id).record); // the session expired: open a new one and retry once
      return send();
    }
  }

  summary(card: BusinessCard, b: Booking) {
    return {
      business: card.name,
      booking_id: b.booking_id,
      status: b.status,
      service: nameOf(card.services, b.slot.service_id),
      staff: nameOf(card.staff, b.slot.staff_id),
      start: b.slot.start,
      end: b.slot.end,
      price: b.price,
      currency: b.currency,
    };
  }

  mandate(): string {
    const iat = Math.floor(Date.now() / 1000);
    const m: Mandate = {
      typ: 'cp.mandate',
      iss: this.operator.id,
      sub: this.principalId,
      agent_id: this.agentId,
      cnf: { jkt: thumbprint(this.keys.publicJwk) },
      scope: [SCOPES.create, SCOPES.modify, SCOPES.cancel, SCOPES.waitlist],
      iat,
      exp: iat + 600,
    };
    return signJws(m, this.operator.keys);
  }

  proof(aud: string): string {
    const p: Proof = { typ: 'cp.proof', aud, iat: Math.floor(Date.now() / 1000) };
    return signJws(p, this.keys);
  }
}

function arg(args: Args, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v) throw new Error(`missing argument: ${key}`);
  return v;
}

function pick<T extends { id: string; name: string }>(list: T[], wanted: string, what: string): T {
  const w = wanted.toLowerCase();
  const found = list.find((x) => x.id.toLowerCase() === w || x.name.toLowerCase() === w);
  if (!found) throw new Error(`unknown ${what} "${wanted}"; choose one of: ${list.map((x) => x.name).join(', ')}`);
  return found;
}

const nameOf = (list: { id: string; name: string }[], id: string) => list.find((x) => x.id === id)?.name ?? id;
