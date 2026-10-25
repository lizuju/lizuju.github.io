import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import { encryptedClient } from './e2ee-client.mjs';

const origin = 'https://lizuju.github.io';
async function setup(t) {
  const runtime = new Miniflare({ unsafeInspectDurableObjects: true, workers: [{ config: {
    name: 'pair-settlement', compatibilityDate: '2026-10-23', manifest: { mainModule: 'harness.js', modules: {
      'index.js': { type: 'esm', contents: await readFile(new URL('../src/index.js', import.meta.url), 'utf8') },
      'daily-usage.js': { type: 'esm', contents: await readFile(new URL('../src/daily-usage.js', import.meta.url), 'utf8') },
      'harness.js': { type: 'esm', contents: `
        import { E2eeSyncRoom as Room, E2eePairingRegistry as Registry } from './index.js';
        export { default, E2eeFileShard } from './index.js';
        export class E2eePairingRegistry extends Registry {
          cancelPairing(...args) { this.cancellationCount = (this.cancellationCount || 0) + 1; const pending = super.cancelPairing(...args); this.cancelQueued?.(); return pending; }
          testWaitCancellation() { if (this.cancellationCount) return; return new Promise(resolve => { this.cancelQueued = resolve; }); }
        }
        export class E2eeSyncRoom extends Room {
          testAdmission(mode) {
            this.mode = mode;
            this.started = new Promise(resolve => { this.start = resolve; });
            this.gate = new Promise(resolve => { this.release = resolve; });
          }
          testWaitAdmission() { return this.started; }
          testReleaseAdmission() { this.release(); }
          async admitDevice(...args) {
            if (this.mode === 'late') { this.lateAdmission = args; throw new Error('test_delayed_admission'); }
            if (this.mode === 'hold-before') { this.start(); await this.gate; }
            const result = await super.admitDevice(...args);
            if (this.mode === 'hold-after') { this.start(); await this.gate; }
            if (this.mode === 'fail-after') { this.mode = null; throw new Error('test_lost_admission_reply'); }
            return result;
          }
          testReplayAdmission() { return super.admitDevice(...this.lateAdmission); }
        }`
      }
    } }, env: { ALLOWED_ORIGINS: { type: 'text', value: origin },
      ...Object.fromEntries([['E2EE_PAIRING_REGISTRY', 'E2eePairingRegistry'], ['E2EE_SYNC_ROOMS', 'E2eeSyncRoom'], ['E2EE_FILE_SHARDS', 'E2eeFileShard']].map(([key, name]) => [key, { type: 'durable-object', worker: 'pair-settlement', exportName: name }])) },
    exports: Object.fromEntries(['E2eePairingRegistry', 'E2eeSyncRoom', 'E2eeFileShard'].map(name => [name, { type: 'durable-object', storage: 'sqlite' }]))
  } }] });
  await runtime.ready;
  t.after(() => runtime.dispose());
  const dispatch = runtime.dispatchFetch.bind(runtime), control = {};
  runtime.dispatchFetch = async (url, options) => {
    const path = new URL(url).pathname;
    if (path === '/v1/pair' && options?.method === 'POST') control.pair = JSON.parse(options.body);
    if (path.endsWith('/pair-accept') && control.acceptGate) { control.acceptStarted(); await control.acceptGate; }
    if (path.endsWith('/ack')) return Response.json({ ok: true });
    return dispatch(url, options);
  };
  const request = encryptedClient(runtime, { origin });
  const owner = (await request('/v1/spaces', { method: 'POST' })).body;
  const registry = (await runtime.getDurableObjectNamespace('E2EE_PAIRING_REGISTRY')).getByName('registry');
  const room = (await runtime.getDurableObjectNamespace('E2EE_SYNC_ROOMS')).getByName(owner.roomId);
  const storage = await runtime.unsafeGetDurableObjectStorage('pair-settlement', 'E2eePairingRegistry', { name: 'registry' });
  const cancel = () => request.raw(`/v1/pair/${control.pair.requestId}`, { method: 'DELETE', token: control.pair.requestToken });
  const read = () => request.raw(`/v1/pair/${control.pair.requestId}`, { token: control.pair.requestToken });
  const join = () => request('/v1/pair', { method: 'POST', json: { code: owner.code } });
  const deviceCount = async () => (await request(`/v1/spaces/${owner.roomId}/devices`, { token: owner.token })).body.devices.length;
  const ack = async () => {
    const response = await dispatch(`https://sync.test/v1/pair/${control.pair.requestId}/ack`, { method: 'POST', headers: { Origin: origin, Authorization: `Bearer ${control.pair.requestToken}` } });
    return { status: response.status, body: await response.json() };
  };
  return { runtime, request, owner, registry, room, storage, control, join, cancel, read, deviceCount, ack };
}

