import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { checkApiVersion } from '../scripts/check-api-version.mjs';
import { verifyRelease } from '../scripts/verify-release.mjs';
import { API_VERSION } from '../src/api-version.js';

const revision = 'a'.repeat(40);
const config = JSON.parse(await readFile(new URL('../../../static/portfolio/sync-config.json', import.meta.url), 'utf8'));
const { apiBase } = config;
const health = { ok: true, service: 'portfolio-sync', apiVersion: API_VERSION, encryptionVersion: 1, revision, versionId: 'deployed-version' };

// docs/ is a build output that is not committed, so release checks run against a stand-in build.
const docsDirectory = await mkdtemp(join(tmpdir(), 'release-docs-'));
after(() => rm(docsDirectory, { recursive: true, force: true }));
for (const path of ['portfolio/index.html', 'portfolio/sync-config.json', 'portfolio/js/main.js', 'portfolio/css/main.css', 'portfolio/sync-e2ee-worker.js',
  'chat/index.html', 'chat/sync-config.json', 'chat/sync-e2ee-worker.js', 'portfolio/js/chat.js', 'portfolio/css/chat.css']) {
  await mkdir(dirname(join(docsDirectory, path)), { recursive: true });
  await writeFile(join(docsDirectory, path), path.endsWith('sync-config.json') ? JSON.stringify(config) : `build of ${path}`);
}

test('release verification matches the Worker revision and actual frontend content without modifying production data', async () => {
  const requests = [];
  const result = await verifyRelease({
    expectedRevision: revision, apiBase, docsDirectory,
    fetcher: async (url, options) => {
      requests.push(url.pathname);
      assert.equal(options.cache, 'no-store');
      assert.equal(url.searchParams.get('release-check'), revision);
      assert.equal(options.method, undefined);
      return url.pathname === '/health' ? Response.json(health) : new Response(await readFile(join(docsDirectory, url.pathname)));
    }
  });
  assert.deepEqual(result, health);
  assert.deepEqual(requests, ['/health', '/portfolio/index.html', '/portfolio/sync-config.json', '/portfolio/js/main.js', '/portfolio/css/main.css', '/portfolio/sync-e2ee-worker.js',
    '/chat/index.html', '/chat/sync-config.json', '/chat/sync-e2ee-worker.js', '/portfolio/js/chat.js', '/portfolio/css/chat.css']);
});

test('HTTP 200 and ok true cannot hide an old Worker, another service or missing Cloudflare deployment metadata', async () => {
  for (const changed of [{ revision: 'b'.repeat(40) }, { service: 'another-service' }, { apiVersion: API_VERSION + 1 }, { encryptionVersion: undefined }, { encryptionVersion: 0 }, { versionId: null }, { ok: false }]) {
    await assert.rejects(verifyRelease({ expectedRevision: revision, apiBase, backendOnly: true, fetcher: async () => Response.json({ ...health, ...changed }) }));
  }
  await assert.rejects(verifyRelease({ expectedRevision: revision, apiBase, backendOnly: true, fetcher: async () => new Response('Unavailable', { status: 503 }) }));
});

test('a current Worker cannot hide stale frontend output and backend-only verification makes no Pages requests', async () => {
  await assert.rejects(verifyRelease({
    expectedRevision: revision, apiBase, docsDirectory,
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

test('release verification asks for a build when docs/ is missing', async () => {
  await assert.rejects(verifyRelease({
    expectedRevision: revision, apiBase, docsDirectory: join(docsDirectory, 'missing'),
    fetcher: async () => Response.json(health)
  }), /Run npm run build/);
});

test('the frontend declares the sync API version the Worker serves', () => {
  assert.equal(config.apiVersion, API_VERSION);
});

test('Pages publishing waits for a Worker that serves the API the frontend needs', async () => {
  const serving = apiVersion => async (url, options) => {
    assert.equal(url.pathname, '/health');
    assert.equal(options.cache, 'no-store');
    return Response.json({ ...health, apiVersion });
  };
  assert.equal((await checkApiVersion({ apiBase, apiVersion: 2, fetcher: serving(2) })).apiVersion, 2);
  await checkApiVersion({ apiBase, apiVersion: 2, fetcher: serving(3) });
  await assert.rejects(checkApiVersion({ apiBase, apiVersion: 2, fetcher: serving(1) }), /Deploy the Worker first/);
  await assert.rejects(checkApiVersion({ apiBase, apiVersion: 2, fetcher: serving(undefined) }), /Deploy the Worker first/);
  await assert.rejects(checkApiVersion({ apiBase, apiVersion: undefined, fetcher: serving(1) }), /apiVersion/);
  await assert.rejects(checkApiVersion({ apiBase, apiVersion: 1, fetcher: async () => Response.json({ ...health, service: 'other' }) }), /another service/);
  await assert.rejects(checkApiVersion({ apiBase, apiVersion: 1, fetcher: async () => new Response('down', { status: 503 }) }), /HTTP 503/);
});
