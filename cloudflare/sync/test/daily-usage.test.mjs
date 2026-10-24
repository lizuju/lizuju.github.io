import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import { collectDailyUsage } from '../src/daily-usage.js';

const env = { CF_ACCOUNT_ID: 'a'.repeat(32), CF_ANALYTICS_TOKEN: 'test-analytics-secret' };
const now = Date.parse('2026-10-24T12:34:56.000Z');
const account = {
  workersInvocationsAdaptive: [{ sum: { requests: 80000 } }],
  durableObjectsInvocationsAdaptiveGroups: [
    { dimensions: { type: 'http' }, sum: { requests: 100 } },
    { dimensions: { type: 'jsrpc' }, sum: { requests: 900 } },
    { dimensions: { type: 'alarm' }, sum: { requests: 3 } },
    { dimensions: { type: 'hibernation' }, sum: { requests: 200 } }
  ],
  durableObjectsPeriodicGroups: [{ sum: { rowsRead: 4750000, rowsWritten: 100000, duration: 123.5, inboundWebsocketMsgCount: 460 } }]
};
const payload = value => ({ data: { viewer: { accounts: [value] } } });

test('official account analytics combines independently counted standard and hibernation WebSockets and preserves GB-seconds', async () => {
  let calls = 0;
  const usage = await collectDailyUsage(env, { now, fetcher: async (url, options) => {
    calls += 1;
    assert.equal(url, 'https://api.cloudflare.com/client/v4/graphql');
    assert.equal(options.headers.Authorization, `Bearer ${env.CF_ANALYTICS_TOKEN}`);
    assert.ok(options.signal instanceof AbortSignal);
    const body = JSON.parse(options.body);
    assert.deepEqual(body.variables, { account: env.CF_ACCOUNT_ID, start: '2026-10-24T00:00:00.000Z', end: '2026-10-24T12:34:56.000Z' });
    assert.equal(body.query.includes('scriptName'), false);
    assert.match(body.query, /datetime_lt/);
    return Response.json(payload(account));
  } });
  assert.equal(calls, 1); assert.equal(usage.status, 'ready'); assert.equal(usage.available, true);
  assert.equal(usage.day, '2026-10-24'); assert.equal(usage.checkedAt, now);
  assert.equal(usage.resetsAt, Date.parse('2026-10-25T00:00:00.000Z'));
  assert.deepEqual(usage.metrics.workersRequests, { used: 80000, limit: 100000, level: 'warning' });
  assert.deepEqual(usage.metrics.durableRequests, { used: 1036, limit: 100000, level: 'normal' });
  assert.equal(usage.metrics.rowsRead.level, 'critical'); assert.equal(usage.metrics.rowsWritten.level, 'exceeded');
  assert.equal(usage.metrics.duration.used, 123.5); assert.equal(usage.metrics.duration.limit, 13000);
  assert.equal(usage.estimated, true);
  assert.equal(JSON.stringify(usage).includes(env.CF_ACCOUNT_ID), false);
  assert.equal(JSON.stringify(usage).includes(env.CF_ANALYTICS_TOKEN), false);
});

test('analytics request spanning UTC midnight never exposes the preceding day as current ready usage', async () => {
  const beforeMidnight = Date.parse('2026-10-24T23:59:59.000Z');
  const afterMidnight = Date.parse('2026-10-25T00:00:01.000Z');
  const usage = await collectDailyUsage(env, { now: beforeMidnight, clock: () => afterMidnight, fetcher: async () => Response.json(payload(account)) });
  assert.equal(usage.day, '2026-10-25'); assert.equal(usage.status, 'unavailable');
  assert.equal(usage.available, false); assert.equal(usage.metrics, null); assert.equal(usage.checkedAt, null);
  const failed = await collectDailyUsage(env, { now: beforeMidnight, clock: () => afterMidnight, fetcher: () => { throw new Error('private-provider-error'); } });
  assert.equal(failed.day, '2026-10-25'); assert.equal(failed.metrics, null);
});

