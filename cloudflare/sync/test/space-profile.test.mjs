import assert from 'node:assert/strict';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { Miniflare } from 'miniflare';

const workerName = 'sync-space-profile-test';
const origin = 'https://lizuju.github.io';
const sockets = new Set();
let runtime;
const cipher = keyId => `e2ee1.${Buffer.from(JSON.stringify({ keyId, iv: randomBytes(12).toString('base64url'), ciphertext: randomBytes(64).toString('base64url') })).toString('base64url')}`;

before(async () => {
  runtime = new Miniflare({ unsafeInspectDurableObjects: true, workers: [{ config: {
    name: workerName, compatibilityDate: '2026-10-23', manifest: { mainModule: 'index.js', modules: {
      'index.js': { type: 'esm', contents: await readFile(new URL('../src/index.js', import.meta.url), 'utf8') },
      'daily-usage.js': { type: 'esm', contents: await readFile(new URL('../src/daily-usage.js', import.meta.url), 'utf8') },
      'api-version.js': { type: 'esm', contents: await readFile(new URL('../src/api-version.js', import.meta.url), 'utf8') }
    } }, env: { ALLOWED_ORIGINS: { type: 'text', value: origin },
      ...Object.fromEntries([['E2EE_PAIRING_REGISTRY', 'E2eePairingRegistry'], ['E2EE_SYNC_ROOMS', 'E2eeSyncRoom'], ['E2EE_FILE_SHARDS', 'E2eeFileShard']]
        .map(([key, name]) => [key, { type: 'durable-object', worker: workerName, exportName: name }])) },
    exports: Object.fromEntries(['E2eePairingRegistry', 'E2eeSyncRoom', 'E2eeFileShard'].map(name => [name, { type: 'durable-object', storage: 'sqlite' }]))
  } }] });
  await runtime.ready;
});

after(async () => {
  for (const socket of sockets) if (socket.readyState === 1) socket.close();
  await runtime.dispose();
});

async function request(path, device, { method = 'GET', json, keyId = device?.keyId } = {}) {
  const response = await runtime.dispatchFetch(`https://sync.test${path}`, { method,
    headers: { Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': randomUUID(),
      ...(device ? { Authorization: `Bearer ${device.token}`, 'X-Sync-Key-Id': keyId } : {}) },
    ...(json === undefined ? {} : { body: JSON.stringify(json) }) });
  return { status: response.status, body: await response.json() };
}

async function room() {
  const keyId = randomUUID();
  const result = await request('/v1/spaces', null, { method: 'POST', json: { keyId } });
  assert.equal(result.status, 201);
  const host = { ...result.body, keyId };
  const storage = await runtime.unsafeGetDurableObjectStorage(workerName, 'E2eeSyncRoom', { name: host.roomId });
  const peer = { roomId: host.roomId, deviceId: randomUUID(), token: randomBytes(32).toString('hex'), keyId };
  await storage.exec('INSERT INTO devices (token_hash, device_id, created_at, last_active_at) VALUES (?, ?, ?, ?)',
    createHash('sha256').update(peer.token).digest('hex'), peer.deviceId, Date.now(), Date.now());
  return { host, peer, storage, path: `/v1/spaces/${host.roomId}` };
}

async function connect(device) {
  const response = await runtime.dispatchFetch(`https://sync.test/v1/spaces/${device.roomId}/socket`, { headers: { Origin: origin, Upgrade: 'websocket', 'CF-Connecting-IP': randomUUID() } });
  assert.equal(response.status, 101);
  const socket = response.webSocket;
  socket.accept();
  sockets.add(socket);
  const frames = [];
  const waits = [];
  socket.addEventListener('message', event => {
    const frame = JSON.parse(event.data);
    frames.push(frame);
    for (const wait of [...waits]) if (wait.predicate(frame)) { waits.splice(waits.indexOf(wait), 1); clearTimeout(wait.timer); wait.resolve(frame); }
  });
  const next = predicate => {
    const found = frames.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => waits.push({ predicate, resolve, timer: setTimeout(() => reject(new Error('Expected socket event')), 5000) }));
  };
  socket.send(JSON.stringify({ type: 'auth', token: device.token }));
  return { socket, next, frames, ready: await next(frame => frame.type === 'ready') };
}

