import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { verifyRelease } from '../scripts/verify-release.mjs';

const revision = 'a'.repeat(40);
const apiBase = JSON.parse(await readFile(new URL('../../../static/portfolio/sync-config.json', import.meta.url), 'utf8')).apiBase;
const health = { ok: true, service: 'portfolio-sync', apiVersion: 1, encryptionVersion: 1, revision, versionId: 'deployed-version' };

test('release verification matches the Worker revision and actual frontend content without modifying production data', async () => {
  const requests = [];
  const result = await verifyRelease({
    expectedRevision: revision, apiBase,
    fetcher: async (url, options) => {
      requests.push(url.pathname);
      assert.equal(options.cache, 'no-store');
      assert.equal(url.searchParams.get('release-check'), revision);
      assert.equal(options.method, undefined);
      return url.pathname === '/health' ? Response.json(health) : new Response(await readFile(new URL(`../../../docs${url.pathname}`, import.meta.url)));
    }
  });
  assert.deepEqual(result, health);
  assert.deepEqual(requests, ['/health', '/portfolio/index.html', '/portfolio/sync-config.json', '/portfolio/js/main.js', '/portfolio/css/main.css', '/portfolio/sync-e2ee-worker.js']);
});

test('HTTP 200 and ok true cannot hide an old Worker, another service or missing Cloudflare deployment metadata', async () => {
  for (const changed of [{ revision: 'b'.repeat(40) }, { service: 'another-service' }, { apiVersion: 2 }, { encryptionVersion: undefined }, { encryptionVersion: 0 }, { versionId: null }, { ok: false }]) {
    await assert.rejects(verifyRelease({ expectedRevision: revision, apiBase, backendOnly: true, fetcher: async () => Response.json({ ...health, ...changed }) }));
  }
  await assert.rejects(verifyRelease({ expectedRevision: revision, apiBase, backendOnly: true, fetcher: async () => new Response('Unavailable', { status: 503 }) }));
});

test('a current Worker cannot hide stale frontend output and backend-only verification makes no Pages requests', async () => {
  await assert.rejects(verifyRelease({
    expectedRevision: revision, apiBase,
    fetcher: async url => url.pathname === '/health' ? Response.json(health) : new Response('old build')
  }), /differs from the local production build/);
  let calls = 0;
  await verifyRelease({ expectedRevision: revision, apiBase, backendOnly: true, fetcher: async url => {
    calls++;
    assert.equal(url.pathname, '/health');
    return Response.json(health);
  } });
  assert.equal(calls, 1);
});
