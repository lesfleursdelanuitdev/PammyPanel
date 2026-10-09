// A software passkey authenticator for tests: real P-256 keys, real CBOR
// attestation objects, real signatures, so the server's actual WebAuthn
// verification runs end to end. Knobs let tests produce bad responses.
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

type Cbor = number | string | Uint8Array | Cbor[] | Map<number | string, Cbor>;

function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
  if (n < 0x10000) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
  const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
}

export function cbor(v: Cbor): Buffer {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') { const s = Buffer.from(v, 'utf8'); return Buffer.concat([head(3, s.length), s]); }
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)]);
  return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
}

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest();

type Credential = { id: Buffer; key: KeyObject; cose: Buffer; rpId: string; userHandle: string; counter: number };

export type Knobs = {
  origin?: string;       // origin written into clientDataJSON
  rpId?: string;         // rpId hashed into authenticatorData
  uv?: boolean;          // user verified flag
  counter?: number;      // force the signature counter
  challenge?: string;    // replace the challenge
};

export class SoftAuthenticator {
  creds: Credential[] = [];
  origin: string;
  constructor(origin: string) {
    this.origin = origin;
  }

  private authData(rpId: string, flags: number, counter: number, attested?: Credential): Buffer {
    const c = Buffer.alloc(4);
    c.writeUInt32BE(counter);
    const parts: Buffer[] = [sha256(rpId), Buffer.from([flags]), c];
    if (attested) {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(attested.id.length);
      parts.push(Buffer.alloc(16), len, attested.id, attested.cose);
    }
    return Buffer.concat(parts);
  }

  private clientData(type: string, challenge: string, k: Knobs): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge: k.challenge ?? challenge, origin: k.origin ?? this.origin, crossOrigin: false }));
  }

  // navigator.credentials.create()
  create(options: any, k: Knobs = {}) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    const cose = cbor(new Map<number, Cbor>([
      [1, 2], [3, -7], [-1, 1],
      [-2, Buffer.from(jwk.x!, 'base64url')],
      [-3, Buffer.from(jwk.y!, 'base64url')],
    ]));
    const cred: Credential = { id: randomBytes(32), key: privateKey, cose, rpId: options.rp.id, userHandle: options.user.id, counter: 0 };
    const flags = 0x01 | (k.uv === false ? 0 : 0x04) | 0x08 | 0x10 | 0x40;   // UP, UV, BE, BS, AT
    const authData = this.authData(k.rpId ?? options.rp.id, flags, k.counter ?? 0, cred);
    const clientDataJSON = this.clientData('webauthn.create', options.challenge, k);
    this.creds.push(cred);
    return {
      id: b64(cred.id), rawId: b64(cred.id), type: 'public-key', authenticatorAttachment: 'platform', clientExtensionResults: {},
      response: {
        clientDataJSON: b64(clientDataJSON),
        attestationObject: b64(cbor(new Map<string, Cbor>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]))),
        transports: ['internal', 'hybrid'],
      },
    };
  }

  // navigator.credentials.get(). With allowCredentials empty (discoverable
  // login) it uses this authenticator's first matching passkey.
  get(options: any, k: Knobs = {}, which = 0) {
    const allowed: string[] = (options.allowCredentials ?? []).map((c: { id: string }) => c.id);
    const candidates = this.creds.filter((c) => c.rpId === options.rpId && (!allowed.length || allowed.includes(b64(c.id))));
    const cred = candidates[which];
    if (!cred) throw Object.assign(new Error('no credential'), { name: 'NotAllowedError' });
    // a forced counter is a one-off bad response; the real one keeps counting
    const counter = k.counter ?? ++cred.counter;
    const flags = 0x01 | (k.uv === false ? 0 : 0x04) | 0x08 | 0x10;
    const authData = this.authData(k.rpId ?? options.rpId, flags, counter);
    const clientDataJSON = this.clientData('webauthn.get', options.challenge, k);
    const signature = sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), cred.key);
    return {
      id: b64(cred.id), rawId: b64(cred.id), type: 'public-key', authenticatorAttachment: 'platform', clientExtensionResults: {},
      response: {
        clientDataJSON: b64(clientDataJSON),
        authenticatorData: b64(authData),
        signature: b64(signature),
        userHandle: cred.userHandle,
      },
    };
  }
}
