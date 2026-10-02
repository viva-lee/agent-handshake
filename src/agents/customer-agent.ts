// The caller: a personal agent (or a scripted human) phoning a business on behalf of a principal.
import { generateKeyPair, signJws, thumbprint, verifyJws, type KeyPair, type PublicJwk } from '../crypto/jws.ts';
import { createClient, type HttpClient, type NetTrace } from '../net/http.ts';
import { decodeFrames, encodeFrame, type Frame } from '../protocol/dtmf.ts';
import {
  API_PREFIX,
  SCOPES,
  type AgentIdentity,
  type Booking,
  type BusinessCard,
  type Hold,
  type Lang,
  type LookupRecord,
  type Mandate,
  type Proof,
  type Receipt,
  type RendezvousRecord,
  type Slot,
} from '../protocol/types.ts';
import { normalizeTel, randomId, systemClock, type Clock } from '../protocol/util.ts';
import { PHRASES, type Phrases } from './phrases.ts';
import type { CallEvent, Line, Participant } from './sim-call.ts';

export type CallerKind = 'cp-agent' | 'ai-agent' | 'human';

export interface BookingRequest {
  service_id: string; // what a real NLU stack would resolve; used on the voice path
  service_label: string; // what the principal said; matched against the card on the API path
  when_label: string;
  date: string; // local YYYY-MM-DD
  after: string; // local HH:MM
  before: string;
  from_iso: string;
  to_iso: string;
}

export interface CustomerAgentOptions {
  lang: Lang;
  kind: CallerKind;
  principal: { id: string; display_name: string; contact: string };
  request: BookingRequest;
  dialed: string;
  registries: Record<string, { url: string; jwk: PublicJwk }>;
  operator: { id: string; keys: KeyPair };
  onTrace?: (t: NetTrace) => void;
  clock?: Clock;
}

export interface AgentResult {
  booking: Booking;
  receipt: Receipt;
  receipt_verified: boolean;
}

export class CustomerAgent implements Participant {
  opts: CustomerAgentOptions;
  p: Phrases;
  http: HttpClient;
  keys: KeyPair = generateKeyPair();
  agentId = randomId('agent');
  state: 'start' | 'handshaking' | 'done' | 'voice' = 'start';
  result?: AgentResult;
  failure?: string;

  constructor(opts: CustomerAgentOptions) {
    this.opts = opts;
    this.p = PHRASES[opts.lang];
    this.http = createClient('caller', (t) => this.opts.onTrace?.(t));
  }

  // ------------------------------------------------------------ voice side

  async onEvent(e: CallEvent, line: Line): Promise<void> {
    if (e.kind === 'dtmf') {
      if (this.opts.kind !== 'cp-agent' || this.state !== 'start') return; // others ignore the tones
      const offer = decodeFrames(e.digits).find((f) => f.type === 'offer');
      if (offer) await this.handshake(offer, line);
      return;
    }
    if (e.kind !== 'speech') return;
    const m = e.meta;
    const { principal } = this.opts;
    switch (m.intent) {
      case 'greet':
        await this.onGreet(line);
        return;
      case 'ask_how':
        this.state = 'voice';
        await this.sayRequest(line, false);
        return;
      case 'propose': {
        this.state = 'voice';
        const options = m.options as { slot_id: string; label: string }[];
        await line.say(this.p.choose(options[0].label), { intent: 'choose', slot_id: options[0].slot_id });
        return;
      }
      case 'ask_name':
        await line.say(this.p.name(principal.display_name), { intent: 'name', name: principal.display_name });
        return;
      case 'ask_phone':
        await line.say(this.p.phone(principal.contact), { intent: 'phone', phone: principal.contact });
        return;
      case 'confirm':
        await line.say(this.p.noMore, { intent: 'bye' });
        return;
      case 'summary':
      case 'no_slots':
        await line.hangup();
        return;
    }
  }

  async onGreet(line: Line): Promise<void> {
    const { kind, principal } = this.opts;
    if (kind === 'human') {
      await this.sayRequest(line, false);
      return;
    }
    if (kind === 'ai-agent') {
      await this.sayRequest(line, true);
      return;
    }
    // A CP agent discloses first; a CP receptionist answers with an OFFER right away.
    await line.say(this.p.disclose(principal.display_name), { intent: 'disclose', is_ai: true });
    if (this.state === 'start' && !line.ended) await line.dtmf(encodeFrame({ type: 'probe' }));
    if (this.state === 'start' && !line.ended) {
      this.state = 'voice';
      await this.sayRequest(line, false);
    }
  }

  async sayRequest(line: Line, withDisclosure: boolean): Promise<void> {
    const { request, principal, kind } = this.opts;
    const text =
      kind === 'human'
        ? this.p.requestHuman(request.service_label, request.when_label)
        : `${withDisclosure ? `${this.p.disclose(principal.display_name)} ` : ''}${this.p.request(request.service_label, request.when_label)}`;
    await line.say(text, {
      intent: 'request',
      is_ai: kind !== 'human',
      service_id: request.service_id,
      from: request.from_iso,
      to: request.to_iso,
    });
  }

  // ------------------------------------------------------------ CP-Handshake (caller side)