test('missing credentials, provider errors and incomplete datasets never become measured zeros', async () => {
  const unconfigured = await collectDailyUsage({}, { now, fetcher: () => assert.fail('unconfigured analytics must not make a request') });
  assert.equal(unconfigured.status, 'not_configured'); assert.equal(unconfigured.configured, false); assert.equal(unconfigured.metrics, null);
  for (const response of [
    () => Response.json({ errors: [{ message: 'private-provider-error' }], ...payload(account) }),
    () => Response.json({ data: { viewer: { accounts: [] } } }),
    () => Response.json(payload({ ...account, durableObjectsPeriodicGroups: null })),
    () => Response.json(payload({ ...account, workersInvocationsAdaptive: [{ sum: { requests: null } }] })),
    () => new Response('private-provider-error', { status: 403 }),
    () => { throw new Error('private-provider-error'); }
  ]) {
    const unavailable = await collectDailyUsage(env, { now, fetcher: response });
    assert.equal(unavailable.status, 'unavailable'); assert.equal(unavailable.available, false);
    assert.equal(unavailable.metrics, null); assert.equal(unavailable.checkedAt, null);
    assert.equal(unavailable.failureCode, 'analytics_unavailable');
    assert.equal(JSON.stringify(unavailable).includes('private-provider-error'), false);
  }
  const empty = await collectDailyUsage(env, { now, fetcher: async () => Response.json(payload({ workersInvocationsAdaptive: [], durableObjectsInvocationsAdaptiveGroups: [], durableObjectsPeriodicGroups: [] })) });
  assert.equal(empty.status, 'ready');
  assert.ok(Object.values(empty.metrics).every(metric => metric.used === 0 && metric.level === 'normal'));
});

async function createRuntime() {
  const instance = new Miniflare({
    unsafeInspectDurableObjects: true,
    workers: [{ config: {
      name: 'daily-usage-test', compatibilityDate: '2026-10-23',
      manifest: { mainModule: 'harness.js', modules: {
        'index.js': { type: 'esm', contents: await readFile(new URL('../src/index.js', import.meta.url), 'utf8') },
        'daily-usage.js': { type: 'esm', contents: await readFile(new URL('../src/daily-usage.js', import.meta.url), 'utf8') },
        'harness.js': { type: 'esm', contents: `
          import worker, { PairingRegistry as ProductionRegistry } from './index.js';
          export { SyncRoom, FileShard } from './index.js';
          export default {
            async fetch(request, env) {
              const url = new URL(request.url);
              if (url.pathname === '/test-scheduled') {
                await worker.scheduled({cron:url.searchParams.get('cron')}, env);
                return Response.json({ok:true});
              }
              return worker.fetch(request, env);
            }
          };
          let calls = 0, fail = false;
          globalThis.fetch = async () => {
            calls += 1;
            await new Promise(resolve => setTimeout(resolve, 10));
            if (fail) throw new Error('private-provider-error');
            return Response.json(${JSON.stringify(payload(account))});
          };
          export class PairingRegistry extends ProductionRegistry {
            testAnalyticsCalls() { return calls; }
            testAnalyticsCacheUntil() { return this.dailyUsageCacheUntil; }
            maintainRooms() { this.maintenanceCalls = (this.maintenanceCalls || 0) + 1; return super.maintainRooms(); }
            testMaintenanceCalls() { return this.maintenanceCalls || 0; }
            testFailAnalytics() { fail = true; this.dailyUsageCacheUntil = 0; }
            testDropMemory() { this.dailyUsageSnapshotLoaded = false; this.dailyUsageCache = null; this.dailyUsageSnapshot = null; this.dailyUsageCacheUntil = 0; }
            async testSeedCache(value, expiresAt = 0) {
              this.dailyUsageSnapshot = value;
              this.dailyUsageSnapshotLoaded = true;
              this.dailyUsageCache = value;
              this.dailyUsageCacheUntil = expiresAt;
              await this.ctx.storage.put('dailyUsageCache', {value, snapshot:value, expiresAt});
            }
          }
        ` }
      } },
      env: {
        ALLOWED_ORIGINS: { type: 'text', value: 'https://lizuju.github.io' },
        CF_ACCOUNT_ID: { type: 'text', value: env.CF_ACCOUNT_ID },
        CF_ANALYTICS_TOKEN: { type: 'text', value: env.CF_ANALYTICS_TOKEN },
        PAIRING_REGISTRY: { type: 'durable-object', worker: 'daily-usage-test', exportName: 'PairingRegistry' },
        SYNC_ROOMS: { type: 'durable-object', worker: 'daily-usage-test', exportName: 'SyncRoom' },
        FILE_SHARDS: { type: 'durable-object', worker: 'daily-usage-test', exportName: 'FileShard' }
      },
      exports: Object.fromEntries(['PairingRegistry', 'SyncRoom', 'FileShard'].map(name => [name, { type: 'durable-object', storage: 'sqlite' }]))
    } }]
  });
  await instance.ready;
  return instance;
}

