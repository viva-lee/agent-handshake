// The sandbox behind the MCP server: a registry and the two demo shops on random localhost ports.
import { Business } from '../business/business.ts';
import { generateKeyPair } from '../crypto/jws.ts';
import { demoFixture, seedBookings } from '../demo/fixtures.ts';
import { listen, type Listening } from '../net/http.ts';
import { API_PREFIX } from '../protocol/types.ts';
import { Registry } from '../registry/registry.ts';
import type { Operator, RegistryRef } from './counter.ts';

export interface Sandbox {
  registry: RegistryRef;
  operator: Operator;
  shops: { name: string; tel: string }[];
  close(): Promise<void>;
}

export async function startSandbox(): Promise<Sandbox> {
  const registry = new Registry({ registryId: '0' });
  const registrySrv = await listen(registry.router());
  const servers: Listening[] = [registrySrv];
  const operator = { id: 'demo-operator', keys: generateKeyPair() };
  registry.registerOperator(operator.id, operator.keys.publicJwk);

  const shops = [];
  for (const lang of ['en', 'ko'] as const) {
    const fx = demoFixture(lang);
    const business = new Business(fx.config);
    const srv = await listen(business.router());
    servers.push(srv);
    business.api = `${srv.url}${API_PREFIX}`;
    await business.enroll(registrySrv.url);
    seedBookings(business, fx);
    shops.push({ name: fx.config.name, tel: fx.config.tel });
  }

  return {
    registry: { url: registrySrv.url, jwk: registry.keys.publicJwk },
    operator,
    shops,
    close: async () => {
      for (const s of servers) await s.close();
    },
  };
}
