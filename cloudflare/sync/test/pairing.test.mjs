import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { Miniflare } from 'miniflare';

const origin = 'https://lizuju.github.io';
const fiveDays = 5 * 24 * 60 * 60 * 1000;
let runtime;
let nextIp = 1;
const sockets = new Set();

before(async () => {
  runtime = await createRuntime();
});

async function createRuntime({ virtualMessageBytes = 0, virtualBaseBytes = 0 } = {}) {
  const instance = new Miniflare({
    unsafeInspectDurableObjects: true,
    workers: [{
      config: {
        name: 'sync-test',
        compatibilityDate: '2026-10-23',
        manifest: {
          mainModule: 'harness.js',
          modules: {
            'index.js': { type: 'esm', contents: await readFile(new URL('../src/index.js', import.meta.url), 'utf8') },
            'harness.js': {
              type: 'esm',
              contents: `import { SyncRoom as ProductionSyncRoom, PairingRegistry as ProductionRegistry } from './index.js';
                export { default } from './index.js';
                export class PairingRegistry extends ProductionRegistry {
                  testRunAlarm() { return super.alarm(); }
                  testReadAlarm() { return this.ctx.storage.getAlarm(); }
                  testDropAlarm() { return this.ctx.storage.deleteAlarm(); }
                }
                export class SyncRoom extends ProductionSyncRoom {
                  testRunAlarm() { return super.alarm(); }
                  testReadAlarm() { return this.ctx.storage.getAlarm(); }
                  storageUsage() {
                    const usage = super.storageUsage();
                    usage.bytes += ${virtualBaseBytes} + this.sql.exec('SELECT count(*) AS count FROM messages').one().count * ${virtualMessageBytes};
                    return usage;
                  }
                }`
            }
          }
        },
        env: {
          ALLOWED_ORIGINS: { type: 'text', value: origin },
          PAIRING_REGISTRY: { type: 'durable-object', worker: 'sync-test', exportName: 'PairingRegistry' },
          SYNC_ROOMS: { type: 'durable-object', worker: 'sync-test', exportName: 'SyncRoom' }
        },
        exports: {
          PairingRegistry: { type: 'durable-object', storage: 'sqlite' },
          SyncRoom: { type: 'durable-object', storage: 'sqlite' }
        }
      }
    }]
  });
  await instance.ready;
  return instance;
}

after(async () => {
  for (const socket of sockets) socket.close();
  await runtime?.dispose();
});

function client(instance = runtime) {
  const ip = `198.51.100.${nextIp++}`;
  return async (path, { method = 'GET', token, json, body, headers = {} } = {}) => {
    const requestHeaders = { Origin: origin, 'CF-Connecting-IP': ip, ...headers };
    if (token !== undefined) requestHeaders.Authorization = `Bearer ${token}`;
    if (json !== undefined) {
      requestHeaders['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    }
    const response = await instance.dispatchFetch(`https://sync.test${path}`, {
      method, headers: requestHeaders, body
    });
    return {
      status: response.status,
      headers: response.headers,
      body: response.headers.get('Content-Type')?.includes('application/json')
        ? await response.json()
        : await response.text()
    };
  };
}

async function createSpace(request = client()) {
  const result = await request('/v1/spaces', { method: 'POST' });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body;
}

async function openSocket(roomId, instance = runtime) {
  const response = await instance.dispatchFetch(`https://sync.test/v1/spaces/${roomId}/socket`, {
    headers: { Origin: origin, Upgrade: 'websocket', 'CF-Connecting-IP': `203.0.113.${nextIp++}` }
  });
  assert.equal(response.status, 101, response.status === 101 ? undefined : await response.text());
  const socket = response.webSocket;
  socket.accept();
  sockets.add(socket);
  socket.addEventListener('close', () => sockets.delete(socket));
  return socket;
}

function socketEvent(socket, type = 'message', timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeEventListener(type, onEvent);
      reject(new Error(`WebSocket ${type} event did not arrive`));
    }, timeout);
    function onEvent(event) {
      clearTimeout(timer);
      socket.removeEventListener(type, onEvent);
      resolve(event);
    }
    socket.addEventListener(type, onEvent);
  });
}

async function authenticateSocket(space, instance = runtime) {
  const socket = await openSocket(space.roomId, instance);
  const ready = socketEvent(socket);
  socket.send(JSON.stringify({ type: 'auth', token: space.token }));
  const frame = JSON.parse((await ready).data);
  assert.equal(frame.type, 'ready');
  assert.equal(frame.deviceId, space.deviceId);
  return { socket, frame };
}

test('a four-digit invitation gives each device its own credential for the same space', async () => {
  const first = client();
  const second = client();
  const third = client();
  const startedAt = Date.now();
  const created = await createSpace(first);
  assert.match(created.code, /^\d{4}$/);
  assert.match(created.token, /^[0-9a-f]{64}$/);
  assert.ok(created.expiresAt > startedAt);
  assert.ok(created.expiresAt <= Date.now() + 10 * 60 * 1000);

  const joined = await second('/v1/pair', { method: 'POST', json: { code: created.code } });
  const joinedAgain = await third('/v1/pair', { method: 'POST', json: { code: created.code } });
  assert.equal(joined.status, 200);
  assert.equal(joinedAgain.status, 200);
  assert.equal(joined.body.roomId, created.roomId);
  assert.equal(joinedAgain.body.roomId, created.roomId);
  assert.match(joined.body.token, /^[0-9a-f]{64}$/);
  assert.equal(new Set([created.token, joined.body.token, joinedAgain.body.token]).size, 3);

  for (const token of [created.token, joined.body.token, joinedAgain.body.token]) {
    const info = await first(`/v1/spaces/${created.roomId}`, { token });
    assert.equal(info.status, 200);
    assert.equal(info.body.roomId, created.roomId);
    assert.ok(info.body.createdAt >= startedAt);
    assert.equal(info.headers.get('Cache-Control'), 'no-store');
  }

  const storage = await runtime.unsafeGetDurableObjectStorage('sync-test', 'SyncRoom', { name: created.roomId });
  const stored = await storage.exec('SELECT token_hash FROM devices');
  assert.equal(stored.length, 3);
  assert.ok(stored.every(row => ![created.token, joined.body.token, joinedAgain.body.token].includes(row.token_hash)));
});

