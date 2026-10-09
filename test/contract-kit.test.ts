// The contract kit's own rules, and the engines the tests start against the server's
// (docs/ci-plan.md, T2). No engines are started here.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BOTH, checkEngines } from './contract-kit.ts';
import { ENGINE_QUADLETS, imageOf, MARIA_IMAGE, PG_IMAGE } from './engine-images.ts';

describe('which engines a contract suite runs on (module rule 14)', () => {
  it('both, unless an implementation says why not', () => {
    assert.deepEqual(checkEngines(BOTH, { name: 'x' }), ['postgres', 'mariadb']);
    assert.throws(() => checkEngines(['postgres'], { name: 'x' }), /rule 14 wants both engines/);
    assert.deepEqual(checkEngines(['postgres'], { name: 'x', oneEngine: 'Postgres only by nature' }), ['postgres']);
  });
  it('never none, never one it doesn\'t know, never the same twice', () => {
    assert.throws(() => checkEngines([], { name: 'x', oneEngine: 'y' }), /at least one engine/);
    assert.throws(() => checkEngines(['sqlite' as never, 'postgres'], { name: 'x' }), /no engine called sqlite/);
    assert.deepEqual(checkEngines(['mariadb', 'postgres', 'mariadb'], { name: 'x' }), ['mariadb', 'postgres']);
  });
});

describe('the engines the tests start are the ones the server runs', () => {
  it('every live Quadlet of an engine names the same image series', () => {
    for (const [engine, files] of Object.entries(ENGINE_QUADLETS)) {
      const images = new Set(files.map(imageOf));
      assert.equal(images.size, 1, `${engine}: ${[...images].join(' vs ')} (${files.join(', ')})`);
    }
  });
  it('...and the harness uses it: Postgres 17 and MariaDB 11.4 today', () => {
    assert.equal(PG_IMAGE, 'docker.io/library/postgres:17');
    assert.equal(MARIA_IMAGE, 'docker.io/library/mariadb:11.4');
  });
});