test('public status coalesces collection, restores persistent cache and isolates stale failures across UTC rollover', async t => {
  const runtime = await createRuntime(); t.after(() => runtime.dispose());
  const registry = (await runtime.getDurableObjectNamespace('PAIRING_REGISTRY')).getByName('registry');
  const status = async () => {
    const response = await runtime.dispatchFetch('https://sync.test/v1/status');
    assert.equal(response.status, 200);
    return response.json();
  };
  const results = await Promise.all(Array.from({ length: 5 }, status));
  assert.equal(await registry.testAnalyticsCalls(), 1);
  assert.ok(results.every(result => result.ok && result.dailyUsage.status === 'ready'));
  const cacheRemaining = await registry.testAnalyticsCacheUntil() - Date.now();
  assert.ok(cacheRemaining > 14 * 60 * 1000 && cacheRemaining <= 15 * 60 * 1000);
  const persisted = { ...results[0].dailyUsage, checkedAt: Date.now() - 20000 };
  await registry.testSeedCache(persisted, Date.now() + 60000);
  await registry.testDropMemory();
  assert.deepEqual((await status()).dailyUsage, persisted);
  await registry.testSeedCache(persisted);
  await registry.testFailAnalytics();
  const failed = await status();
  assert.equal(failed.ok, true); assert.equal(failed.dailyUsage.status, 'stale'); assert.equal(failed.dailyUsage.available, true);
  assert.equal(failed.dailyUsage.checkedAt, persisted.checkedAt); assert.deepEqual(failed.dailyUsage.metrics, persisted.metrics);
  const failedCalls = await registry.testAnalyticsCalls();
  await status(); assert.equal(await registry.testAnalyticsCalls(), failedCalls);
  await registry.testDropMemory();
  assert.equal((await status()).dailyUsage.status, 'stale');
  const old = { ...persisted, day: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10) };
  await registry.testSeedCache(old, Date.now() + 60000);
  const rollover = await status();
  assert.equal(rollover.dailyUsage.day, new Date().toISOString().slice(0, 10));
  assert.equal(rollover.dailyUsage.status, 'unavailable'); assert.equal(rollover.dailyUsage.available, false);
  assert.equal(rollover.dailyUsage.metrics, null); assert.equal(rollover.dailyUsage.checkedAt, null);
  const publicJson = JSON.stringify(rollover);
  for (const privateValue of [env.CF_ACCOUNT_ID, env.CF_ANALYTICS_TOKEN, 'private-provider-error']) assert.equal(publicJson.includes(privateValue), false);
  const health = await runtime.dispatchFetch('https://sync.test/health');
  assert.equal(health.status, 200); assert.equal((await health.json()).ok, true);
});

test('daily maintenance never collects account analytics in the background', async t => {
  const runtime = await createRuntime(); t.after(() => runtime.dispose());
  const registry = (await runtime.getDurableObjectNamespace('PAIRING_REGISTRY')).getByName('registry');
  const scheduled = cron => runtime.dispatchFetch(`https://sync.test/test-scheduled?cron=${encodeURIComponent(cron)}`);
  await registry.testFailAnalytics();
  assert.equal((await scheduled('17 0 * * *')).status, 200);
  assert.equal(await registry.testAnalyticsCalls(), 0); assert.equal(await registry.testMaintenanceCalls(), 1);
  const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.deepEqual(config.triggers.crons, ['17 0 * * *']);
});
