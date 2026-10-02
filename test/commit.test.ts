import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPair, signJws, thumbprint, verifyJws } from '../src/crypto/jws.ts';
import { ApiError } from '../src/net/http.ts';
import type { Booking, Hold, Offer, Receipt, Slot } from '../src/protocol/types.ts';
import { fakeClock, offerInbox, setup } from './helpers.ts';

type Env = Awaited<ReturnType<typeof setup>>;

/** Opens a direct (no phone call) session for a fresh agent acting for `principal`. */
async function session(env: Env, principal = env.fx.principal) {
  const agent = env.agent({ principal });
  const { record } = await agent.http.request<{ record: string }>({
    to: 'registry',
    method: 'GET',
    url: `${env.registryUrl}/cp/v0.1/lookup?tel=${encodeURIComponent(env.fx.config.tel)}`,
  });
  const api = (JSON.parse(Buffer.from(record.split('.')[1], 'base64url').toString()) as { api: string }).api;
  const s = await agent.http.request<{ session_token: string; trust: string }>({
    to: 'business',
    method: 'POST',
    url: `${api}/sessions`,
    body: { caller: agent.identity(), mandate: agent.mandate(), proof: agent.proof(env.fx.config.business_id) },
  });
  const call = <T>(method: string, path: string, body?: unknown) =>
    agent.http.request<T>({ to: 'business', method, url: `${api}${path}`, token: s.session_token, body });
  return { agent, api, token: s.session_token, trust: s.trust, call };
}

async function book(env: Env, s: Awaited<ReturnType<typeof session>>) {
  const { slots } = await s.call<{ slots: Slot[] }>('POST', '/availability', {
    service_id: 'cut-women',
    from: env.fx.request.from_iso,
    to: env.fx.request.to_iso,
  });
  const hold = await s.call<Hold>('POST', '/holds', { slot_id: slots[0].slot_id });
  return s.call<{ booking: Booking; receipt: string }>('POST', '/bookings', {
    hold_id: hold.hold_id,
    customer: { display_name: 'Test' },
  });
}

test('direct session: discover by phone number, book, verify the receipt', async () => {
  const env = await setup();
  try {
    const result = await env.agent().bookDirect('0', env.fx.config.tel);
    assert.equal(result.receipt_verified, true);
    assert.equal(result.receipt.action, 'booked');
    assert.equal(result.booking.slot.staff_id, 'kim');
    assert.match(result.booking.slot.start, /T14:00:00/);
  } finally {
    await env.close();
  }
});

test('a held slot is not offered to anyone else', async () => {
  const env = await setup();
  try {
    const a = await session(env);
    const b = await session(env, { ...env.fx.principal, id: 'principal_b' });
    const q = { service_id: 'cut-women', staff_id: 'kim', from: env.fx.request.from_iso, to: env.fx.request.to_iso };
    const before = await a.call<{ slots: Slot[] }>('POST', '/availability', q);
    await a.call<Hold>('POST', '/holds', { slot_id: before.slots[0].slot_id });
    const after = await b.call<{ slots: Slot[] }>('POST', '/availability', q);
    assert.notEqual(after.slots[0].slot_id, before.slots[0].slot_id);
    await assert.rejects(
      b.call('POST', '/holds', { slot_id: before.slots[0].slot_id }),
      (e: ApiError) => e.status === 409 && e.code === 'slot_unavailable',
    );
  } finally {
    await env.close();
  }
});

test('freed slots are offered to the waitlist and the first claim wins', async () => {
  const env = await setup();
  const inboxA = await offerInbox();
  const inboxB = await offerInbox();
  try {
    const owner = await session(env);
    const { booking } = await book(env, owner);
    const a = await session(env, { ...env.fx.principal, id: 'principal_a' });
    const b = await session(env, { ...env.fx.principal, id: 'principal_b' });
    const window = { service_id: 'cut-women', from: env.fx.request.from_iso, to: env.fx.request.to_iso };
    await a.call('POST', '/waitlist', { ...window, callback_url: inboxA.url });
    await b.call('POST', '/waitlist', { ...window, callback_url: inboxB.url });

    await owner.call('POST', `/bookings/${booking.booking_id}/cancel`);
    assert.equal(inboxA.received.length, 1);
    assert.equal(inboxB.received.length, 1);
    const offer = verifyJws<Offer>(inboxA.received[0], env.business.keys.publicJwk);
    assert.equal(offer.slot.start, booking.slot.start);

    const hold = await a.call<Hold>('POST', `/offers/${offer.offer_id}/claim`);
    assert.equal(hold.slot.start, booking.slot.start);
    await assert.rejects(
      b.call('POST', `/offers/${offer.offer_id}/claim`),
      (e: ApiError) => e.status === 409 && e.code === 'offer_taken',
    );
  } finally {
    await inboxA.close();
    await inboxB.close();
    await env.close();
  }
});

