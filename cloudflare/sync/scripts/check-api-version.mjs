import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Refuses to publish a frontend that needs a newer sync protocol than the deployed Worker serves.
export async function checkApiVersion({ apiBase, apiVersion, fetcher = fetch }) {
  assert.ok(Number.isInteger(apiVersion) && apiVersion > 0, 'sync-config.json must declare a positive integer apiVersion.');
  const response = await fetcher(new URL('/health', apiBase), { cache: 'no-store', signal: AbortSignal.timeout(20000) });
  assert.equal(response.status, 200, `Sync Worker health check returned HTTP ${response.status}.`);
  const health = await response.json();
  assert.equal(health.service, 'portfolio-sync', 'The API address points to another service.');
  assert.ok(Number.isInteger(health.apiVersion) && health.apiVersion >= apiVersion,
    `The deployed Worker serves sync API ${health.apiVersion}, but the frontend needs ${apiVersion}. Deploy the Worker first: cd cloudflare/sync && npm run deploy`);
  return health;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const config = JSON.parse(await readFile(new URL('../../../static/portfolio/sync-config.json', import.meta.url), 'utf8'));
    const health = await checkApiVersion(config);
    console.log(`Sync Worker serves API ${health.apiVersion}; frontend needs ${config.apiVersion}.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
