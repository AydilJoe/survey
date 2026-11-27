// Throwaway store-signing fixtures for the Duitful AI+ verification tests.
// Builds a local EC P-256 CA chain (root -> intermediate -> leaf) shaped like
// Apple's (CA flags, Apple's marker extension OIDs), signs ES256 JWS with it,
// and makes Google-style RS256 OIDC tokens with a matching JWKS.
// node:crypto only; X.509 DER is assembled by hand below. Nothing here is a
// real Apple or Google key.

import crypto from 'node:crypto';

// ---- tiny DER writer -------------------------------------------------------
function len(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  while (n > 0) { bytes.unshift(n & 0xff); n >>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const seq = (...items) => tlv(0x30, Buffer.concat(items));
const set = (...items) => tlv(0x31, Buffer.concat(items));
const explicit = (n, body) => tlv(0xa0 + n, body);
const octet = (buf) => tlv(0x04, buf);
const bitString = (buf) => tlv(0x03, Buffer.concat([Buffer.from([0]), buf]));
const bool = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0]));
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
function int(n) {
  let hex = BigInt(n).toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let b = Buffer.from(hex, 'hex');
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}
function oid(str) {
  const p = str.split('.').map(Number);
  const out = [p[0] * 40 + p[1]];
  for (const v of p.slice(2)) {
    const stack = [v & 0x7f];
    let x = v >>> 7;
    while (x > 0) { stack.unshift((x & 0x7f) | 0x80); x >>>= 7; }
    out.push(...stack);
  }
  return tlv(0x06, Buffer.from(out));
}
function time(d) {
  const iso = new Date(d).toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const y = Number(iso.slice(0, 4));
  return y >= 1950 && y < 2050 ? tlv(0x17, Buffer.from(`${iso.slice(2)}Z`)) : tlv(0x18, Buffer.from(`${iso}Z`));
}
const name = (cn) => seq(set(seq(oid('2.5.4.3'), utf8(cn))));
const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));

export const APPLE_LEAF_MARKER = '1.2.840.113635.100.6.11.1';
export const APPLE_INTERMEDIATE_MARKER = '1.2.840.113635.100.6.2.1';

let serial = 1000;
function makeCert({ subject, issuer, publicKey, signKey, ca, notBefore, notAfter, marker }) {
  const exts = [seq(oid('2.5.29.19'), bool(true), octet(ca ? seq(bool(true)) : seq()))];
  if (marker) exts.push(seq(oid(marker), octet(Buffer.from([0x05, 0x00]))));
  const tbs = seq(
    explicit(0, int(2)),
    int(serial++),
    ECDSA_SHA256,
    name(issuer),
    seq(time(notBefore), time(notAfter)),
    name(subject),
    publicKey.export({ type: 'spki', format: 'der' }),
    explicit(3, seq(...exts)),
  );
  const sig = crypto.sign('sha256', tbs, signKey);
  return seq(tbs, ECDSA_SHA256, bitString(sig));
}

const DAY = 86400000;

// Returns { root, intermediate, leaf (DER buffers), leafKey, x5c, rootSha256 }.
// opts: leafNotAfter / leafNotBefore (ms), markers (default true), rootName.
export function makeAppleLikeChain(opts = {}) {
  const now = Date.now();
  const gen = () => crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const r = gen();
  const i = gen();
  const l = gen();
  const markers = opts.markers !== false;
  const rootName = opts.rootName || 'Test Root CA - G3';
  const root = makeCert({ subject: rootName, issuer: rootName, publicKey: r.publicKey, signKey: r.privateKey, ca: true, notBefore: now - 365 * DAY, notAfter: now + 3650 * DAY });
  const intermediate = makeCert({ subject: 'Test WWDR CA', issuer: rootName, publicKey: i.publicKey, signKey: r.privateKey, ca: true, notBefore: now - 365 * DAY, notAfter: now + 1825 * DAY, marker: markers ? APPLE_INTERMEDIATE_MARKER : null });
  const leaf = makeCert({ subject: 'Test App Store Signing', issuer: 'Test WWDR CA', publicKey: l.publicKey, signKey: i.privateKey, ca: false, notBefore: opts.leafNotBefore ?? now - 30 * DAY, notAfter: opts.leafNotAfter ?? now + 365 * DAY, marker: markers ? APPLE_LEAF_MARKER : null });
  return {
    root,
    intermediate,
    leaf,
    leafKey: l.privateKey,
    x5c: [leaf, intermediate, root].map((d) => d.toString('base64')),
    rootSha256: crypto.createHash('sha256').update(root).digest('hex'),
  };
}

const b64u = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

// ES256 JWS (IEEE P1363 r||s) with the chain's leaf key in the x5c header.
export function signAppleJws(payload, chain, { alg = 'ES256', key = chain.leafKey, x5c = chain.x5c } = {}) {
  const head = b64u({ alg, x5c });
  const body = b64u(payload);
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${sig.toString('base64url')}`;
}

// A JWS whose payload was swapped after signing (signature no longer matches).
export function tamperJwsPayload(jws, patch) {
  const [h, p, s] = jws.split('.');
  const payload = { ...JSON.parse(Buffer.from(p, 'base64url').toString('utf8')), ...patch };
  return `${h}.${b64u(payload)}.${s}`;
}

// Google-style OIDC: { jwks, sign(claims) } with one RSA key.
export function makeGoogleOidc() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = crypto.randomBytes(8).toString('hex');
  const jwk = publicKey.export({ format: 'jwk' });
  return {
    jwks: { keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] },
    sign(claims, { signKey = privateKey, useKid = kid } = {}) {
      const head = b64u({ alg: 'RS256', kid: useKid, typ: 'JWT' });
      const body = b64u(claims);
      const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), signKey);
      return `${head}.${body}.${sig.toString('base64url')}`;
    },
  };
}

// A throwaway Play service account (the verifier signs its own OAuth JWT).
export function makePlayServiceAccount() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return JSON.stringify({
    client_email: 'play-verifier@duitful-test.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  });
}