test('credentials stay isolated between spaces and reject missing or forged tokens', async () => {
  const request = client();
  const a = await createSpace(request);
  const b = await createSpace(request);
  assert.notEqual(a.roomId, b.roomId);
  assert.notEqual(a.code, b.code);
  for (const token of [undefined, '', '1234', '0'.repeat(64), b.token]) {
    const result = await request(`/v1/spaces/${a.roomId}`, { token });
    assert.equal(result.status, 401);
    assert.equal(result.body.error, 'unauthorized');
  }
  const rotate = await request(`/v1/spaces/${a.roomId}/pair-code`, { method: 'POST', token: b.token });
  assert.equal(rotate.status, 401);
});

test('device lists identify the current device without exposing credentials or another space', async () => {
  const request = client();
  const startedAt = Date.now();
  const space = await createSpace(request);
  const paired = await client()('/v1/pair', { method: 'POST', json: { code: space.code } });
  assert.equal(paired.status, 200);
  const unrelated = await createSpace();

  for (const device of [space, paired.body]) {
    const result = await request(`/v1/spaces/${space.roomId}/devices`, { token: device.token });
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(Object.keys(result.body).sort(), ['deviceId', 'devices']);
    assert.equal(result.body.deviceId, device.deviceId);
    assert.deepEqual(result.body.devices.map(value => value.deviceId).sort(), [space.deviceId, paired.body.deviceId].sort());
    for (const listed of result.body.devices) {
      assert.deepEqual(Object.keys(listed).sort(), ['createdAt', 'deviceId', 'name']);
      assert.equal(listed.name, '');
      assert.ok(listed.createdAt >= startedAt && listed.createdAt <= Date.now());
    }
    assert.ok(!JSON.stringify(result.body).includes(space.token));
    assert.ok(!JSON.stringify(result.body).includes(paired.body.token));
  }

  for (const token of [undefined, '', '0'.repeat(64), unrelated.token]) {
    for (const [method, suffix, json] of [
      ['GET', '', undefined],
      ['PATCH', `/${space.deviceId}`, { name: 'intrusion' }],
      ['DELETE', `/${space.deviceId}`, undefined]
    ]) {
      const denied = await request(`/v1/spaces/${space.roomId}/devices${suffix}`, { method, token, json });
      assert.equal(denied.status, 401);
      assert.equal(denied.body.error, 'unauthorized');
    }
  }
  const unchanged = await request(`/v1/spaces/${space.roomId}/devices`, { token: space.token });
  assert.equal(unchanged.body.devices.length, 2);
  assert.ok(unchanged.body.devices.every(device => device.name === ''));
});

test('every paired device can rename itself or a peer and names validate UTF-16 length', async () => {
  const request = client();
  const space = await createSpace(request);
  const paired = await client()('/v1/pair', { method: 'POST', json: { code: space.code } });
  assert.equal(paired.status, 200);
  const path = `/v1/spaces/${space.roomId}/devices`;
  const own = await request(`${path}/${space.deviceId}`, {
    method: 'PATCH', token: space.token, json: { name: '  我的 Mac  ' }
  });
  assert.equal(own.status, 200);
  assert.deepEqual(own.body, { ok: true });
  let listed = await request(path, { token: space.token });
  assert.equal(listed.body.devices.find(device => device.deviceId === space.deviceId).name, '我的 Mac');
  const peer = await request(`${path}/${space.deviceId}`, {
    method: 'PATCH', token: paired.body.token, json: { name: '另一台电脑' }
  });
  assert.equal(peer.status, 200);
  listed = await request(path, { token: space.token });
  assert.equal(listed.body.devices.find(device => device.deviceId === space.deviceId).name, '另一台电脑');

  for (const name of ['x'.repeat(60), '🤖'.repeat(30), '', ' \t\n ']) {
    const renamed = await request(`${path}/${paired.body.deviceId}`, {
      method: 'PATCH', token: space.token, json: { name }
    });
    assert.equal(renamed.status, 200, JSON.stringify(name));
    listed = await request(path, { token: paired.body.token });
    assert.equal(listed.body.devices.find(device => device.deviceId === paired.body.deviceId).name, name.trim());
  }

  for (const json of [{}, { name: null }, { name: 123 }, { name: [] }, { name: {} },
    { name: 'x'.repeat(61) }, { name: '🤖'.repeat(31) }, { name: ` ${'x'.repeat(60)}` }]) {
    const invalid = await request(`${path}/${paired.body.deviceId}`, {
      method: 'PATCH', token: space.token, json
    });
    assert.equal(invalid.status, 400, JSON.stringify(json));
    assert.equal(invalid.body.error, 'invalid_name');
  }
  listed = await request(path, { token: space.token });
  assert.equal(listed.body.devices.find(device => device.deviceId === paired.body.deviceId).name, '');
  for (const method of ['PATCH', 'DELETE']) {
    const missing = await request(`${path}/${randomUUID()}`, {
      method, token: space.token, json: method === 'PATCH' ? { name: 'missing' } : undefined
    });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, 'device_not_found');
  }
});

test('device names migrate from the old schema without revoking existing credentials', async () => {
  const request = client();
  const space = await createSpace(request);
  const paired = await client()('/v1/pair', { method: 'POST', json: { code: space.code } });
  assert.equal(paired.status, 200);
  const sent = await request(`/v1/spaces/${space.roomId}/messages`, {
    method: 'POST', token: space.token, json: { clientId: randomUUID(), text: 'preserved through migration' }
  });
  assert.equal(sent.status, 201);
  const storage = await runtime.unsafeGetDurableObjectStorage('sync-test', 'SyncRoom', { name: space.roomId });
  const devices = await storage.exec('SELECT token_hash, device_id, created_at FROM devices');
  await storage.exec('DROP TABLE devices');
  await storage.exec('CREATE TABLE devices (token_hash TEXT PRIMARY KEY, device_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL)');
  for (const device of devices) {
    await storage.exec('INSERT INTO devices (token_hash, device_id, created_at) VALUES (?, ?, ?)', device.token_hash, device.device_id, device.created_at);
  }
  await runtime.unsafeEvictDurableObject('sync-test', 'SyncRoom', { name: space.roomId });

  for (const device of [space, paired.body]) {
    const listed = await request(`/v1/spaces/${space.roomId}/devices`, { token: device.token });
    assert.equal(listed.status, 200);
    assert.equal(listed.body.deviceId, device.deviceId);
    assert.equal(listed.body.devices.length, 2);
    assert.ok(listed.body.devices.every(value => value.name === ''));
    const state = await request(`/v1/spaces/${space.roomId}`, { token: device.token });
    assert.equal(state.status, 200);
    assert.deepEqual(state.body.messages, [sent.body]);
  }
  const renamed = await request(`/v1/spaces/${space.roomId}/devices/${space.deviceId}`, {
    method: 'PATCH', token: paired.body.token, json: { name: '迁移后的 Mac' }
  });
  assert.equal(renamed.status, 200);
  await runtime.unsafeEvictDurableObject('sync-test', 'SyncRoom', { name: space.roomId });
  const reloaded = await request(`/v1/spaces/${space.roomId}/devices`, { token: space.token });
  assert.equal(reloaded.status, 200);
  assert.equal(reloaded.body.devices.find(device => device.deviceId === space.deviceId).name, '迁移后的 Mac');
  assert.equal((await storage.exec('PRAGMA table_info(devices)')).filter(column => column.name === 'name').length, 1);
});

