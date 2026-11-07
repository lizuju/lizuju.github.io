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
  const state = `export const state = { calls: [], status: 201, hold: false, releases: [], active: 0, maximum: 0 };
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
        return { status: state.status };
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
      'harness.js': { type: 'esm', contents: `import worker from './index.js'; import { state } from './push-state.js';
        export { E2eeSyncRoom, E2eePairingRegistry, E2eeFileShard } from './index.js';
        export default { async fetch(request, env) {
          const path = new URL(request.url).pathname;
          if (path === '/test/push') {
            if (request.method === 'POST') {
              const input = await request.json();
              if (input.reset) { state.calls.length = 0; state.maximum = state.active; }
              if (input.status !== undefined) state.status = input.status;
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
async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await control();
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
