import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { API_VERSION } from '../src/api-version.js';

export async function verifyRelease({ expectedRevision, apiBase, siteBase = 'https://lizuju.github.io/', docsDirectory = fileURLToPath(new URL('../../../docs/', import.meta.url)), backendOnly = false, fetcher = fetch }) {
  assert.match(expectedRevision || '', /^[0-9a-f]{40}$/, 'Provide the full Git commit SHA expected in production.');
  const get = async (url) => {
    const target = new URL(url);
    target.searchParams.set('release-check', expectedRevision);
    const response = await fetcher(target, { cache: 'no-store', signal: AbortSignal.timeout(20000) });
    assert.equal(response.status, 200, `Release check failed: ${target.pathname} returned HTTP ${response.status}`);
    return response;
  };
  const health = await (await get(`${apiBase.replace(/\/$/, '')}/health`)).json();
  assert.equal(health.ok, true, 'Worker is unhealthy.');
  assert.equal(health.service, 'portfolio-sync', 'The API address points to another service.');
  assert.equal(health.apiVersion, API_VERSION, 'Unexpected sync API version.');
  assert.equal(health.encryptionVersion, 1, 'End-to-end encryption is not active on the backend.');
  assert.equal(health.revision, expectedRevision, 'Production Worker does not match the expected Git commit.');
  assert.ok(typeof health.versionId === 'string' && health.versionId.length, 'Cloudflare deployment version is missing.');
  if (!backendOnly) {
    await access(docsDirectory).catch(() => {
      throw new Error(`No production build at ${docsDirectory}. Run npm run build from the repository root first.`);
    });
    for (const path of ['portfolio/index.html', 'portfolio/sync-config.json', 'portfolio/js/main.js', 'portfolio/css/main.css', 'portfolio/sync-e2ee-worker.js',
      'chat/index.html', 'chat/sync-config.json', 'chat/sync-e2ee-worker.js', 'portfolio/js/chat.js', 'portfolio/css/chat.css']) {
      const local = await readFile(resolve(docsDirectory, path));
      if (path.endsWith('sync-config.json')) {
        assert.equal(JSON.parse(local).apiBase.replace(/\/$/, ''), apiBase.replace(/\/$/, ''), 'The frontend build uses another API address.');
      }
      const remote = Buffer.from(await (await get(new URL(path, siteBase))).arrayBuffer());
      const digest = bytes => createHash('sha256').update(bytes).digest('hex');
      assert.equal(digest(remote), digest(local), `Published ${path} differs from the local production build.`);
    }
  }
  return health;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const config = JSON.parse(await readFile(new URL('../../../static/portfolio/sync-config.json', import.meta.url), 'utf8'));
    const health = await verifyRelease({ expectedRevision: process.argv[2], apiBase: config.apiBase, backendOnly: process.argv.includes('--backend-only') });
    console.log(`Release verified: ${health.revision} (Cloudflare ${health.versionId})`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