  async handshake(offer: Extract<Frame, { type: 'offer' }>, line: Line): Promise<void> {
    this.state = 'handshaking';
    try {
      const registry = this.opts.registries[offer.registry];
      if (!registry) throw new Error('unknown_registry');
      const { record } = await this.http.request<{ record: string }>({
        to: 'registry',
        method: 'GET',
        url: `${registry.url}${API_PREFIX}/rendezvous/${offer.code}`,
      });
      const rv = verifyJws<RendezvousRecord>(record, registry.jwk, { nowMs: this.nowMs() });
      if (rv.typ !== 'cp.rendezvous' || rv.code !== offer.code) throw new Error('bad_record');
      // The record must describe the number we actually dialed (spec/handshake.md §7.1).
      if (normalizeTel(rv.tel) !== normalizeTel(this.opts.dialed)) throw new Error('tel_mismatch');
      const accept = await this.http.request<{ session_token: string; bind_code: string }>({
        to: 'business',
        method: 'POST',
        url: `${rv.api}/handshake/accept`,
        body: {
          session_id: rv.session_id,
          caller: this.identity(),
          mandate: this.mandate(),
          proof: this.proof(rv.business_id, rv.session_id),
        },
      });
      // Channel binding: prove the party on the API is the party on the phone.
      await line.dtmf(encodeFrame({ type: 'bind', bindCode: accept.bind_code }));
      this.result = await this.transact(rv.api, accept.session_token, rv.business_jwk);
      this.state = 'done';
    } catch (err) {
      this.failure = (err as Error).message;
      this.state = 'voice';
      if (!line.ended) await this.sayRequest(line, false);
    }
  }

  /** Discovery without a phone call: look the number up in a registry and open a direct session. */
  async bookDirect(registryId: string, tel: string): Promise<AgentResult> {
    const registry = this.opts.registries[registryId];
    if (!registry) throw new Error('unknown_registry');
    const { record } = await this.http.request<{ record: string }>({
      to: 'registry',
      method: 'GET',
      url: `${registry.url}${API_PREFIX}/lookup?tel=${encodeURIComponent(tel)}`,
    });
    const rec = verifyJws<LookupRecord>(record, registry.jwk, { nowMs: this.nowMs() });
    if (rec.typ !== 'cp.lookup' || normalizeTel(rec.tel) !== normalizeTel(tel)) throw new Error('bad_record');
    const session = await this.http.request<{ session_token: string }>({
      to: 'business',
      method: 'POST',
      url: `${rec.api}/sessions`,
      body: { caller: this.identity(), mandate: this.mandate(), proof: this.proof(rec.business_id) },
    });
    this.result = await this.transact(rec.api, session.session_token, rec.business_jwk);
    this.state = 'done';
    return this.result;
  }

  async transact(api: string, token: string, businessJwk: PublicJwk): Promise<AgentResult> {
    const { request, principal } = this.opts;
    const card = await this.http.request<BusinessCard>({ to: 'business', method: 'GET', url: `${api}/card`, token });
    const wanted = request.service_label.toLowerCase();
    const service = card.services.find((s) => s.name.toLowerCase() === wanted) ?? card.services.find((s) => s.id === request.service_id);
    if (!service) throw new Error('unknown_service');
    const { slots } = await this.http.request<{ slots: Slot[] }>({
      to: 'business',
      method: 'POST',
      url: `${api}/availability`,
      token,
      body: {
        service_id: service.id,
        from: `${request.date}T${request.after}:00${card.utc_offset}`,
        to: `${request.date}T${request.before}:00${card.utc_offset}`,
      },
    });
    if (slots.length === 0) throw new Error('no_slots');
    const hold = await this.http.request<Hold>({
      to: 'business',
      method: 'POST',
      url: `${api}/holds`,
      token,
      body: { slot_id: slots[0].slot_id },
    });
    const out = await this.http.request<{ booking: Booking; receipt: string }>({
      to: 'business',
      method: 'POST',
      url: `${api}/bookings`,
      token,
      body: { hold_id: hold.hold_id, customer: { display_name: principal.display_name, contact: principal.contact } },
    });
    const receipt = verifyJws<Receipt>(out.receipt, businessJwk, { nowMs: this.nowMs() });
    return { booking: out.booking, receipt, receipt_verified: receipt.booking_id === out.booking.booking_id };
  }

  // ------------------------------------------------------------ credentials

  nowMs(): number {
    return (this.opts.clock ?? systemClock).now();
  }

  nowS(): number {
    return Math.floor(this.nowMs() / 1000);
  }

  identity(): AgentIdentity {
    return { agent_id: this.agentId, operator: this.opts.operator.id, jwk: this.keys.publicJwk };
  }

  mandate(): string {
    const iat = this.nowS();
    const m: Mandate = {
      typ: 'cp.mandate',
      iss: this.opts.operator.id,
      sub: this.opts.principal.id,
      agent_id: this.agentId,
      cnf: { jkt: thumbprint(this.keys.publicJwk) },
      scope: [SCOPES.create, SCOPES.modify, SCOPES.cancel, SCOPES.waitlist],
      iat,
      exp: iat + 600,
    };
    return signJws(m, this.opts.operator.keys);
  }

  proof(aud: string, sessionId?: string): string {
    const p: Proof = { typ: 'cp.proof', aud, session_id: sessionId, iat: this.nowS() };
    return signJws(p, this.keys);
  }
}