test('shared encrypted names broadcast to all devices and survive reconnect, eviction and clearing chat', async () => {
  const { host, peer, storage, path } = await room();
  assert.deepEqual((await request(`${path}/profile`, host)).body, { profile: { name: null, revision: 0 } });
  assert.deepEqual((await request(path, peer)).body.spaceProfile, { name: null, revision: 0 });
  const first = await connect(host);
  const second = await connect(peer);
  assert.deepEqual(second.ready.spaceProfile, { name: null, revision: 0 });
  const name = cipher(host.keyId);
  const changed = await request(`${path}/profile`, host, { method: 'PATCH', json: { name } });
  assert.equal(changed.status, 200);
  assert.deepEqual(changed.body, { profile: { name, revision: 1 } });
  for (const client of [first, second]) assert.deepEqual((await client.next(frame => frame.type === 'space-profile')).profile, changed.body.profile);
  assert.deepEqual((await request(`${path}/profile`, peer)).body, changed.body);
  assert.deepEqual(await storage.exec("SELECT value FROM metadata WHERE key = 'spaceProfile'"), [{ value: JSON.stringify(changed.body.profile) }]);
  assert.equal((await request(`${path}/messages`, peer, { method: 'POST', json: { clientId: randomUUID(), text: cipher(host.keyId) } })).status, 201);
  assert.equal((await request(`${path}/messages`, peer, { method: 'DELETE' })).status, 200);
  assert.deepEqual((await request(`${path}/profile`, host)).body, changed.body);
  first.socket.close();
  second.socket.close();
  await runtime.unsafeEvictDurableObject(workerName, 'E2eeSyncRoom', { name: host.roomId });
  const restored = await connect(peer);
  assert.deepEqual(restored.ready.spaceProfile, changed.body.profile);
  assert.deepEqual((await request(path, peer)).body.spaceProfile, changed.body.profile);
  restored.socket.close();
});

test('space names require current membership and encrypted bounded input from the current epoch', async () => {
  const { host, peer, storage, path } = await room();
  const foreign = (await room()).host;
  for (const device of [null, foreign]) {
    assert.equal((await request(`${path}/profile`, device)).status, 401);
    assert.equal((await request(`${path}/profile`, device, { method: 'PATCH', json: { name: cipher(host.keyId) } })).status, 401);
  }
  for (const name of [null, '', '此名称是明文', `e2ee1.${'a'.repeat(4096)}`]) {
    const invalid = await request(`${path}/profile`, host, { method: 'PATCH', json: { name } });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error, 'invalid_name');
  }
  const wrongEpoch = randomUUID();
  for (const [keyId, name] of [[wrongEpoch, cipher(host.keyId)], [host.keyId, cipher(wrongEpoch)]]) {
    const invalid = await request(`${path}/profile`, host, { method: 'PATCH', keyId, json: { name } });
    assert.equal(invalid.status, 409);
    assert.equal(invalid.body.error, 'key_changed');
  }
  const changed = await request(`${path}/profile`, peer, { method: 'PATCH', json: { name: cipher(peer.keyId) } });
  assert.equal(changed.status, 200);
  await storage.exec("INSERT INTO metadata (key, value) VALUES ('rekeyRequired', '1')");
  assert.equal((await request(`${path}/profile`, host, { method: 'PATCH', json: { name: cipher(host.keyId) } })).body.error, 'rekey_required');
  assert.equal((await request(`${path}/device`, peer, { method: 'DELETE' })).status, 200);
  assert.equal((await request(`${path}/profile`, peer)).status, 401);
  assert.equal((await request(`${path}/profile`, peer, { method: 'PATCH', json: { name: cipher(host.keyId) } })).status, 401);
  assert.deepEqual((await request(`${path}/profile`, host)).body, changed.body);
});

test('concurrent names have strictly increasing revisions and duplicate ciphertext causes no write', async () => {
  const { host, peer, storage, path } = await room();
  const firstName = cipher(host.keyId);
  const first = await request(`${path}/profile`, host, { method: 'PATCH', json: { name: firstName } });
  assert.equal(first.status, 200);
  await storage.exec('CREATE TABLE profile_writes (revision INTEGER)');
  await storage.exec("CREATE TRIGGER count_profile_writes AFTER UPDATE ON metadata WHEN NEW.key = 'spaceProfile' BEGIN INSERT INTO profile_writes (revision) VALUES (json_extract(NEW.value, '$.revision')); END");
  const duplicate = await request(`${path}/profile`, peer, { method: 'PATCH', json: { name: firstName } });
  assert.deepEqual(duplicate.body, first.body);
  assert.deepEqual(await storage.exec('SELECT * FROM profile_writes'), []);
  const names = Array.from({ length: 8 }, () => cipher(host.keyId));
  const changed = await Promise.all(names.map((name, index) => request(`${path}/profile`, index % 2 ? host : peer, { method: 'PATCH', json: { name } })));
  assert.ok(changed.every(result => result.status === 200));
  const revisions = changed.map(result => result.body.profile.revision).sort((a, b) => a - b);
  assert.deepEqual(revisions, [2, 3, 4, 5, 6, 7, 8, 9]);
  const latest = changed.find(result => result.body.profile.revision === 9).body;
  assert.deepEqual((await request(`${path}/profile`, host)).body, latest);
  assert.deepEqual((await request(`${path}/profile`, peer)).body, latest);
  assert.equal((await storage.exec('SELECT * FROM profile_writes')).length, 8);
});
