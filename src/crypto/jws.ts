// Compact JWS (RFC 7515) with EdDSA / Ed25519 (RFC 8037), built on node:crypto only.
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from 'node:crypto';

export interface PublicJwk {
  kty: 'OKP';
  crv: 'Ed25519';
  x: string;
  kid?: string;
}

export interface KeyPair {
  kid: string;
  publicJwk: PublicJwk;
  privateKey: KeyObject;
}

export interface JwsHeader {
  alg: string;
  typ?: string;
  kid?: string;
}

export class JwsError extends Error {}

const b64u = (input: Buffer | string): string => Buffer.from(input).toString('base64url');

/** RFC 7638 thumbprint of an OKP key. */
export function thumbprint(jwk: PublicJwk): string {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
  return createHash('sha256').update(canonical).digest('base64url');
}

export function generateKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const exported = publicKey.export({ format: 'jwk' }) as { x?: string };
  if (!exported.x) throw new JwsError('could not export Ed25519 public key');
  const bare: PublicJwk = { kty: 'OKP', crv: 'Ed25519', x: exported.x };
  const kid = thumbprint(bare);
  return { kid, publicJwk: { ...bare, kid }, privateKey };
}

export function signJws(payload: object, keys: KeyPair): string {
  const header: JwsHeader = { alg: 'EdDSA', typ: 'cp+jws', kid: keys.kid };
  const signingInput = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
  const signature = edSign(null, Buffer.from(signingInput), keys.privateKey);
  return `${signingInput}.${b64u(signature)}`;
}

/** Splits and parses a compact JWS without checking the signature. */
export function decodeJws(jws: string): { header: JwsHeader; payload: Record<string, unknown> } {
  const parts = typeof jws === 'string' ? jws.split('.') : [];
  if (parts.length !== 3) throw new JwsError('malformed JWS');
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as JwsHeader;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
    return { header, payload };
  } catch {
    throw new JwsError('malformed JWS');
  }
}

/**
 * Verifies signature and, when present, `exp` / `nbf` (seconds since epoch).
 * Returns the payload typed as T; callers must still check claim semantics.
 */
export function verifyJws<T>(jws: string, jwk: PublicJwk, opts: { nowMs?: number } = {}): T {
  const { header, payload } = decodeJws(jws);
  if (header.alg !== 'EdDSA') throw new JwsError(`unsupported alg ${header.alg}`);
  const expectedKid = jwk.kid ?? thumbprint(jwk);
  if (header.kid && header.kid !== expectedKid) throw new JwsError('kid does not match key');
  const [h, p, s] = jws.split('.');
  const key = createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, format: 'jwk' });
  const ok = edVerify(null, Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'));
  if (!ok) throw new JwsError('bad signature');
  const nowS = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  if (typeof payload.exp === 'number' && nowS >= payload.exp) throw new JwsError('expired');
  if (typeof payload.nbf === 'number' && nowS < payload.nbf) throw new JwsError('not yet valid');
  return payload as T;
}