test('cancellation fee follows the policy window', async () => {
  const clock = fakeClock('2026-09-28T03:00:00Z'); // Monday; the demo Saturday is 2026-10-03
  const env = await setup({ clock });
  try {
    const { booking } = await book(env, await session(env));
    const early = await (await session(env)).call<{ fee: number; receipt: string }>(
      'POST',
      `/bookings/${booking.booking_id}/cancel`,
    );
    assert.equal(early.fee, 0);
    assert.equal(verifyJws<Receipt>(early.receipt, env.business.keys.publicJwk, { nowMs: clock.now() }).action, 'cancelled');

    const second = await book(env, await session(env));
    clock.t = Date.parse(second.booking.slot.start) - 2 * 3_600_000; // two hours before
    const late = await (await session(env)).call<{ fee: number }>('POST', `/bookings/${second.booking.booking_id}/cancel`);
    assert.equal(late.fee, env.fx.config.policies.cancellation.late_fee);
  } finally {
    await env.close();
  }
});

test('another principal cannot touch a booking', async () => {
  const env = await setup();
  try {
    const { booking } = await book(env, await session(env));
    const other = await session(env, { ...env.fx.principal, id: 'principal_other' });
    await assert.rejects(
      other.call('POST', `/bookings/${booking.booking_id}/cancel`),
      (e: ApiError) => e.status === 403 && e.code === 'forbidden',
    );
  } finally {
    await env.close();
  }
});

test('self-asserted agents can be asked for a deposit', async () => {
  const env = await setup({ policies: { deposit: { amount: 20, required: 'self-asserted' } } });
  try {
    // An agent whose operator the registry does not know signs its own mandate.
    const keys = generateKeyPair();
    const s = await session(env);
    const agent = env.agent({ operator: { id: 'unknown-operator', keys } });
    agent.keys = keys;
    const selfSigned = await agent.http.request<{ session_token: string; trust: string }>({
      to: 'business',
      method: 'POST',
      url: `${s.api}/sessions`,
      body: { caller: agent.identity(), mandate: agent.mandate(), proof: agent.proof(env.fx.config.business_id) },
    });
    assert.equal(s.trust, 'operator-verified');
    assert.equal(selfSigned.trust, 'self-asserted');

    await book(env, s); // operator-verified: no deposit needed
    const call = <T>(method: string, path: string, body?: unknown) =>
      agent.http.request<T>({ to: 'business', method, url: `${s.api}${path}`, token: selfSigned.session_token, body });
    const { slots } = await call<{ slots: Slot[] }>('POST', '/availability', {
      service_id: 'cut-women',
      from: env.fx.request.from_iso,
      to: env.fx.request.to_iso,
    });
    const hold = await call<Hold>('POST', '/holds', { slot_id: slots[0].slot_id });
    await assert.rejects(
      call('POST', '/bookings', { hold_id: hold.hold_id, customer: { display_name: 'Self' } }),
      (e: ApiError) => e.status === 402 && e.code === 'deposit_required',
    );
  } finally {
    await env.close();
  }
});

test('mandate spending limits are enforced', async () => {
  const env = await setup();
  try {
    const agent = env.agent();
    const iat = Math.floor(Date.now() / 1000);
    const mandate = signJws(
      {
        typ: 'cp.mandate',
        iss: env.operator.id,
        sub: env.fx.principal.id,
        agent_id: agent.agentId,
        cnf: { jkt: thumbprint(agent.keys.publicJwk) },
        scope: ['booking:create'],
        max_amount: { value: 10, currency: 'USD' },
        iat,
        exp: iat + 600,
      },
      env.operator.keys,
    );
    const base = env.business.api;
    const s = await agent.http.request<{ session_token: string }>({
      to: 'business',
      method: 'POST',
      url: `${base}/sessions`,
      body: { caller: agent.identity(), mandate, proof: agent.proof(env.fx.config.business_id) },
    });
    const call = <T>(method: string, path: string, body?: unknown) =>
      agent.http.request<T>({ to: 'business', method, url: `${base}${path}`, token: s.session_token, body });
    const { slots } = await call<{ slots: Slot[] }>('POST', '/availability', {
      service_id: 'cut-women',
      from: env.fx.request.from_iso,
      to: env.fx.request.to_iso,
    });
    const hold = await call<Hold>('POST', '/holds', { slot_id: slots[0].slot_id });
    await assert.rejects(
      call('POST', '/bookings', { hold_id: hold.hold_id, customer: { display_name: 'Capped' } }),
      (e: ApiError) => e.status === 403 && e.code === 'over_mandate_limit',
    );
    await assert.rejects(
      call('POST', '/waitlist', { service_id: 'cut-women', from: env.fx.request.from_iso, to: env.fx.request.to_iso, callback_url: 'http://127.0.0.1:1/x' }),
      (e: ApiError) => e.status === 403 && e.code === 'insufficient_scope',
    );
  } finally {
    await env.close();
  }
});