test('cancelling before admission prevents enrolment and acknowledgement cannot delete an unfinished pairing', async t => {
  const state = await setup(t);
  const started = new Promise(resolve => { state.control.acceptStarted = resolve; });
  state.control.acceptGate = new Promise(resolve => { state.control.releaseAccept = resolve; });
  const joining = state.join();
  await started;
  assert.equal((await state.ack()).status, 409);
  const cancelled = await state.cancel();
  assert.equal(cancelled.status, 200); assert.equal(cancelled.body.cancelled, true);
  state.control.releaseAccept();
  assert.equal((await joining).status, 404);
  assert.equal(await state.deviceCount(), 1);
  assert.equal((await state.read()).status, 404);
});

test('a committed admission survives concurrent cancellation and pruning until its result is acknowledged', async t => {
  const state = await setup(t);
  await state.room.testAdmission('hold-after');
  const joining = state.join();
  await state.room.testWaitAdmission();
  const queued = state.registry.testWaitCancellation();
  const cancelling = state.cancel();
  await queued;
  await state.storage.exec('UPDATE pair_requests SET expires_at = ?, committing_until = ? WHERE request_id = ?', Date.now() - 1000, Date.now() - 1, state.control.pair.requestId);
  await state.request.raw('/v1/pair/offers');
  assert.deepEqual(await state.storage.exec('SELECT count(*) AS count FROM pair_requests'), [{ count: 1 }]);
  await state.room.testReleaseAdmission();
  const cancelled = await cancelling, joined = await joining;
  assert.equal(cancelled.status, 200); assert.equal(cancelled.body.cancelled, false);
  assert.match(cancelled.body.grant, /^pair1\./); assert.equal(joined.status, 200);
  assert.equal(await state.deviceCount(), 2);
  const repeated = await state.cancel();
  assert.equal(repeated.body.cancelled, false); assert.equal(repeated.body.grant, cancelled.body.grant);
  assert.equal((await state.read()).body.grant, cancelled.body.grant);
  assert.equal((await state.ack()).status, 200);
  assert.equal((await state.read()).status, 404);
});

test('a lost admission reply recovers after registry restart without the original invitation', async t => {
  const state = await setup(t);
  await state.room.testAdmission('fail-after');
  assert.equal((await state.join()).status, 500);
  await state.storage.exec('DELETE FROM offers');
  await state.storage.exec('UPDATE pair_requests SET expires_at = ? WHERE request_id = ?', Date.now() - 1, state.control.pair.requestId);
  await state.runtime.unsafeEvictDurableObject('pair-settlement', 'E2eePairingRegistry', { name: 'registry' });
  const recovered = await state.read();
  assert.equal(recovered.status, 200); assert.match(recovered.body.grant, /^pair1\./);
  assert.equal((await state.cancel()).body.grant, recovered.body.grant);
  assert.equal(await state.deviceCount(), 2);
  assert.equal((await state.ack()).status, 200);
  assert.equal((await state.read()).status, 404);
});

test('settling a committed admission also removes its stale invitation after a lost reply', async t => {
  const state = await setup(t);
  await state.room.testAdmission('fail-after');
  assert.equal((await state.join()).status, 500);
  assert.deepEqual(await state.storage.exec('SELECT count(*) AS count FROM offers'), [{ count: 1 }]);
  const settled = await state.cancel();
  assert.equal(settled.status, 200); assert.equal(settled.body.cancelled, false);
  assert.match(settled.body.grant, /^pair1\./);
  assert.deepEqual(await state.storage.exec('SELECT count(*) AS count FROM offers'), [{ count: 0 }]);
  assert.equal(await state.deviceCount(), 2);
});

test('successful cancellation fences a delayed admission even after an uncertain RPC failure', async t => {
  const state = await setup(t);
  await state.room.testAdmission('late');
  assert.equal((await state.join()).status, 500);
  const cancelled = await state.cancel();
  assert.equal(cancelled.status, 200); assert.equal(cancelled.body.cancelled, true);
  const replayed = await state.room.testReplayAdmission();
  assert.equal(replayed.error, 'code_expired');
  assert.equal(await state.deviceCount(), 1);
  assert.equal((await state.read()).status, 404);
});

test('a pending admission in one space does not block pairing another space', async t => {
  const state = await setup(t);
  await state.room.testAdmission('hold-before');
  const waiting = state.join();
  await state.room.testWaitAdmission();
  const other = encryptedClient(state.runtime, { origin, ip: '192.0.2.20' });
  const owner = (await other('/v1/spaces', { method: 'POST' })).body;
  const joined = await other('/v1/pair', { method: 'POST', json: { code: owner.code } });
  assert.equal(joined.status, 200);
  await state.room.testReleaseAdmission();
  assert.equal((await waiting).status, 200);
});