test('unregistered room IDs reject forged HTTP credentials and sockets without allocating SQLite databases', async t => {
  const instance = await createRuntime();
  t.after(() => instance.dispose());
  const request = client(instance);
  await createSpace(request);
  const registry = await instance.unsafeGetDurableObjectStorage('sync-test', 'PairingRegistry', { name: 'registry' });
  const usage = await registry.exec('SELECT room_id, bytes, oldest_at FROM room_usage ORDER BY room_id');
  const databases = await instance.listDurableObjectIds('SYNC_ROOMS');
  assert.equal(databases.length, 1);

  for (const [method, suffix, json] of [
    ['GET', '', undefined],
    ['POST', '/messages', { clientId: randomUUID(), text: 'forged' }],
    ['POST', '/pair-code', undefined],
    ['DELETE', '/device', undefined],
    ['GET', '/devices', undefined],
    ['PATCH', `/devices/${randomUUID()}`, { name: 'forged' }],
    ['DELETE', `/devices/${randomUUID()}`, undefined]
  ]) {
    const rejected = await request(`/v1/spaces/${randomUUID()}${suffix}`, {
      method, token: '0'.repeat(64), json
    });
    assert.equal(rejected.status, 404);
    assert.equal(rejected.body.error, 'not_found');
  }
  const socket = await request(`/v1/spaces/${randomUUID()}/socket`, {
    token: '0'.repeat(64), headers: { Upgrade: 'websocket' }
  });
  assert.equal(socket.status, 404);
  assert.equal(socket.body.error, 'not_found');
  assert.deepEqual(await instance.listDurableObjectIds('SYNC_ROOMS'), databases);
  assert.deepEqual(await registry.exec('SELECT room_id, bytes, oldest_at FROM room_usage ORDER BY room_id'), usage);
});

test('pairing accepts exactly four ASCII digits supplied as a string', async () => {
  for (const code of ['1', '123', '12345', ' 1234', '1234 ', '１２３４', '12a4', 1234, null, {}, []]) {
    const result = await client()('/v1/pair', { method: 'POST', json: { code } });
    assert.equal(result.status, 400, JSON.stringify(code));
    assert.equal(result.body.error, 'invalid_code');
  }
});

test('malformed and oversized pairing requests are rejected at the HTTP boundary', async () => {
  const request = client();
  for (const body of ['{', 'null', '[]']) {
    const result = await request('/v1/pair', {
      method: 'POST', body, headers: { 'Content-Type': 'application/json' }
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.error, 'invalid_json');
  }
  const oversized = await request('/v1/pair', { method: 'POST', json: { code: '1'.repeat(1024) } });
  assert.equal(oversized.status, 413);
  const wrongType = await request('/v1/pair', { method: 'POST', body: '{"code":"1234"}' });
  assert.equal(wrongType.status, 400);
});

test('an expired invitation rejects new devices while existing devices keep access', async () => {
  const owner = client();
  const space = await createSpace(owner);
  const registry = await runtime.unsafeGetDurableObjectStorage('sync-test', 'PairingRegistry', { name: 'registry' });
  await registry.exec('UPDATE invites SET expires_at = ? WHERE code = ?', Date.now() - 1, space.code);

  const joined = await client()('/v1/pair', { method: 'POST', json: { code: space.code } });
  assert.equal(joined.status, 404);
  assert.equal(joined.body.error, 'code_expired');
  const info = await owner(`/v1/spaces/${space.roomId}`, { token: space.token });
  assert.equal(info.status, 200);
});

test('rotating an invitation revokes the old code without revoking paired devices', async () => {
  const owner = client();
  const space = await createSpace(owner);
  const device = client();
  const joined = await device('/v1/pair', { method: 'POST', json: { code: space.code } });
  assert.equal(joined.status, 200);

  const rotated = await owner(`/v1/spaces/${space.roomId}/pair-code`, { method: 'POST', token: space.token });
  assert.equal(rotated.status, 200);
  assert.match(rotated.body.code, /^\d{4}$/);
  assert.notEqual(rotated.body.code, space.code);
  assert.ok(rotated.body.expiresAt > Date.now());
  const oldCode = await client()('/v1/pair', { method: 'POST', json: { code: space.code } });
  assert.equal(oldCode.status, 404);
  const newCode = await client()('/v1/pair', { method: 'POST', json: { code: rotated.body.code } });
  assert.equal(newCode.status, 200);
  assert.equal(newCode.body.roomId, space.roomId);
  const info = await device(`/v1/spaces/${space.roomId}`, { token: joined.body.token });
  assert.equal(info.status, 200);

  const tooSoon = await owner(`/v1/spaces/${space.roomId}/pair-code`, { method: 'POST', token: space.token });
  assert.equal(tooSoon.status, 429);
  assert.ok(Number(tooSoon.headers.get('Retry-After')) > 0);
});

test('creation is rate limited per IP while another IP can still create a space', async () => {
  const request = client();
  for (let index = 0; index < 5; index += 1) await createSpace(request);
  const limited = await request('/v1/spaces', { method: 'POST' });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, 'rate_limited');
  assert.ok(Number(limited.headers.get('Retry-After')) > 0);
  await createSpace(client());
});

test('pairing attempts are rate limited and resume after the limit expires', async () => {
  const space = await createSpace();
  const request = client();
  for (let index = 0; index < 5; index += 1) {
    const result = await request('/v1/pair', { method: 'POST', json: { code: 'invalid' } });
    assert.equal(result.status, 400);
  }
  const limited = await request('/v1/pair', { method: 'POST', json: { code: space.code } });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('Retry-After')) > 0);
  const independent = await client()('/v1/pair', { method: 'POST', json: { code: space.code } });
  assert.equal(independent.status, 200);

  const registry = await runtime.unsafeGetDurableObjectStorage('sync-test', 'PairingRegistry', { name: 'registry' });
  await registry.exec('UPDATE attempts SET expires_at = ? WHERE key LIKE ?', Date.now() - 1, 'pair:%');
  const resumed = await request('/v1/pair', { method: 'POST', json: { code: space.code } });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.roomId, space.roomId);
});

