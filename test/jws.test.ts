import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPair, signJws, thumbprint, verifyJws } from '../src/crypto/jws.ts';

test('sign and verify', () => {
  const keys = generateKeyPair();
  const jws = signJws({ hello: 'world' }, keys);
  assert.deepEqual(verifyJws(jws, keys.publicJwk), { hello: 'world' });
  assert.equal(keys.kid, thumbprint(keys.publicJwk));
});

test('tampered payload and wrong key are rejected', () => {
  const keys = generateKeyPair();
  const other = generateKeyPair();
  const jws = signJws({ amount: 10 }, keys);
  const [h, , s] = jws.split('.');
  const forged = `${h}.${Buffer.from(JSON.stringify({ amount: 99 })).toString('base64url')}.${s}`;
  assert.throws(() => verifyJws(forged, keys.publicJwk), /bad signature/);
  assert.throws(() => verifyJws(jws, other.publicJwk), /kid does not match/);
  assert.throws(() => verifyJws(jws, { ...other.publicJwk, kid: keys.kid }), /bad signature/);
});

test('exp is enforced against the supplied clock', () => {
  const keys = generateKeyPair();
  const jws = signJws({ exp: 1_000 }, keys);
  assert.doesNotThrow(() => verifyJws(jws, keys.publicJwk, { nowMs: 999_000 }));
  assert.throws(() => verifyJws(jws, keys.publicJwk, { nowMs: 1_000_000 }), /expired/);
});
