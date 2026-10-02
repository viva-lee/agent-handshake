import { CustomerAgent, type CustomerAgentOptions } from '../src/agents/customer-agent.ts';
import { Business, type BusinessConfig } from '../src/business/business.ts';
import { generateKeyPair } from '../src/crypto/jws.ts';
import { demoFixture, seedBookings } from '../src/demo/fixtures.ts';
import { listen, Router, json, type Listening } from '../src/net/http.ts';
import { API_PREFIX, type Lang } from '../src/protocol/types.ts';
import { systemClock, type Clock } from '../src/protocol/util.ts';
import { Registry } from '../src/registry/registry.ts';

export interface FakeClock extends Clock {
  t: number;
  advance(ms: number): void;
}

export function fakeClock(iso: string): FakeClock {
  const clock = {
    t: Date.parse(iso),
    now: () => clock.t,
    advance: (ms: number) => {
      clock.t += ms;
    },
  };
  return clock;
}

export async function setup(opts: { clock?: Clock; lang?: Lang; policies?: Partial<BusinessConfig['policies']> } = {}) {
  const clock = opts.clock ?? systemClock;
  const lang = opts.lang ?? 'en';
  const registry = new Registry({ clock });
  const registrySrv = await listen(registry.router());
  const fx = demoFixture(lang, clock.now());
  if (opts.policies) fx.config.policies = { ...fx.config.policies, ...opts.policies };
  const business = new Business(fx.config, { clock });
  const businessSrv = await listen(business.router());
  business.api = `${businessSrv.url}${API_PREFIX}`;
  await business.enroll(registrySrv.url);
  seedBookings(business, fx);
  const operator = { id: 'test-operator', keys: generateKeyPair() };
  registry.registerOperator(operator.id, operator.keys.publicJwk);

  const agent = (overrides: Partial<CustomerAgentOptions> = {}) =>
    new CustomerAgent({
      lang,
      kind: 'cp-agent',
      principal: fx.principal,
      request: fx.request,
      dialed: fx.config.tel,
      registries: { '0': { url: registrySrv.url, jwk: registry.keys.publicJwk } },
      operator,
      clock,
      ...overrides,
    });

  return {
    clock,
    registry,
    business,
    fx,
    operator,
    agent,
    registryUrl: registrySrv.url,
    close: async () => {
      await businessSrv.close();
      await registrySrv.close();
    },
  };
}

/** A local HTTP endpoint that records offers POSTed to it. */
export async function offerInbox(): Promise<Listening & { received: string[] }> {
  const received: string[] = [];
  const r = new Router().on('POST', '/offers', (req) => {
    received.push(String(req.body.offer));
    return json({ ok: true });
  });
  const srv = await listen(r);
  return { ...srv, url: `${srv.url}/offers`, received };
}