test('the allowed website can preflight authorization and an unrelated origin is rejected', async () => {
  const request = client();
  const preflight = await request('/v1/pair', { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), origin);
  assert.match(preflight.headers.get('Access-Control-Allow-Headers'), /Authorization/);
  assert.match(preflight.headers.get('Access-Control-Allow-Methods'), /\bPATCH\b/);
  const forbidden = await request('/v1/spaces', { method: 'POST', headers: { Origin: 'https://unrelated.example' } });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.headers.get('Access-Control-Allow-Origin'), null);
});

test('paired devices append concurrent messages without overwriting and retries do not duplicate', async () => {
  const first = client();
  const second = client();
  const space = await createSpace(first);
  const paired = await second('/v1/pair', { method: 'POST', json: { code: space.code } });
  const other = paired.body;
  const clientId = randomUUID();
  const initial = await first(`/v1/spaces/${space.roomId}/messages`, {
    method: 'POST', token: space.token, json: { clientId, text: '123\n中文 🎹' }
  });
  assert.equal(initial.status, 201);
  assert.equal(initial.body.deviceId, space.deviceId);
  assert.equal(initial.body.text, '123\n中文 🎹');

  const retry = await first(`/v1/spaces/${space.roomId}/messages`, {
    method: 'POST', token: space.token, json: { clientId, text: 'changed after retry' }
  });
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.body, initial.body);
  const sameIdOtherDevice = await second(`/v1/spaces/${space.roomId}/messages`, {
    method: 'POST', token: other.token, json: { clientId, text: 'separate device' }
  });
  assert.equal(sameIdOtherDevice.status, 201);

  const sent = await Promise.all(Array.from({ length: 8 }, (_, index) => {
    return (index % 2 ? first : second)(`/v1/spaces/${space.roomId}/messages`, {
      method: 'POST', token: index % 2 ? space.token : other.token,
      json: { clientId: randomUUID(), text: `concurrent ${index}` }
    });
  }));
  assert.ok(sent.every(result => result.status === 201));
  const state = await second(`/v1/spaces/${space.roomId}`, { token: other.token });
  assert.equal(state.status, 200);
  assert.equal(state.body.messages.length, 10);
  assert.deepEqual(state.body.messages.map(message => message.id), Array.from({ length: 10 }, (_, index) => index + 1));
  assert.equal(new Set(state.body.messages.map(message => message.text)).size, 10);
  const refreshed = await first(`/v1/spaces/${space.roomId}`, { token: space.token });
  assert.deepEqual(refreshed.body.messages, state.body.messages);
});

