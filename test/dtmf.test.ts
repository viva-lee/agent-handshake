import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFrames, dtmfDurationMs, encodeFrame, luhnCheckDigit, luhnValid } from '../src/protocol/dtmf.ts';

test('luhn check digit matches the textbook example', () => {
  assert.equal(luhnCheckDigit('7992739871'), '3');
  assert.ok(luhnValid('79927398713'));
  assert.ok(!luhnValid('79927398710'));
});

test('frames round-trip', () => {
  const offer = { type: 'offer', registry: '0', code: '4815162342' } as const;
  const bind = { type: 'bind', bindCode: '271828' } as const;
  assert.deepEqual(decodeFrames(encodeFrame(offer)), [offer]);
  assert.deepEqual(decodeFrames(encodeFrame(bind)), [bind]);
  assert.deepEqual(decodeFrames(encodeFrame({ type: 'probe' })), [{ type: 'probe' }]);
});

test('frames are found inside noise and corrupted frames are dropped', () => {
  const offer = encodeFrame({ type: 'offer', registry: '0', code: '4815162342' });
  const corrupted = offer.replace('48151', '48152');
  const stream = `12#*9${corrupted}55${offer}#*${encodeFrame({ type: 'probe' })}`;
  assert.deepEqual(
    decodeFrames(stream).map((f) => f.type),
    ['offer', 'probe'],
  );
});

test('encoder rejects malformed payloads', () => {
  assert.throws(() => encodeFrame({ type: 'offer', registry: '0', code: '123' }));
  assert.throws(() => encodeFrame({ type: 'bind', bindCode: '12a456' }));
});

test('an OFFER frame stays short enough to play in about two seconds', () => {
  const offer = encodeFrame({ type: 'offer', registry: '0', code: '4815162342' });
  assert.equal(offer.length, 16);
  assert.ok(dtmfDurationMs(offer) <= 2_500);
});
