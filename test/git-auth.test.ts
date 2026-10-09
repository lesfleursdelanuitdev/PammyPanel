// Git over HTTPS (docs/phase8b-plan.md 8b-7): the tokens, git's Basic header, which requests
// nginx asks about, and the failures counted per address (packages/projects/src/git-auth.ts).
// The check itself, through the panel: test/e2e-lfdln/16-projects.spec.ts; for real behind
// nginx and fcgiwrap: deploy/lfdln/verify-lfdln.sh.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { basicCredentials, Failures, gitRequest, hashGitToken, newGitToken } from '@panel/projects/git-auth';

describe('git tokens', () => {
  it('a new token: lfdln_git_ and 43 base64url characters, its hash and its hint; each different', () => {
    const a = newGitToken(), b = newGitToken();
    assert.match(a.token, /^lfdln_git_[A-Za-z0-9_-]{43}$/);
    assert.notEqual(a.token, b.token);
    assert.equal(a.hint, a.token.slice(10, 14));
    assert.equal(a.hash, hashGitToken(a.token));
    assert.match(a.hash, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(a.hash, b.hash);
  });

  it('only a token is hashed: anything else (a password, the raw part, too long) is null', () => {
    const { token } = newGitToken();
    for (const v of ['', 'hunter2', token.slice(10), `${token}x`, token.slice(0, -1), `lfdln_git_${'+'.repeat(43)}`, ` ${token}`]) assert.equal(hashGitToken(v), null, v);
  });
});

describe('git\'s Basic header', () => {
  const basic = (s: string) => `Basic ${Buffer.from(s).toString('base64')}`;
  it('user and token, the token keeping any colons', () => {
    assert.deepEqual(basicCredentials(basic('ericka:lfdln_git_abc')), { user: 'ericka', token: 'lfdln_git_abc' });
    assert.deepEqual(basicCredentials(basic('ericka:a:b')), { user: 'ericka', token: 'a:b' });
  });
  it('anything else is null', () => {
    for (const v of [undefined, '', 'Bearer x', basic('no-colon'), basic(':token'), 'Basic !!!', `Basic ${'A'.repeat(600)}`, ['Basic x']]) assert.equal(basicCredentials(v), null, String(v));
  });
});

describe('what nginx asks about', () => {
  it('git\'s smart HTTP: reading (upload-pack) or pushing (receive-pack)', () => {
    assert.deepEqual(gitRequest('/shop.git/info/refs?service=git-upload-pack'), { project: 'shop', push: false });
    assert.deepEqual(gitRequest('/shop.git/git-upload-pack'), { project: 'shop', push: false });
    assert.deepEqual(gitRequest('/shop.git/info/refs?service=git-receive-pack'), { project: 'shop', push: true });
    assert.deepEqual(gitRequest('/my-site.git/git-receive-pack'), { project: 'my-site', push: true });
  });
  it('anything else is null: the dumb protocol, other paths, names no project can have', () => {
    for (const v of [undefined, '', '/shop.git/info/refs', '/shop.git/info/refs?service=other', '/shop.git/HEAD', '/shop.git/objects/info/packs',
      '/shop.git/git-upload-pack/x', '/shop/git-upload-pack', '/Shop.git/git-upload-pack', '/shop-dev.git/git-upload-pack', '/a--b.git/git-upload-pack',
      '/-shop.git/git-upload-pack', '/../etc.git/git-upload-pack', '/shop.git/../x.git/git-upload-pack', `/${'a'.repeat(37)}.git/git-upload-pack`, `/x.git/git-upload-pack?${'a'.repeat(300)}`]) {
      assert.equal(gitRequest(v), null, String(v));
    }
  });
});

describe('failures per address', () => {
  it('20 in 10 minutes, then refused until the window passes; others unaffected', () => {
    let now = 1000;
    const f = new Failures(() => now);
    for (let i = 0; i < 19; i++) f.failed('1.2.3.4');
    assert.equal(f.blocked('1.2.3.4'), false);
    f.failed('1.2.3.4');
    assert.equal(f.blocked('1.2.3.4'), true);
    assert.equal(f.blocked('5.6.7.8'), false);
    now += 601;
    assert.equal(f.blocked('1.2.3.4'), false);
    f.failed('1.2.3.4');
    assert.equal(f.blocked('1.2.3.4'), false, 'a new window starts at one');
  });
});