test('message input validates at the API boundary and another space cannot send or clear', async () => {
  const request = client();
  const space = await createSpace(request);
  const unrelated = await createSpace(request);
  for (const text of ['', ' \n\t ', null, 123, 'x'.repeat(10001)]) {
    const result = await request(`/v1/spaces/${space.roomId}/messages`, {
      method: 'POST', token: space.token, json: { clientId: randomUUID(), text }
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.error, 'invalid_text');
  }
  const invalidId = await request(`/v1/spaces/${space.roomId}/messages`, {
    method: 'POST', token: space.token, json: { clientId: '1234', text: 'valid text' }
  });
  assert.equal(invalidId.status, 400);
  const maximum = await request(`/v1/spaces/${space.roomId}/messages`, {
    method: 'POST', token: space.token, json: { clientId: randomUUID(), text: '中'.repeat(10000) }
  });
  assert.equal(maximum.status, 201);
  const forbidden = await request(`/v1/spaces/${space.roomId}/messages`, {
    method: 'POST', token: unrelated.token, json: { clientId: randomUUID(), text: 'intrusion' }
  });
  assert.equal(forbidden.status, 401);
  const clear = await request(`/v1/spaces/${space.roomId}/messages`, { method: 'DELETE', token: unrelated.token });
  assert.equal(clear.status, 401);
  const state = await request(`/v1/spaces/${space.roomId}`, { token: space.token });
  assert.equal(state.body.messages.length, 1);
});

test('WebSocket authentication restores history, broadcasts messages and synchronizes clearing', async () => {
  const request = client();
  const space = await createSpace(request);
  const paired = await client()('/v1/pair', { method: 'POST', json: { code: space.code } });
  const sent = await request(`/v1/spaces/${space.roomId}/messages`, {
    method: 'POST', token: space.token, json: { clientId: randomUUID(), text: 'before connection' }
  });
  const first = await authenticateSocket(space);
  const second = await authenticateSocket(paired.body);
  assert.deepEqual(first.frame.messages, [sent.body]);
  assert.deepEqual(second.frame.messages, [sent.body]);
  await runtime.unsafeEvictDurableObject('sync-test', 'SyncRoom', { name: space.roomId, webSockets: 'hibernate' });

  const firstMessage = socketEvent(first.socket);
  const secondMessage = socketEvent(second.socket);
  const next = await request(`/v1/spaces/${space.roomId}/messages`, {
    method: 'POST', token: space.token, json: { clientId: randomUUID(), text: 'live message' }
  });
  assert.deepEqual(JSON.parse((await firstMessage).data), { type: 'message', message: next.body });
  assert.deepEqual(JSON.parse((await secondMessage).data), { type: 'message', message: next.body });

  const firstCleared = socketEvent(first.socket);
  const secondCleared = socketEvent(second.socket);
  const cleared = await request(`/v1/spaces/${space.roomId}/messages`, { method: 'DELETE', token: space.token });
  assert.equal(cleared.status, 200);
  assert.deepEqual(JSON.parse((await firstCleared).data), { type: 'cleared' });
  assert.deepEqual(JSON.parse((await secondCleared).data), { type: 'cleared' });
  const reconnected = await authenticateSocket(space);
  assert.deepEqual(reconnected.frame.messages, []);
});

test('unauthenticated sockets receive no room content and invalid authentication closes them', async () => {
  const request = client();
  const space = await createSpace(request);
  const socket = await openSocket(space.roomId);
  const received = [];
  socket.addEventListener('message', event => received.push(event.data));
  await request(`/v1/spaces/${space.roomId}/messages`, {
    method: 'POST', token: space.token, json: { clientId: randomUUID(), text: 'private' }
  });
  const pong = socketEvent(socket);
  socket.send('ping');
  assert.equal((await pong).data, 'pong');
  assert.deepEqual(received, ['pong']);
  const closed = socketEvent(socket, 'close');
  socket.send(JSON.stringify({ type: 'auth', token: '0'.repeat(64) }));
  assert.equal((await closed).code, 4001);
  assert.deepEqual(received, ['pong']);
});

test('device additions, renames and removals notify authenticated sockets and peers can remove the creator', async () => {
  const request = client();
  const space = await createSpace(request);
  const paired = await client()('/v1/pair', { method: 'POST', json: { code: space.code } });
  assert.equal(paired.status, 200);
  const owner = await authenticateSocket(space);
  const peer = await authenticateSocket(paired.body);
  const unauthenticated = await openSocket(space.roomId);
  const privateFrames = [];
  unauthenticated.addEventListener('message', event => privateFrames.push(event.data));
  await runtime.unsafeEvictDurableObject('sync-test', 'SyncRoom', { name: space.roomId, webSockets: 'hibernate' });

  const ownerAdded = socketEvent(owner.socket);
  const peerAdded = socketEvent(peer.socket);
  const third = await client()('/v1/pair', { method: 'POST', json: { code: space.code } });
  assert.equal(third.status, 200);
  assert.deepEqual(JSON.parse((await ownerAdded).data), { type: 'devices' });
  assert.deepEqual(JSON.parse((await peerAdded).data), { type: 'devices' });

  const ownerRenamed = socketEvent(owner.socket);
  const peerRenamed = socketEvent(peer.socket);
  const renamed = await request(`/v1/spaces/${space.roomId}/devices/${space.deviceId}`, {
    method: 'PATCH', token: third.body.token, json: { name: 'MacBook' }
  });
  assert.equal(renamed.status, 200);
  assert.deepEqual(JSON.parse((await ownerRenamed).data), { type: 'devices' });
  assert.deepEqual(JSON.parse((await peerRenamed).data), { type: 'devices' });
  const listed = await request(`/v1/spaces/${space.roomId}/devices`, { token: paired.body.token });
  assert.equal(listed.body.devices.find(device => device.deviceId === space.deviceId).name, 'MacBook');

  const closed = socketEvent(owner.socket, 'close');
  const peerRemoved = socketEvent(peer.socket);
  const removed = await request(`/v1/spaces/${space.roomId}/devices/${space.deviceId}`, {
    method: 'DELETE', token: paired.body.token
  });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body, { ok: true });
  assert.equal((await closed).code, 4001);
  assert.deepEqual(JSON.parse((await peerRemoved).data), { type: 'devices' });
  const remaining = await request(`/v1/spaces/${space.roomId}/devices`, { token: third.body.token });
  assert.deepEqual(remaining.body.devices.map(device => device.deviceId).sort(), [paired.body.deviceId, third.body.deviceId].sort());

  for (const [method, suffix, json] of [
    ['GET', '', undefined],
    ['GET', '/devices', undefined],
    ['PATCH', `/devices/${paired.body.deviceId}`, { name: 'revoked' }],
    ['DELETE', `/devices/${paired.body.deviceId}`, undefined],
    ['POST', '/messages', { clientId: randomUUID(), text: 'revoked' }]
  ]) {
    const denied = await request(`/v1/spaces/${space.roomId}${suffix}`, { method, token: space.token, json });
    assert.equal(denied.status, 401);
  }
  const rejected = await openSocket(space.roomId);
  const rejectedClose = socketEvent(rejected, 'close');
  rejected.send(JSON.stringify({ type: 'auth', token: space.token }));
  assert.equal((await rejectedClose).code, 4001);
  const peerMessage = socketEvent(peer.socket);
  const sent = await request(`/v1/spaces/${space.roomId}/messages`, {
    method: 'POST', token: paired.body.token, json: { clientId: randomUUID(), text: 'peer still works' }
  });
  assert.equal(sent.status, 201);
  assert.equal(JSON.parse((await peerMessage).data).message.text, 'peer still works');
  const pong = socketEvent(unauthenticated);
  unauthenticated.send('ping');
  assert.equal((await pong).data, 'pong');
  assert.deepEqual(privateFrames, ['pong']);
  unauthenticated.close();
});

test('targeted self-removal revokes only that device and preserves shared history', async () => {
  const request = client();
  const space = await createSpace(request);
  const paired = await client()('/v1/pair', { method: 'POST', json: { code: space.code } });
  assert.equal(paired.status, 200);
  const sent = await request(`/v1/spaces/${space.roomId}/messages`, {
    method: 'POST', token: space.token, json: { clientId: randomUUID(), text: 'keep after device leaves' }
  });
  assert.equal(sent.status, 201);
  const owner = await authenticateSocket(space);
  const peer = await authenticateSocket(paired.body);
  const closed = socketEvent(owner.socket, 'close');
  const devicesChanged = socketEvent(peer.socket);
  const removed = await request(`/v1/spaces/${space.roomId}/devices/${space.deviceId}`, {
    method: 'DELETE', token: space.token
  });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body, { ok: true });
  assert.equal((await closed).code, 4001);
  assert.deepEqual(JSON.parse((await devicesChanged).data), { type: 'devices' });
  const denied = await request(`/v1/spaces/${space.roomId}/devices`, { token: space.token });
  assert.equal(denied.status, 401);
  const remaining = await request(`/v1/spaces/${space.roomId}/devices`, { token: paired.body.token });
  assert.deepEqual(remaining.body.devices.map(device => device.deviceId), [paired.body.deviceId]);
  const state = await request(`/v1/spaces/${space.roomId}`, { token: paired.body.token });
  assert.equal(state.status, 200);
  assert.deepEqual(state.body.messages, [sent.body]);
});

