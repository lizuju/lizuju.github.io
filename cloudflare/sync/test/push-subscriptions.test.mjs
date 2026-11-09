import assert from 'node:assert/strict';
import { createECDH, createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { Miniflare } from 'miniflare';

const origin = 'https://lizuju.github.io';
const workerName = 'push-subscriptions';
const vapid = createECDH('prime256v1');
vapid.generateKeys();
const envValues = {
  ALLOWED_ORIGINS: origin,
  PUSH_VAPID_PUBLIC_KEY: vapid.getPublicKey().toString('base64url'),
  PUSH_VAPID_PRIVATE_KEY: vapid.getPrivateKey().toString('base64url'),
  PUSH_VAPID_SUBJECT: 'https://lizuju.github.io/chat/'
};
const cipher = keyId => `e2ee1.${Buffer.from(JSON.stringify({ keyId, iv: randomBytes(12).toString('base64url'), ciphertext: randomBytes(64).toString('base64url') })).toString('base64url')}`;
const subscription = (id = randomUUID()) => ({ endpoint: `https://web.push.apple.com/${id}`, expirationTime: null,
  keys: { p256dh: vapid.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } });
let runtime;

before(async () => {
  const state = `export const state = { calls: [], status: 201, hold: false, releases: [], active: 0, maximum: 0, retryAfterMs: 0 };
    export async function deliver(subscription, payload, { signal } = {}) {
      const call = { endpoint: subscription.endpoint, payload, cancelled: false };
      state.calls.push(call); state.active++; state.maximum = Math.max(state.maximum, state.active);
      try {
        if (state.hold) await new Promise((resolve, reject) => {
          const abort = () => { call.cancelled = true; reject(new DOMException('Cancelled', 'AbortError')); };
          if (signal.aborted) return abort();
          signal.addEventListener('abort', abort, { once: true });
          state.releases.push(() => { signal.removeEventListener('abort', abort); resolve(); });
        });
        return { status: state.status, retryAfterMs: state.retryAfterMs };
      } finally { state.active--; }
    }`;
  runtime = new Miniflare({ unsafeInspectDurableObjects: true, workers: [{ config: {
    name: workerName, compatibilityDate: '2026-10-23', manifest: { mainModule: 'harness.js', modules: {
      'index.js': { type: 'esm', contents: await readFile(new URL('../src/index.js', import.meta.url), 'utf8') },
      'api-version.js': { type: 'esm', contents: await readFile(new URL('../src/api-version.js', import.meta.url), 'utf8') },
      'daily-usage.js': { type: 'esm', contents: await readFile(new URL('../src/daily-usage.js', import.meta.url), 'utf8') },
      'web-push-transport.js': { type: 'esm', contents: await readFile(new URL('../src/web-push.js', import.meta.url), 'utf8') },
      'push-state.js': { type: 'esm', contents: state },
      'web-push.js': { type: 'esm', contents: `export { getPushPublicKey, validatePushSubscription } from './web-push-transport.js'; import { deliver } from './push-state.js'; export const sendWebPush = (subscription, payload, env, options) => deliver(subscription, payload, options);` },
      'harness.js': { type: 'esm', contents: `import worker, { E2eeSyncRoom as ProductionRoom } from './index.js'; import { state } from './push-state.js';
        export { E2eePairingRegistry, E2eeFileShard } from './index.js';
        export class E2eeSyncRoom extends ProductionRoom {
          async testDrain() { await this.sendPushNotifications(); await this.scheduleAlarm(); }
          testRead(deviceId, messageId) { this.markRead(deviceId, messageId); }
          testForeground() { return [...this.foregroundDevices()]; }
          testExpireForeground() {
            for (const socket of this.ctx.getWebSockets()) {
              const state = socket.deserializeAttachment();
              state.foregroundTabs = Object.fromEntries(Object.keys(state.foregroundTabs || {}).map(id => [id, Date.now() - 1]));
              socket.serializeAttachment(state);
            }
          }
        }
        export default { async fetch(request, env) {
          const path = new URL(request.url).pathname;
          if (path === '/test/drain') { const { roomId } = await request.json(); await env.E2EE_SYNC_ROOMS.getByName(roomId).testDrain(); return Response.json({ ok: true }); }
          if (path === '/test/read') { const { roomId, deviceId, messageId } = await request.json(); await env.E2EE_SYNC_ROOMS.getByName(roomId).testRead(deviceId, messageId); return Response.json({ ok: true }); }
          if (path === '/test/expire-foreground') { const { roomId } = await request.json(); await env.E2EE_SYNC_ROOMS.getByName(roomId).testExpireForeground(); return Response.json({ ok: true }); }
          if (path === '/test/foreground') { const { roomId } = await request.json(); return Response.json(await env.E2EE_SYNC_ROOMS.getByName(roomId).testForeground()); }
          if (path === '/test/push') {
            if (request.method === 'POST') {
              const input = await request.json();
              if (input.reset) { state.calls.length = 0; state.maximum = state.active; }
              if (input.status !== undefined) state.status = input.status;
              if (input.retryAfterMs !== undefined) state.retryAfterMs = input.retryAfterMs;
              if (input.hold !== undefined) state.hold = input.hold;
              if (input.release) { const releases = state.releases.splice(0); for (const release of releases) release(); }
            }
            return Response.json({ calls: state.calls, active: state.active, maximum: state.maximum });
          }
          if (path === '/test/key-unconfigured') return worker.fetch(new Request('https://push.test/v1/push/key'), { ...env, PUSH_VAPID_PRIVATE_KEY: undefined });
          return worker.fetch(request, env);
        } };` }
    } }, env: { ...Object.fromEntries(Object.entries(envValues).map(([key, value]) => [key, { type: 'text', value }])),
      ...Object.fromEntries(['E2eePairingRegistry', 'E2eeSyncRoom', 'E2eeFileShard'].map((name, index) => [['E2EE_PAIRING_REGISTRY', 'E2EE_SYNC_ROOMS', 'E2EE_FILE_SHARDS'][index], { type: 'durable-object', worker: workerName, exportName: name }])) },
    exports: Object.fromEntries(['E2eePairingRegistry', 'E2eeSyncRoom', 'E2eeFileShard'].map(name => [name, { type: 'durable-object', storage: 'sqlite' }]))
  } }] });
  await runtime.ready;
});
after(() => runtime?.dispose());

async function request(path, device, { method = 'GET', body } = {}) {
  const response = await runtime.dispatchFetch(`https://push.test${path}`, { method,
    headers: { Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': randomUUID(),
      ...(device ? { Authorization: `Bearer ${device.token}`, 'X-Sync-Key-Id': device.keyId } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
const control = async (body) => (await request('/test/push', null, body ? { method: 'POST', body } : {})).body;
async function waitFor(predicate, read = control) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await read();
    if (predicate(result)) return result;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Push condition not reached');
}
async function room(peerCount = 1) {
  const keyId = randomUUID();
  const created = await request('/v1/spaces', null, { method: 'POST', body: { keyId } });
  assert.equal(created.status, 201);
  const host = { ...created.body, keyId };
  const storage = await runtime.unsafeGetDurableObjectStorage(workerName, 'E2eeSyncRoom', { name: host.roomId });
  const peers = [];
  for (let i = 0; i < peerCount; i++) {
    const peer = { roomId: host.roomId, deviceId: randomUUID(), token: randomBytes(32).toString('hex'), keyId };
    await storage.exec('INSERT INTO devices (token_hash, device_id, created_at, last_active_at) VALUES (?, ?, ?, ?)', createHash('sha256').update(peer.token).digest('hex'), peer.deviceId, Date.now(), Date.now());
    peers.push(peer);
  }
  return { host, peers, storage, path: `/v1/spaces/${host.roomId}` };
}
const subscribe = (path, device, sub = subscription(), language = 'zh-CN') => request(`${path}/push-subscription`, device, { method: 'PUT', body: { subscription: sub, language } });
const send = (path, device, clientId = randomUUID()) => request(`${path}/messages`, device, { method: 'POST', body: { clientId, text: cipher(device.keyId) } });

test('exposes only the public key and binds validated subscriptions to authenticated room devices', async () => {
  assert.deepEqual(await request('/v1/push/key'), { status: 200, body: { publicKey: envValues.PUSH_VAPID_PUBLIC_KEY } });
  assert.deepEqual(await request('/test/key-unconfigured'), { status: 503, body: { error: 'push_unavailable' } });
  const { host, peers: [peer], storage, path } = await room();
  const sub = subscription();
  assert.equal((await subscribe(path, null, sub)).status, 401);
  assert.equal((await subscribe(path, host, { ...sub, endpoint: 'https://127.0.0.1/private' })).status, 400);
  assert.equal((await subscribe(path, host, sub, 'private-message')).status, 400);
  assert.equal((await subscribe(path, host, sub)).status, 200);
  assert.equal((await subscribe(path, host, sub)).status, 200);
  assert.deepEqual(await storage.exec('SELECT device_id, subscription, language FROM push_subscriptions'), [{ device_id: host.deviceId, subscription: JSON.stringify(sub), language: 'zh-CN' }]);
  assert.equal((await subscribe(path, peer)).status, 200);
  await request(`${path}/push-subscription`, host, { method: 'DELETE' });
  assert.deepEqual((await storage.exec('SELECT device_id FROM push_subscriptions')).map(row => row.device_id), [peer.deviceId]);
});

test('new encrypted messages notify other devices once without content', async () => {
  await control({ reset: true, status: 201, hold: false });
  const { host, peers: [peer], path } = await room();
  await subscribe(path, host);
  const target = subscription();
  await subscribe(path, peer, target, 'en');
  const clientId = randomUUID();
  const message = await send(path, host, clientId);
  assert.equal(message.status, 201);
  const delivered = await waitFor(state => state.calls.some(call => call.endpoint === target.endpoint));
  const call = delivered.calls.find(call => call.endpoint === target.endpoint);
  assert.deepEqual(call.payload, { roomId: host.roomId, messageId: message.body.id, language: 'en' });
  assert.equal((await send(path, host, clientId)).status, 200);
  assert.equal((await control()).calls.filter(call => call.payload.roomId === host.roomId).length, 1);
});

test('completed attachments notify once and retries do not create another push', async () => {
  await control({ reset: true, status: 201, hold: false });
  const { host, peers: [peer], path } = await room();
  const target = subscription();
  await subscribe(path, peer, target);
  const body = { clientId: randomUUID(), name: randomUUID(), type: 'application/octet-stream', size: 0, text: cipher(host.keyId), fingerprint: randomBytes(32).toString('hex') };
  const upload = await request(`${path}/files/uploads`, host, { method: 'POST', body });
  assert.equal(upload.status, 201);
  const complete = await request(`${path}/files/uploads/${upload.body.uploadId}/complete`, host, { method: 'POST', body: {} });
  assert.equal(complete.status, 201);
  await waitFor(state => state.calls.some(call => call.endpoint === target.endpoint));
  assert.equal((await request(`${path}/files/uploads/${upload.body.uploadId}/complete`, host, { method: 'POST', body: {} })).status, 200);
  assert.equal((await control()).calls.filter(call => call.endpoint === target.endpoint).length, 1);
});

test('expired endpoints are removed while transient authentication failures retain the subscription', async () => {
  const { host, peers: [peer], storage, path } = await room();
  for (const [status, expected] of [[401, 1], [410, 0]]) {
    await control({ reset: true, status, hold: false });
    const target = subscription();
    await subscribe(path, peer, target);
    await send(path, host);
    await waitFor(state => state.calls.some(call => call.endpoint === target.endpoint) && state.active === 0);
    assert.equal((await storage.exec('SELECT * FROM push_subscriptions')).length, expected);
  }
});

test('unsubscribe aborts in-flight work and three-way delivery rechecks queued subscriptions', async () => {
  await control({ reset: true, status: 201, hold: true });
  const { host, peers, storage, path } = await room(6);
  const targets = new Map();
  for (const peer of peers) { const sub = subscription(); targets.set(peer.deviceId, sub.endpoint); await subscribe(path, peer, sub); }
  assert.equal((await send(path, host)).status, 201);
  const started = await waitFor(state => state.active === 3);
  const active = peers.find(peer => started.calls.some(call => call.endpoint === targets.get(peer.deviceId)));
  const queued = peers.find(peer => !started.calls.some(call => call.endpoint === targets.get(peer.deviceId)));
  await request(`${path}/push-subscription`, queued, { method: 'DELETE' });
  await request(`${path}/push-subscription`, active, { method: 'DELETE' });
  await control({ hold: false, release: true });
  const final = await waitFor(state => state.active === 0);
  assert.equal(final.maximum, 3);
  assert.equal(final.calls.find(call => call.endpoint === targets.get(active.deviceId)).cancelled, true);
  assert.equal(final.calls.some(call => call.endpoint === targets.get(queued.deviceId)), false);
  assert.equal((await storage.exec('SELECT * FROM push_subscriptions')).length, 4);
});

test('device and room expiry release push subscriptions along with membership', async () => {
  await control({ reset: true, status: 201, hold: false });
  const { host, peers: [peer], storage, path } = await room();
  await subscribe(path, host); await subscribe(path, peer);
  await storage.exec('UPDATE devices SET last_active_at = ? WHERE device_id = ?', Date.now() - 8 * 86400000, peer.deviceId);
  assert.equal((await request(`${path}/push-subscription`, peer, { method: 'DELETE' })).status, 401);
  assert.deepEqual((await storage.exec('SELECT device_id FROM push_subscriptions')).map(row => row.device_id), [host.deviceId]);
  await storage.exec("UPDATE metadata SET value = ? WHERE key = 'lastMessageAt'", String(Date.now() - 15 * 86400000));
  await runtime.unsafeEvictDurableObject(workerName, 'E2eeSyncRoom', { name: host.roomId });
  assert.equal((await request(`${path}/push-subscription`, host, { method: 'DELETE' })).status, 401);
  assert.deepEqual(await storage.exec('SELECT * FROM push_subscriptions'), []);
});

const drain = host => request('/test/drain', null, { method: 'POST', body: { roomId: host.roomId } });

test('changing notification language preserves queued reminders and their retry deadline', async () => {
  await control({ reset: true, status: 503, hold: false, retryAfterMs: 60000 });
  const { host, peers: [peer], path, storage } = await room();
  const target = subscription();
  await subscribe(path, peer, target);
  await send(path, host);
  await waitFor(state => state.calls.length === 1 && state.active === 0);
  const queued = await storage.exec('SELECT * FROM push_queue');
  await subscribe(path, peer, target, 'en');
  assert.deepEqual(await storage.exec('SELECT * FROM push_queue'), queued);
  await control({ status: 201, retryAfterMs: 0 });
  await storage.exec('UPDATE push_queue SET due_at = ?', Date.now() - 1);
  await drain(host);
  const { calls } = await control();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].payload.language, 'en');
  assert.deepEqual(await storage.exec('SELECT * FROM push_queue'), []);
});

for (const change of ['language', 'endpoint']) test(`updating the ${change} during delivery retries with the current subscription`, async () => {
  await control({ reset: true, status: 201, hold: true, retryAfterMs: 0 });
  const { host, peers: [peer], path, storage } = await room();
  const original = subscription();
  const updated = change === 'endpoint' ? subscription() : original;
  await subscribe(path, peer, original);
  await send(path, host);
  await waitFor(state => state.active === 1);
  await control({ hold: false });
  await subscribe(path, peer, updated, 'en');
  const final = await waitFor(state => state.calls.length === 2 && state.active === 0);
  assert.equal(final.calls[0].cancelled, true);
  assert.equal(final.calls[1].endpoint, updated.endpoint);
  assert.equal(final.calls[1].payload.language, 'en');
  assert.equal(final.calls[1].payload.messageId, final.calls[0].payload.messageId);
  assert.deepEqual(await storage.exec('SELECT * FROM push_queue'), []);
  await control({ release: true });
});

test('coalesces bursts per recipient and limits the entire room to three deliveries', async () => {
  await control({ reset: true, status: 201, hold: true, retryAfterMs: 0 });
  const { host, peers, storage, path } = await room(3);
  for (const peer of peers) await subscribe(path, peer);
  for (let index = 0; index < 12; index++) await send(path, host);
  await waitFor(state => state.active === 3);
  await control({ hold: false, release: true });
  await waitFor(state => state.active === 0);
  await drain(host);
  const state = await control();
  assert.equal(state.maximum, 3);
  assert.ok(state.calls.length <= 6);
  assert.equal(new Set(state.calls.filter(call => call.payload.messageId === 12).map(call => call.endpoint)).size, 3);
  assert.deepEqual(await storage.exec('SELECT * FROM push_queue'), []);
});

test('rechecks queued recipients and cancels in-flight reminders when a read receipt arrives', async () => {
  await control({ reset: true, status: 201, hold: true });
  const { host, peers, storage, path } = await room(4);
  const targets = new Map();
  for (const peer of peers) { const target = subscription(); targets.set(peer.deviceId, target.endpoint); await subscribe(path, peer, target); }
  await send(path, host);
  const started = await waitFor(state => state.active === 3);
  const queued = peers.find(peer => !started.calls.some(call => call.endpoint === targets.get(peer.deviceId)));
  const active = peers.find(peer => started.calls.some(call => call.endpoint === targets.get(peer.deviceId)));
  for (const peer of [queued, active]) await request('/test/read', null, { method: 'POST', body: { roomId: host.roomId, deviceId: peer.deviceId, messageId: 1 } });
  await control({ hold: false, release: true });
  const final = await waitFor(state => state.active === 0);
  assert.equal(final.calls.length, 3);
  assert.equal(final.calls.find(call => call.endpoint === targets.get(active.deviceId)).cancelled, true);
  assert.deepEqual(await storage.exec('SELECT * FROM push_queue'), []);
});

test('temporary provider failures respect Retry-After and persist retries across room eviction', async () => {
  await control({ reset: true, status: 503, hold: false, retryAfterMs: 60000 });
  const { host, peers: [peer], storage, path } = await room();
  await subscribe(path, peer); await send(path, host);
  await waitFor(state => state.calls.length === 1 && state.active === 0);
  const [pending] = await storage.exec('SELECT * FROM push_queue');
  assert.equal(pending.attempts, 1);
  assert.ok(pending.due_at > Date.now() + 50000);
  await drain(host);
  assert.equal((await control()).calls.length, 1);
  await runtime.unsafeEvictDurableObject(workerName, 'E2eeSyncRoom', { name: host.roomId });
  await control({ status: 201, retryAfterMs: 0 });
  await storage.exec('UPDATE push_queue SET due_at = ?', Date.now() - 1);
  await drain(host);
  assert.equal((await control()).calls.length, 2);
  assert.deepEqual(await storage.exec('SELECT * FROM push_queue'), []);
});

test('retries are finite and expire or disappear when the message is cleared', async () => {
  await control({ reset: true, status: 503, hold: false, retryAfterMs: 60000 });
  const { host, peers: [peer], storage, path } = await room();
  await subscribe(path, peer); await send(path, host);
  await waitFor(state => state.calls.length === 1);
  for (let attempt = 0; attempt < 3; attempt++) {
    await storage.exec('UPDATE push_queue SET due_at = ?', Date.now() - 1);
    await drain(host);
  }
  assert.equal((await control()).calls.length, 4);
  assert.deepEqual(await storage.exec('SELECT * FROM push_queue'), []);
  await send(path, host);
  await storage.exec('UPDATE push_queue SET created_at = ?, due_at = ?', Date.now() - 3600001, Date.now() - 1);
  await drain(host);
  assert.equal((await control()).calls.length, 4);
  await send(path, host);
  await storage.exec('DELETE FROM messages');
  assert.deepEqual(await storage.exec('SELECT * FROM push_queue'), []);
  await control({ retryAfterMs: 0 });
});

test('foreground hints from shared tabs are independent and suppress push only while their lease is live', async () => {
  await control({ reset: true, status: 201, hold: false });
  const { host, peers: [peer], path, storage } = await room();
  await storage.exec('CREATE TABLE push_write_audit (operation TEXT)');
  await storage.exec("CREATE TRIGGER audit_push_insert AFTER INSERT ON push_queue BEGIN INSERT INTO push_write_audit VALUES ('insert'); END");
  await storage.exec("CREATE TRIGGER audit_push_update AFTER UPDATE ON push_queue BEGIN INSERT INTO push_write_audit VALUES ('update'); END");
  await subscribe(path, peer);
  const response = await runtime.dispatchFetch(`https://push.test${path}/socket`, { headers: { Origin: origin, Upgrade: 'websocket' } });
  const socket = response.webSocket;
  socket.accept();
  const ready = new Promise(resolve => socket.addEventListener('message', event => { if (JSON.parse(event.data).type === 'ready') resolve(); }));
  socket.send(JSON.stringify({ type: 'auth', token: peer.token }));
  await ready;
  const first = randomUUID(); const second = randomUUID();
  socket.send(JSON.stringify({ type: 'foreground', tabId: first, active: true }));
  socket.send(JSON.stringify({ type: 'foreground', tabId: second, active: false }));
  const foreground = async () => (await request('/test/foreground', null, { method: 'POST', body: { roomId: host.roomId } })).body;
  await waitFor(devices => devices.includes(peer.deviceId), foreground);
  for (let index = 0; index < 12; index++) await send(path, host);
  assert.deepEqual(await storage.exec('SELECT * FROM push_queue'), []);
  assert.deepEqual(await storage.exec('SELECT * FROM push_write_audit'), []);
  await storage.exec('UPDATE push_queue SET due_at = ?', Date.now() - 1);
  await drain(host);
  assert.equal((await control()).calls.length, 0);
  socket.send(JSON.stringify({ type: 'foreground', tabId: first, active: false }));
  await waitFor(devices => !devices.includes(peer.deviceId), foreground);
  await send(path, host);
  await storage.exec('UPDATE push_queue SET due_at = ?', Date.now() - 1);
  await drain(host);
  assert.equal((await control()).calls.length, 1);
  assert.equal((await storage.exec("SELECT * FROM push_write_audit WHERE operation = 'insert'")).length, 1);
  socket.send(JSON.stringify({ type: 'foreground', tabId: first, active: true }));
  await waitFor(devices => devices.includes(peer.deviceId), foreground);
  await send(path, host);
  assert.deepEqual(await storage.exec('SELECT * FROM push_queue'), []);
  await request('/test/expire-foreground', null, { method: 'POST', body: { roomId: host.roomId } });
  await send(path, host);
  await storage.exec('UPDATE push_queue SET due_at = ?', Date.now() - 1);
  await drain(host);
  assert.equal((await control()).calls.length, 2);
  socket.close();
});

test('clearing chat history cancels in-flight notifications and queued retries', async () => {
  await control({ reset: true, status: 201, hold: true, retryAfterMs: 0 });
  const { host, peers: [peer], storage, path } = await room();
  await subscribe(path, peer); await send(path, host);
  await waitFor(state => state.active === 1);
  assert.equal((await request(`${path}/messages`, host, { method: 'DELETE' })).status, 200);
  const final = await waitFor(state => state.active === 0);
  assert.equal(final.calls[0].cancelled, true);
  assert.deepEqual(await storage.exec('SELECT * FROM push_queue'), []);
  await control({ hold: false, release: true });
});
