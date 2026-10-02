import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPair, signJws, thumbprint, verifyJws } from '../src/crypto/jws.ts';
import { runScenario } from '../src/demo/scenarios.ts';
import { ApiError, createClient } from '../src/net/http.ts';
import { API_PREFIX, type RendezvousRecord } from '../src/protocol/types.ts';
import { fakeClock, setup } from './helpers.ts';

test('agent-to-agent call completes over the API and is faster than voice', async () => {
  const cp = await runScenario('handshake');
  const human = await runScenario('human');
  assert.equal(cp.outcome.handshake, 'completed');
  assert.equal(cp.outcome.via, 'agent-api');
  assert.equal(cp.outcome.receipt_verified, true);
  assert.deepEqual(
    cp.events.filter((e) => e.channel === 'dtmf').map((e) => e.frame),
    ['OFFER', 'BIND'],
  );
  assert.ok(cp.totals.total_ms < human.totals.total_ms, `${cp.totals.total_ms} < ${human.totals.total_ms}`);
  assert.equal(cp.outcome.booking?.slot.start, human.outcome.booking?.slot.start);
});

test('humans never hear handshake tones', async () => {
  const r = await runScenario('human', { lang: 'ko' });
  assert.equal(r.outcome.handshake, 'not-offered');
  assert.equal(r.events.filter((e) => e.channel === 'dtmf').length, 0);
  assert.equal(r.outcome.via, 'voice');
});

test('an agent that ignores the OFFER still gets booked by voice', async () => {
  const r = await runScenario('ai-no-cp');
  assert.equal(r.outcome.handshake, 'offered-ignored');
  assert.equal(r.outcome.via, 'voice');
  assert.ok(r.outcome.booked);
});

test('caller refuses a rendezvous record for a number it did not dial, then continues by voice', async () => {
  const r = await runScenario('handshake', { dialedOverride: '+1-602-555-0999' });
  assert.equal(r.outcome.handshake, 'failed');
  assert.equal(r.outcome.failure, 'tel_mismatch');
  assert.equal(r.outcome.via, 'voice');
  assert.ok(r.outcome.booked);
  assert.ok(!r.events.some((e) => e.http?.path.endsWith('/handshake/accept')), 'no accept was sent');
});

async function acceptFor(env: Awaited<ReturnType<typeof setup>>) {
  const rv = await env.business.requestRendezvous();
  const http = createClient('test');
  const { record } = await http.request<{ record: string }>({
    to: 'registry',
    method: 'GET',
    url: `${env.registryUrl}${API_PREFIX}/rendezvous/${rv.code}`,
  });
  const rec = verifyJws<RendezvousRecord>(record, env.registry.keys.publicJwk, { nowMs: env.clock.now() });
  const agent = env.agent();
  const body = {
    session_id: rec.session_id,
    caller: agent.identity(),
    mandate: agent.mandate(),
    proof: agent.proof(rec.business_id, rec.session_id),
  };
  return { rv, rec, agent, http, body };
}

test('a session can be accepted only once', async () => {
  const env = await setup();
  try {
    const { rec, http, body } = await acceptFor(env);
    await http.request({ to: 'business', method: 'POST', url: `${rec.api}/handshake/accept`, body });
    await assert.rejects(
      http.request({ to: 'business', method: 'POST', url: `${rec.api}/handshake/accept`, body }),
      (e: ApiError) => e.status === 409 && e.code === 'session_already_accepted',
    );
  } finally {
    await env.close();
  }
});

test('holds require channel binding, and repeated wrong bind codes revoke the session', async () => {
  const env = await setup();
  try {
    const { rv, rec, http, body } = await acceptFor(env);
    const acc = await http.request<{ session_token: string; bind_code: string }>({
      to: 'business',
      method: 'POST',
      url: `${rec.api}/handshake/accept`,
      body,
    });
    const slots = env.business.availability({ service_id: 'cut-women', from: env.fx.request.from_iso, to: env.fx.request.to_iso });
    const hold = () =>
      http.request({ to: 'business', method: 'POST', url: `${rec.api}/holds`, token: acc.session_token, body: { slot_id: slots[0].slot_id } });

    await assert.rejects(hold(), (e: ApiError) => e.status === 403 && e.code === 'not_bound');
    const wrong = acc.bind_code === '000000' ? '111111' : '000000';
    assert.equal(env.business.bindHandshake(rv.session_id, wrong), false);
    assert.equal(env.business.bindHandshake(rv.session_id, wrong), false);
    assert.equal(env.business.bindHandshake(rv.session_id, wrong), false);
    assert.equal(env.business.bindHandshake(rv.session_id, acc.bind_code), false, 'revoked after 3 attempts');
    await assert.rejects(hold(), (e: ApiError) => e.status === 401);
  } finally {
    await env.close();
  }
});

test('binding with the right code unlocks holds', async () => {
  const env = await setup();
  try {
    const { rv, rec, http, body } = await acceptFor(env);
    const acc = await http.request<{ session_token: string; bind_code: string }>({
      to: 'business',
      method: 'POST',
      url: `${rec.api}/handshake/accept`,
      body,
    });
    assert.equal(env.business.bindHandshake(rv.session_id, acc.bind_code), true);
    const slots = env.business.availability({ service_id: 'cut-women', from: env.fx.request.from_iso, to: env.fx.request.to_iso });
    const hold = await http.request<{ hold_id: string }>({
      to: 'business',
      method: 'POST',
      url: `${rec.api}/holds`,
      token: acc.session_token,
      body: { slot_id: slots[0].slot_id },
    });
    assert.match(hold.hold_id, /^hold_/);
  } finally {
    await env.close();
  }
});

test('rendezvous codes expire', async () => {
  const clock = fakeClock('2026-09-28T03:00:00Z');
  const env = await setup({ clock });
  try {
    const rv = await env.business.requestRendezvous();
    clock.advance(121_000);
    await assert.rejects(
      createClient('test').request({ to: 'registry', method: 'GET', url: `${env.registryUrl}${API_PREFIX}/rendezvous/${rv.code}` }),
      (e: ApiError) => e.status === 404 && e.code === 'unknown_code',
    );
  } finally {
    await env.close();
  }
});

test('a mandate issued to a different key is rejected', async () => {
  const env = await setup();
  try {
    const { rec, http, body, agent } = await acceptFor(env);
    const stranger = generateKeyPair();
    const iat = Math.floor(Date.now() / 1000);
    const mandate = signJws(
      {
        typ: 'cp.mandate',
        iss: env.operator.id,
        sub: 'principal_x',
        agent_id: agent.agentId,
        cnf: { jkt: thumbprint(stranger.publicJwk) },
        scope: ['booking:create'],
        iat,
        exp: iat + 600,
      },
      env.operator.keys,
    );
    await assert.rejects(
      http.request({ to: 'business', method: 'POST', url: `${rec.api}/handshake/accept`, body: { ...body, mandate } }),
      (e: ApiError) => e.status === 401 && e.code === 'bad_mandate',
    );
  } finally {
    await env.close();
  }
});