test('disconnecting one device revokes its HTTP and WebSocket access while peers keep working', async () => {
  const request = client();
  const space = await createSpace(request);
  const paired = await client()('/v1/pair', { method: 'POST', json: { code: space.code } });
  const owner = await authenticateSocket(space);
  const peer = await authenticateSocket(paired.body);
  const closed = socketEvent(owner.socket, 'close');
  const devicesChanged = socketEvent(peer.socket);
  const removed = await request(`/v1/spaces/${space.roomId}/device`, { method: 'DELETE', token: space.token });
  assert.equal(removed.status, 200);
  assert.equal((await closed).code, 4001);
  assert.deepEqual(JSON.parse((await devicesChanged).data), { type: 'devices' });
  const denied = await request(`/v1/spaces/${space.roomId}`, { token: space.token });
  assert.equal(denied.status, 401);
  const deniedSend = await request(`/v1/spaces/${space.roomId}/messages`, {
    method: 'POST', token: space.token, json: { clientId: randomUUID(), text: 'revoked' }
  });
  assert.equal(deniedSend.status, 401);
  const peerMessage = socketEvent(peer.socket);
  const sent = await request(`/v1/spaces/${space.roomId}/messages`, {
    method: 'POST', token: paired.body.token, json: { clientId: randomUUID(), text: 'peer remains paired' }
  });
  assert.equal(sent.status, 201);
  assert.equal(JSON.parse((await peerMessage).data).message.text, 'peer remains paired');
  const rejected = await openSocket(space.roomId);
  const rejectedClose = socketEvent(rejected, 'close');
  rejected.send(JSON.stringify({ type: 'auth', token: space.token }));
  assert.equal((await rejectedClose).code, 4001);
});

test('late authentication is rejected and idle unauthenticated sockets are eventually closed', async () => {
  const space = await createSpace();
  const socket = await openSocket(space.roomId);
  const late = await openSocket(space.roomId);
  const received = [];
  socket.addEventListener('message', event => received.push(event.data));
  const idleClosed = socketEvent(socket, 'close', 35000);
  late.addEventListener('message', event => received.push(event.data));
  const lateClosed = socketEvent(late, 'close', 35000);
  const timer = setTimeout(() => late.send(JSON.stringify({ type: 'auth', token: space.token })), 10500);
  const [closed, expired] = await Promise.all([idleClosed, lateClosed]).finally(() => clearTimeout(timer));
  assert.equal(closed.code, 1008);
  assert.equal(expired.code, 1008);
  assert.deepEqual(received, []);
});

test('history retains the latest 500 messages and clearing releases the stored message rows', async () => {
  const request = client();
  const space = await createSpace(request);
  for (let index = 0; index < 501; index += 1) {
    const sent = await request(`/v1/spaces/${space.roomId}/messages`, {
      method: 'POST', token: space.token, json: { clientId: randomUUID(), text: `message ${index}` }
    });
    assert.equal(sent.status, 201);
  }
  const state = await request(`/v1/spaces/${space.roomId}`, { token: space.token });
  assert.equal(state.body.messages.length, 500);
  assert.equal(state.body.messages[0].text, 'message 1');
  assert.equal(state.body.messages[499].text, 'message 500');
  await request(`/v1/spaces/${space.roomId}/messages`, { method: 'DELETE', token: space.token });
  const storage = await runtime.unsafeGetDurableObjectStorage('sync-test', 'SyncRoom', { name: space.roomId });
  assert.deepEqual(await storage.exec('SELECT count(*) AS count FROM messages'), [{ count: 0 }]);
});

test('the alarm removes five-day history without a page visit and broadcasts the surviving history', async () => {
  const request = client();
  const space = await createSpace(request);
  const sent = [];
  for (const text of ['expired history', 'still within five days']) {
    const result = await request(`/v1/spaces/${space.roomId}/messages`, {
      method: 'POST', token: space.token, json: { clientId: randomUUID(), text }
    });
    assert.equal(result.status, 201);
    sent.push(result.body);
  }
  const connected = await authenticateSocket(space);
  const storage = await runtime.unsafeGetDurableObjectStorage('sync-test', 'SyncRoom', { name: space.roomId });
  const now = Date.now();
  const survivorTime = now - fiveDays + 60000;
  await storage.exec('UPDATE messages SET created_at = ? WHERE id = ?', now - fiveDays - 60000, sent[0].id);
  await storage.exec('UPDATE messages SET created_at = ? WHERE id = ?', survivorTime, sent[1].id);
  const namespace = await runtime.getDurableObjectNamespace('SYNC_ROOMS');
  const room = namespace.getByName(space.roomId);
  const history = socketEvent(connected.socket);
  await room.testRunAlarm();
  const frame = JSON.parse((await history).data);
  assert.equal(frame.type, 'history');
  assert.deepEqual(frame.messages.map(message => message.text), ['still within five days']);
  assert.deepEqual(await storage.exec('SELECT id FROM messages'), [{ id: sent[1].id }]);
  assert.equal(await room.testReadAlarm(), survivorTime + fiveDays);
  const state = await request(`/v1/spaces/${space.roomId}`, { token: space.token });
  assert.deepEqual(state.body.messages, frame.messages);
  const reconnected = await authenticateSocket(space);
  assert.deepEqual(reconnected.frame.messages, frame.messages);
});

test('HTTP reads and a first WebSocket authentication never restore expired messages', async () => {
  const request = client();
  for (const throughSocket of [false, true]) {
    const space = await createSpace(request);
    const sent = await request(`/v1/spaces/${space.roomId}/messages`, {
      method: 'POST', token: space.token, json: { clientId: randomUUID(), text: 'expired before reopening' }
    });
    assert.equal(sent.status, 201);
    const storage = await runtime.unsafeGetDurableObjectStorage('sync-test', 'SyncRoom', { name: space.roomId });
    await storage.exec('UPDATE messages SET created_at = ?', Date.now() - fiveDays - 1000);
    if (throughSocket) {
      const reconnected = await authenticateSocket(space);
      assert.deepEqual(reconnected.frame.messages, []);
    } else {
      const state = await request(`/v1/spaces/${space.roomId}`, { token: space.token });
      assert.equal(state.status, 200);
      assert.deepEqual(state.body.messages, []);
    }
    assert.deepEqual(await storage.exec('SELECT count(*) AS count FROM messages'), [{ count: 0 }]);
  }
});

test('message expiry and pending authentication share the earliest alarm without losing retention', async () => {
  const request = client();
  const space = await createSpace(request);
  const sent = await request(`/v1/spaces/${space.roomId}/messages`, {
    method: 'POST', token: space.token, json: { clientId: randomUUID(), text: 'retention deadline' }
  });
  assert.equal(sent.status, 201);
  const namespace = await runtime.getDurableObjectNamespace('SYNC_ROOMS');
  const room = namespace.getByName(space.roomId);
  assert.equal(await room.testReadAlarm(), sent.body.createdAt + fiveDays);
  const socket = await openSocket(space.roomId);
  const authAlarm = await room.testReadAlarm();
  assert.ok(authAlarm > Date.now() && authAlarm <= Date.now() + 10000);
  const ready = socketEvent(socket);
  socket.send(JSON.stringify({ type: 'auth', token: space.token }));
  assert.equal(JSON.parse((await ready).data).type, 'ready');
  assert.equal(await room.testReadAlarm(), sent.body.createdAt + fiveDays);
  const cleared = socketEvent(socket);
  await request(`/v1/spaces/${space.roomId}/messages`, { method: 'DELETE', token: space.token });
  assert.equal(JSON.parse((await cleared).data).type, 'cleared');
  assert.equal(await room.testReadAlarm(), null);
});

