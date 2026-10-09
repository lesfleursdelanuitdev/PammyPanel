// The proof an app's account headers came from nginx (docs/s1-plan.md, review S1):
// packages/core/src/identity-proof.ts. The gate's half is test/route-areas.test.ts,
// nginx's test/run-route-accounts-nginx-test.sh.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';
import { makeProof, message, privateKeyOf, proofOk, publicKeyOf, rawPublicKey, type Told } from '@panel/core/identity-proof';

const keys = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');
const T: Told = { account: '5', username: 'jo', role: 'Member', privileges: 'pages.read progress.update:own' };
const AUD = 'service.examprep.web';
const HOST = 'examprep.lesfleursdelanuit.com';
const NOW = 1_800_000_000_000;

describe('the identity proof', () => {
  it('the gate makes it, the app checks it', () => {
    const p = makeProof(keys.privateKey, AUD, HOST, T, NOW);
    assert.match(p, /^v1\.1800000000000\.[A-Za-z0-9_-]{86}$/);
    assert.ok(proofOk(keys.publicKey, p, AUD, HOST, T, NOW + 1000));
    assert.ok(proofOk(keys.publicKey, p, AUD, HOST.toUpperCase(), T, NOW), 'the host in any case');
  });

  it('refused: another key, app, host, any header changed, too old or too new, not a proof at all', () => {
    const p = makeProof(keys.privateKey, AUD, HOST, T, NOW);
    assert.ok(!proofOk(other.publicKey, p, AUD, HOST, T, NOW));
    assert.ok(!proofOk(keys.publicKey, p, 'project.x.main', HOST, T, NOW));
    assert.ok(!proofOk(keys.publicKey, p, AUD, 'tutor.lesfleursdelanuit.com', T, NOW));
    for (const k of ['account', 'username', 'role', 'privileges'] as const) assert.ok(!proofOk(keys.publicKey, p, AUD, HOST, { ...T, [k]: `${T[k]}x` }, NOW), k);
    assert.ok(!proofOk(keys.publicKey, p, AUD, HOST, T, NOW + 5 * 60_000 + 1));
    assert.ok(!proofOk(keys.publicKey, p, AUD, HOST, T, NOW - 5 * 60_000 - 1));
    for (const bad of [undefined, '', 'v1', 'v2' + p.slice(2), p + 'A', p.replace(/\.(\d+)\./, '.1800000000001.'), ['x']]) assert.ok(!proofOk(keys.publicKey, bad, AUD, HOST, T, NOW), String(bad));
  });

  it('nothing can be moved from one header to the next', () => {
    // "a" + "b c" and "a b" + "c" are different messages
    assert.notEqual(message('1', AUD, HOST, { ...T, role: 'a', privileges: 'b c' }), message('1', AUD, HOST, { ...T, role: 'a b', privileges: 'c' }));
    assert.notEqual(message('1', AUD, HOST, { ...T, username: 'a\n', role: 'b' }), message('1', AUD, HOST, { ...T, username: 'a', role: '\nb' }));
  });

  it("keys as the installer writes them: the gate's PEM, the apps' 43 characters", () => {
    const pem = keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const raw = rawPublicKey(keys.publicKey);
    assert.match(raw, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(rawPublicKey(privateKeyOf(pem)), raw, 'the public half of the private key');
    const p = makeProof(privateKeyOf(pem), AUD, HOST, T, NOW);
    assert.ok(proofOk(publicKeyOf(raw), p, AUD, HOST, T, NOW));
    assert.ok(proofOk(publicKeyOf(keys.publicKey.export({ format: 'pem', type: 'spki' }).toString()), p, AUD, HOST, T, NOW));
    assert.throws(() => publicKeyOf('short'), /32 bytes/);
    const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    assert.throws(() => privateKeyOf(ec), /not an Ed25519 key/);
    assert.throws(() => makeProof(keys.privateKey, 'Not One', HOST, T, NOW), /audience/);
  });
});
