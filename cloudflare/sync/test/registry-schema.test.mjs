import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';

test('registry preserves state across migration and initialized wakeups use two read-only schema checks', async t => {
  let source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  const start = source.indexOf('export class E2eePairingRegistry');
  const end = source.indexOf('export class E2eeSyncRoom');
  source = source.slice(0, start) + source.slice(start, end)
    .replace('this.sql = ctx.storage.sql;', 'this.sql = ctx.storage.sql; this.queries = [];')
    .replaceAll('this.sql.exec(', 'this.testExec(')
    .replace('  rememberUsage(', `  testExec(...args) { this.queries.push(args[0]); return this.sql.exec(...args); }
      testQueries() { return this.queries.splice(0); }
      rememberUsage(`) + source.slice(end);
  const modules = Object.fromEntries(await Promise.all(['daily-usage', 'web-push', 'api-version'].map(async name => [`${name}.js`, { type: 'esm', contents: await readFile(new URL(`../src/${name}.js`, import.meta.url), 'utf8') }])));
  const runtime = new Miniflare({ unsafeInspectDurableObjects: true, workers: [{ config: {
    name: 'registry-schema', compatibilityDate: '2026-10-23', manifest: { mainModule: 'harness.js', modules: {
      ...modules, 'index.js': { type: 'esm', contents: source },
      'harness.js': { type: 'esm', contents: `export { E2eePairingRegistry } from './index.js';
        export default { async fetch(request, env) { return Response.json(await env.REGISTRY.getByName('registry').testQueries()); } };` }
    } }, env: { REGISTRY: { type: 'durable-object', worker: 'registry-schema', exportName: 'E2eePairingRegistry' } },
    exports: { E2eePairingRegistry: { type: 'durable-object', storage: 'sqlite' } }
  } }] });
  t.after(() => runtime.dispose());
  const readQueries = async () => (await runtime.dispatchFetch('https://registry.test')).json();
  const first = await readQueries();
  assert.ok(first.some(query => query.startsWith('CREATE TABLE')));
  const storage = await runtime.unsafeGetDurableObjectStorage('registry-schema', 'E2eePairingRegistry', { name: 'registry' });
  await storage.exec('INSERT INTO room_pairing VALUES (?, ?, ?, ?, ?)', 'room', 1, 1, 'secret', 1);
  await runtime.unsafeEvictDurableObject('registry-schema', 'E2eePairingRegistry', { name: 'registry' });
  const queries = await readQueries();
  assert.equal(queries.length, 2);
  assert.ok(queries.every(query => query.startsWith('SELECT')));
  assert.equal((await storage.exec('SELECT count(*) AS count FROM room_pairing'))[0].count, 1);
  await storage.exec("DELETE FROM registry_metadata WHERE key = 'schemaVersion'");
  await storage.exec('ALTER TABLE offers DROP COLUMN locked');
  await runtime.unsafeEvictDurableObject('registry-schema', 'E2eePairingRegistry', { name: 'registry' });
  assert.ok((await readQueries()).some(query => query.startsWith('ALTER TABLE')));
  assert.equal((await storage.exec("SELECT value FROM registry_metadata WHERE key = 'schemaVersion'"))[0].value, 1);
});