test('pruning real large text rows reduces the measured SQLite storage usage', async () => {
  const request = client();
  const space = await createSpace(request);
  for (let index = 0; index < 120; index += 1) {
    const result = await request(`/v1/spaces/${space.roomId}/messages`, {
      method: 'POST', token: space.token, json: { clientId: randomUUID(), text: `${index} ${'x'.repeat(9995)}` }
    });
    assert.equal(result.status, 201);
  }
  const namespace = await runtime.getDurableObjectNamespace('SYNC_ROOMS');
  const room = namespace.getByName(space.roomId);
  const before = await room.storageUsage();
  const after = await room.pruneOldest();
  assert.ok(before.bytes > 1_000_000);
  assert.ok(after.bytes < before.bytes, `${after.bytes} should be below ${before.bytes}`);
  const state = await request(`/v1/spaces/${space.roomId}`, { token: space.token });
  assert.equal(state.body.messages.length, 20);
  assert.ok(state.body.messages[0].text.startsWith('100 '));
});

test('combined room storage starts background cleanup, removes about 3 GB in global age order, and can start a second round', async t => {
  const instance = await createRuntime({ virtualMessageBytes: 100_000_000 });
  t.after(() => instance.dispose());
  const request = client(instance);
  const spaces = [await createSpace(request), await createSpace(request)];
  const storage = await Promise.all(spaces.map(space => instance.unsafeGetDurableObjectStorage('sync-test', 'SyncRoom', { name: space.roomId })));
  const registryStorage = await instance.unsafeGetDurableObjectStorage('sync-test', 'PairingRegistry', { name: 'registry' });
  const registryNamespace = await instance.getDurableObjectNamespace('PAIRING_REGISTRY');
  const registry = registryNamespace.getByName('registry');
  const snapshot = async () => (await Promise.all(storage.map(handle => handle.exec('SELECT text, created_at FROM messages'))))
    .flat().sort((a, b) => a.created_at - b.created_at);
  const append = async (number, round) => {
    for (let index = 0; index < number; index += 1) {
      const space = spaces[index % 2];
      const sent = await request(`/v1/spaces/${space.roomId}/messages`, {
        method: 'POST', token: space.token, json: { clientId: randomUUID(), text: `round ${round} message ${index}` }
      });
      assert.equal(sent.status, 201);
    }
  };
  await append(47, 1);
  const start = Date.now() - 120000;
  for (let index = 0; index < 47; index += 1) {
    await storage[index % 2].exec('UPDATE messages SET created_at = ? WHERE text = ?', start + index * 1000, `round 1 message ${index}`);
  }
  for (const space of spaces) await registry.refreshRoom(space.roomId);

  for (const round of [1, 2]) {
    if (round === 2) await append(30, 2);
    const original = await snapshot();
    assert.equal(original.length, 47);
    const before = await registry.storageBytes();
    assert.ok(before >= 4_700_000_000);
    const blocked = await request(`/v1/spaces/${spaces[1].roomId}/messages`, {
      method: 'POST', token: spaces[1].token, json: { clientId: randomUUID(), text: 'wait for automatic cleanup' }
    });
    assert.equal(blocked.status, 503);
    assert.equal(blocked.body.error, 'storage_cleaning');
    assert.equal(blocked.headers.get('Retry-After'), '1');
    assert.deepEqual(await registryStorage.exec('SELECT phase, cursor, target_bytes FROM cleanup'), [{ phase: 'refresh', cursor: '', target_bytes: null }]);
    assert.ok(await registry.testReadAlarm() !== null);
    assert.equal((await snapshot()).length, 47);

    let turns = 0;
    let fixedTarget;
    let wroteDuringCleanup = false;
    const expected = [...original];
    while ((await registryStorage.exec('SELECT 1 FROM cleanup')).length) {
      assert.ok(turns++ < 10, 'background cleanup should make bounded progress');
      await registry.testRunAlarm();
      const state = await registryStorage.exec('SELECT phase, target_bytes FROM cleanup');
      if (state.length) {
        assert.equal(state[0].phase, 'prune');
        if (fixedTarget === undefined) fixedTarget = state[0].target_bytes;
        assert.equal(state[0].target_bytes, fixedTarget);
        assert.ok(await registry.testReadAlarm() !== null);
      }
      const remaining = await snapshot();
      if (!wroteDuringCleanup && round === 1 && remaining.length < original.length) {
        assert.deepEqual(remaining.map(message => message.text), original.slice(10).map(message => message.text));
        const arriving = await request(`/v1/spaces/${spaces[0].roomId}/messages`, {
          method: 'POST', token: spaces[0].token, json: { clientId: randomUUID(), text: 'arrived during cleanup' }
        });
        assert.equal(arriving.status, 201);
        expected.push({ text: arriving.body.text, created_at: arriving.body.createdAt });
        assert.deepEqual(await registryStorage.exec('SELECT target_bytes FROM cleanup'), [{ target_bytes: fixedTarget }]);
        wroteDuringCleanup = true;
      }
    }
    const after = await registry.storageBytes();
    assert.ok(before - after >= 3_000_000_000 - 128 * 1024);
    assert.ok(before - after < 3_100_000_000);
    if (fixedTarget !== undefined) assert.ok(after <= fixedTarget);
    assert.equal((await snapshot()).length, 17);
    assert.deepEqual((await snapshot()).map(message => message.text), expected.slice(-17).map(message => message.text));
    if (round === 1) assert.ok(turns > 1, 'cleanup should continue through background alarms');
  }
});

