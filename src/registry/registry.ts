// Reference rendezvous registry (spec/handshake.md §5).
// Maps short in-band codes to signed business records, and phone numbers to endpoints.
import { decodeJws, generateKeyPair, signJws, verifyJws, type KeyPair, type PublicJwk } from '../crypto/jws.ts';
import { HttpError, Router, json, obj, str } from '../net/http.ts';
import { API_PREFIX, type LookupRecord, type RendezvousRecord } from '../protocol/types.ts';
import { nowSeconds, normalizeTel, randomDigits, randomId, systemClock, type Clock } from '../protocol/util.ts';

interface Enrollment {
  business_id: string;
  tel: string;
  api: string;
  jwk: PublicJwk;
  verified: boolean;
}

interface RendezvousEntry {
  code: string;
  session_id: string;
  business_id: string;
  expires_at: number; // ms
}

export interface RegistryOptions {
  registryId?: string; // single digit carried in OFFER frames
  clock?: Clock;
  codeTtlS?: number;
}

export class Registry {
  registryId: string;
  clock: Clock;
  codeTtlS: number;
  keys: KeyPair = generateKeyPair();
  businesses = new Map<string, Enrollment>();
  byTel = new Map<string, string>();
  rendezvous = new Map<string, RendezvousEntry>();
  operators = new Map<string, PublicJwk>();

  constructor(opts: RegistryOptions = {}) {
    this.registryId = opts.registryId ?? '0';
    this.clock = opts.clock ?? systemClock;
    this.codeTtlS = opts.codeTtlS ?? 120;
  }

  /**
   * Enrollment. A production registry MUST verify control of `tel` (e.g. a verification call)
   * before marking it verified; the reference registry trusts the caller.
   */
  enroll(e: Omit<Enrollment, 'verified'>): void {
    const tel = normalizeTel(e.tel);
    this.businesses.set(e.business_id, { ...e, tel, verified: true });
    this.byTel.set(tel, e.business_id);
  }

  registerOperator(operatorId: string, jwk: PublicJwk): void {
    this.operators.set(operatorId, jwk);
  }

  issueCode(businessId: string): RendezvousEntry {
    if (!this.businesses.has(businessId)) throw new HttpError(404, 'unknown_business');
    let code = randomDigits(10);
    while (this.rendezvous.has(code)) code = randomDigits(10);
    const entry: RendezvousEntry = {
      code,
      session_id: randomId('hs'),
      business_id: businessId,
      expires_at: this.clock.now() + this.codeTtlS * 1000,
    };
    this.rendezvous.set(code, entry);
    return entry;
  }

  resolve(code: string): string {
    const entry = this.rendezvous.get(code);
    if (!entry || entry.expires_at <= this.clock.now()) {
      this.rendezvous.delete(code);
      throw new HttpError(404, 'unknown_code');
    }
    const b = this.businesses.get(entry.business_id);
    if (!b) throw new HttpError(404, 'unknown_business');
    const record: RendezvousRecord = {
      typ: 'cp.rendezvous',
      code,
      session_id: entry.session_id,
      business_id: b.business_id,
      tel: b.tel,
      api: b.api,
      business_jwk: b.jwk,
      iat: nowSeconds(this.clock),
      exp: Math.floor(entry.expires_at / 1000),
    };
    return signJws(record, this.keys);
  }

  lookup(tel: string): string {
    const id = this.byTel.get(normalizeTel(tel));
    const b = id ? this.businesses.get(id) : undefined;
    if (!b) throw new HttpError(404, 'unknown_tel');
    const iat = nowSeconds(this.clock);
    const record: LookupRecord = {
      typ: 'cp.lookup',
      business_id: b.business_id,
      tel: b.tel,
      api: b.api,
      business_jwk: b.jwk,
      iat,
      exp: iat + 300,
    };
    return signJws(record, this.keys);
  }

  router(): Router {
    const r = new Router();
    r.on('GET', `${API_PREFIX}/registry`, () =>
      json({ registry_id: this.registryId, jwk: this.keys.publicJwk }),
    );
    r.on('POST', `${API_PREFIX}/businesses`, (req) => {
      const jwk = obj(req.body, 'jwk') as unknown as PublicJwk;
      this.enroll({ business_id: str(req.body, 'business_id'), tel: str(req.body, 'tel'), api: str(req.body, 'api'), jwk });
      return json({ ok: true }, 201);
    });
    // A business asks for a fresh code at call time; the request is signed with its enrolled key.
    r.on('POST', `${API_PREFIX}/rendezvous`, (req) => {
      const request = str(req.body, 'request');
      const claimed = decodeJws(request).payload.business_id;
      const b = typeof claimed === 'string' ? this.businesses.get(claimed) : undefined;
      if (!b) throw new HttpError(404, 'unknown_business');
      try {
        const p = verifyJws<{ business_id: string; iat: number }>(request, b.jwk, { nowMs: this.clock.now() });
        if (Math.abs(nowSeconds(this.clock) - p.iat) > 120) throw new Error('stale');
      } catch {
        throw new HttpError(401, 'bad_signature');
      }
      const entry = this.issueCode(b.business_id);
      return json(
        {
          registry_id: this.registryId,
          code: entry.code,
          session_id: entry.session_id,
          expires_at: new Date(entry.expires_at).toISOString(),
        },
        201,
      );
    });
    r.on('GET', `${API_PREFIX}/rendezvous/:code`, (req) => json({ record: this.resolve(req.params.code) }));
    r.on('GET', `${API_PREFIX}/lookup`, (req) => json({ record: this.lookup(req.query.get('tel') ?? '') }));
    r.on('GET', `${API_PREFIX}/operators/:id`, (req) => {
      const jwk = this.operators.get(req.params.id);
      if (!jwk) throw new HttpError(404, 'unknown_operator');
      return json({ operator_id: req.params.id, jwk });
    });
    return r;
  }
}