test('stale high usage is refreshed before background cleanup can delete current history', async t => {
  const instance = await createRuntime();
  t.after(() => instance.dispose());
  const request = client(instance);
  const spaces = [await createSpace(request), await createSpace(request)];
  for (const [index, space] of spaces.entries()) {
    const sent = await request(`/v1/spaces/${space.roomId}/messages`, {
      method: 'POST', token: space.token, json: { clientId: randomUUID(), text: `preserve ${index}` }
    });
    assert.equal(sent.status, 201);
  }
  const registryStorage = await instance.unsafeGetDurableObjectStorage('sync-test', 'PairingRegistry', { name: 'registry' });
  await registryStorage.exec('UPDATE room_usage SET bytes = ? WHERE room_id = ?', 4_800_000_000, spaces[0].roomId);
  const blocked = await request(`/v1/spaces/${spaces[1].roomId}/messages`, {
    method: 'POST', token: spaces[1].token, json: { clientId: randomUUID(), text: 'retry after refresh' }
  });
  assert.equal(blocked.status, 503);
  const namespace = await instance.getDurableObjectNamespace('PAIRING_REGISTRY');
  await namespace.getByName('registry').testRunAlarm();
  assert.deepEqual(await registryStorage.exec('SELECT 1 FROM cleanup'), []);
  for (const [index, space] of spaces.entries()) {
    const state = await request(`/v1/spaces/${space.roomId}`, { token: space.token });
    assert.deepEqual(state.body.messages.map(message => message.text), [`preserve ${index}`]);
  }
  const retried = await request(`/v1/spaces/${spaces[1].roomId}/messages`, {
    method: 'POST', token: spaces[1].token, json: { clientId: randomUUID(), text: 'retry after refresh' }
  });
  assert.equal(retried.status, 201);
});

test('idempotent retries under storage pressure return the existing message without starting cleanup', async t => {
  const instance = await createRuntime({ virtualMessageBytes: 1_000_000_000 });
  t.after(() => instance.dispose());
  const request = client(instance);
  const spaces = [await createSpace(request), await createSpace(request)];
  const clientId = randomUUID();
  let first;
  for (let index = 0; index < 5; index += 1) {
    const space = spaces[index % 2];
    const sent = await request(`/v1/spaces/${space.roomId}/messages`, {
      method: 'POST', token: space.token, json: { clientId: index ? randomUUID() : clientId, text: `existing ${index}` }
    });
    assert.equal(sent.status, 201);
    if (!index) first = sent.body;
  }
  const registryStorage = await instance.unsafeGetDurableObjectStorage('sync-test', 'PairingRegistry', { name: 'registry' });
  const retried = await request(`/v1/spaces/${spaces[0].roomId}/messages`, {
    method: 'POST', token: spaces[0].token, json: { clientId, text: 'changed retry body' }
  });
  assert.equal(retried.status, 200);
  assert.deepEqual(retried.body, first);
  assert.deepEqual(await registryStorage.exec('SELECT 1 FROM cleanup'), []);
  const states = await Promise.all(spaces.map(space => request(`/v1/spaces/${space.roomId}`, { token: space.token })));
  assert.equal(states.reduce((total, state) => total + state.body.messages.length, 0), 5);
});

test('full storage with no removable history returns 507 while paired credentials keep working', async t => {
  const instance = await createRuntime({ virtualBaseBytes: 2_350_000_000 });
  t.after(() => instance.dispose());
  const request = client(instance);
  const spaces = [await createSpace(request), await createSpace(request)];
  const sent = await request(`/v1/spaces/${spaces[0].roomId}/messages`, {
    method: 'POST', token: spaces[0].token, json: { clientId: randomUUID(), text: 'cannot fit' }
  });
  assert.equal(sent.status, 507);
  assert.equal(sent.body.error, 'storage_full');
  for (const space of spaces) {
    const state = await request(`/v1/spaces/${space.roomId}`, { token: space.token });
    assert.equal(state.status, 200);
    assert.deepEqual(state.body.messages, []);
  }
  const registryStorage = await instance.unsafeGetDurableObjectStorage('sync-test', 'PairingRegistry', { name: 'registry' });
  assert.deepEqual(await registryStorage.exec('SELECT 1 FROM cleanup'), []);
});

test('daily maintenance repairs unattended expiry and resumes interrupted cleanup without resetting its target', async t => {
  const instance = await createRuntime();
  t.after(() => instance.dispose());
  const request = client(instance);
  const spaces = [await createSpace(request), await createSpace(request)];
  const storage = await Promise.all(spaces.map(space => instance.unsafeGetDurableObjectStorage('sync-test', 'SyncRoom', { name: space.roomId })));
  for (const [index, space] of spaces.entries()) {
    const sent = await request(`/v1/spaces/${space.roomId}/messages`, {
      method: 'POST', token: space.token, json: { clientId: randomUUID(), text: `unattended ${index}` }
    });
    assert.equal(sent.status, 201);
  }
  await storage[0].exec('UPDATE messages SET created_at = ?', Date.now() - fiveDays - 60000);
  const registryStorage = await instance.unsafeGetDurableObjectStorage('sync-test', 'PairingRegistry', { name: 'registry' });
  const namespace = await instance.getDurableObjectNamespace('PAIRING_REGISTRY');
  const registry = namespace.getByName('registry');
  await registry.maintainRooms();
  assert.ok(await registry.testReadAlarm() !== null);
  await registry.testRunAlarm();
  assert.deepEqual(await storage[0].exec('SELECT count(*) AS count FROM messages'), [{ count: 0 }]);
  assert.deepEqual(await storage[1].exec('SELECT count(*) AS count FROM messages'), [{ count: 1 }]);
  assert.deepEqual(await registryStorage.exec('SELECT oldest_at FROM room_usage WHERE room_id = ?', spaces[0].roomId), [{ oldest_at: null }]);
  assert.deepEqual(await registryStorage.exec('SELECT 1 FROM cleanup'), []);

  await registryStorage.exec('INSERT INTO cleanup (id, phase, cursor, target_bytes) VALUES (1, ?, ?, ?)', 'prune', 'saved-cursor', 0);
  await registry.testDropAlarm();
  assert.equal(await registry.testReadAlarm(), null);
  await registry.maintainRooms();
  assert.deepEqual(await registryStorage.exec('SELECT phase, cursor, target_bytes FROM cleanup'), [{ phase: 'prune', cursor: 'saved-cursor', target_bytes: 0 }]);
  const resumed = await registry.testReadAlarm();
  assert.ok(resumed > Date.now() && resumed <= Date.now() + 1000);
  await registry.maintainRooms();
  assert.equal(await registry.testReadAlarm(), resumed);
  await registry.testRunAlarm();
  assert.deepEqual(await storage[1].exec('SELECT count(*) AS count FROM messages'), [{ count: 0 }]);
  assert.deepEqual(await registryStorage.exec('SELECT 1 FROM cleanup'), []);
});

