import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, afterEach, before, test } from 'node:test';
import { Miniflare } from 'miniflare';
import { encryptedClient, cryptoClient } from './e2ee-client.mjs';

const origin = 'https://lizuju.github.io';
const sevenDays = 7 * 24 * 60 * 60 * 1000;
const cryptoSource = (await readFile(new URL('../../../static/portfolio/js/apps/sync-crypto.js', import.meta.url), 'utf8')).replaceAll("'@serenity-kit/opaque'", JSON.stringify(import.meta.resolve('@serenity-kit/opaque')));
const pairingSource = (await readFile(new URL('../../../static/portfolio/js/apps/sync-pairing.js', import.meta.url), 'utf8')).replace("'./sync-crypto.js'", JSON.stringify(`data:text/javascript;base64,${Buffer.from(cryptoSource).toString('base64')}`));
const { EncryptedPairing } = await import(`data:text/javascript;base64,${Buffer.from(pairingSource).toString('base64')}`);
let runtime;
let nextIp = 1;
const sockets = new Set();
const socketSessions = new WeakMap();

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
            'daily-usage.js': { type: 'esm', contents: await readFile(new URL('../src/daily-usage.js', import.meta.url), 'utf8') },
            'harness.js': {
              type: 'esm',
              contents: `import { E2eeSyncRoom as ProductionSyncRoom, E2eePairingRegistry as ProductionRegistry } from './index.js';
                export { default } from './index.js';
                export { E2eeFileShard as FileShard } from './index.js';
                export class PairingRegistry extends ProductionRegistry {
                  testExpireDiagnosticsCache() { this.diagnosticsCacheUntil = Date.now() - 1; }
                  testDiagnosticsCacheUntil() { return this.diagnosticsCacheUntil; }
                  testFailDiagnostics() { this.failDiagnostics = true; }
                  collectDiagnostics() {
                    if (this.failDiagnostics) { this.failDiagnostics = false; throw new Error('test_diagnostics_failed'); }
                    return super.collectDiagnostics();
                  }
                  publicStatus() {
                    this.statusCalls = (this.statusCalls || 0) + 1;
                    if (this.statusWaiter && this.statusCalls >= this.statusWaiter.count) this.statusWaiter.resolve();
                    return super.publicStatus();
                  }
                  testWaitStatusCalls(count) {
                    if ((this.statusCalls || 0) >= count) return;
                    return new Promise(resolve => { this.statusWaiter = { count, resolve }; });
                  }
                  testExpireDiscoveryWindow() { this.discoveryWindow.expiresAt = Date.now() - 1; }
                  testDiscoverySources() { return this.discoveryWindow?.attempts.size || 0; }
                  testDiscoveryAttempts() { return [...(this.discoveryWindow?.attempts.values() || [])].reduce((sum, count) => sum + count, 0); }
                  testWaitDiscoveryAttempts(count) {
                    if (this.testDiscoveryAttempts() >= count) return;
                    return new Promise(resolve => { this.discoveryWaiter = { count, resolve }; });
                  }
                  publicOffers(ipHash) {
                    const pending = super.publicOffers(ipHash);
                    if (this.discoveryWaiter && this.testDiscoveryAttempts() >= this.discoveryWaiter.count) this.discoveryWaiter.resolve();
                    return pending;
                  }
                  testFillDiscoveryWindow() { this.discoveryWindow = { expiresAt: Date.now() + 60000, attempts: new Map(Array.from({ length: 1024 }, (_, index) => ['test:' + index, 1])) }; }
                  testRunAlarm() { return super.alarm(); }
                  testReadAlarm() { return this.ctx.storage.getAlarm(); }
                  testDropAlarm() { return this.ctx.storage.deleteAlarm(); }
                  testFailPairingRead() { this.failPairingRead = true; }
                  currentInvite(roomId) {
                    if (this.failPairingRead) {
                      this.failPairingRead = false;
                      throw new Error('test_pairing_read_failed');
                    }
                    return super.currentInvite(roomId);
                  }
                }
                export class SyncRoom extends ProductionSyncRoom {
                  constructor(ctx, env) {
                    super(ctx, env);
                    const setAlarm = ctx.storage.setAlarm.bind(ctx.storage);
                    ctx.storage.setAlarm = (...args) => { this.alarmWrites = (this.alarmWrites || 0) + 1; return setAlarm(...args); };
                  }
                  testAlarmWrites() { return this.alarmWrites || 0; }
                  testScheduleAlarm() { return super.scheduleAlarm(); }
                  async alarm(...args) {
                    this.runningAlarmAt = await this.ctx.storage.getAlarm();
                    await super.alarm(...args);
                    this.completedAlarmAt = await this.ctx.storage.getAlarm();
                    this.alarmRuns = (this.alarmRuns || 0) + 1;
                    this.alarmWaiter?.();
                  }
                  testWaitAlarm() { if (this.alarmRuns) return; return new Promise(resolve => { this.alarmWaiter = resolve; }); }
                  testAlarmCycle() { return { running: this.runningAlarmAt, scheduled: this.completedAlarmAt }; }
                  testHoldOnlineProbe() { this.onlineProbeGate = new Promise(resolve => { this.releaseOnlineProbe = resolve; }); }
                  testReleaseOnlineProbe() { this.releaseOnlineProbe(); this.onlineProbeGate = null; }
                  testFailOnlineProbe() { this.failOnlineProbe = true; }
                  testOnlineProbes() { return this.onlineProbes || 0; }
                  testWaitOnlineProbes(count) {
                    if ((this.onlineProbes || 0) >= count) return;
                    return new Promise(resolve => { (this.onlineProbeWaiters ||= []).push({ count, resolve }); });
                  }
                  async deviceOnline(deviceId) {
                    this.onlineProbes = (this.onlineProbes || 0) + 1;
                    for (const waiter of this.onlineProbeWaiters || []) if (this.onlineProbes >= waiter.count) waiter.resolve();
                    if (this.onlineProbeGate) await this.onlineProbeGate;
                    if (this.failOnlineProbe) { this.failOnlineProbe = false; throw new Error('test_online_probe_failed'); }
                    return super.deviceOnline(deviceId);
                  }
                  testHoldDatabaseProbe() { this.databaseProbeGate = new Promise(resolve => { this.releaseDatabaseProbe = resolve; }); }
                  testReleaseDatabaseProbe() { this.releaseDatabaseProbe(); this.databaseProbeGate = null; }
                  testFailDatabaseProbe() { this.failDatabaseProbe = true; }
                  async databaseProbe() {
                    this.probeCount = (this.probeCount || 0) + 1;
                    if (this.databaseProbeGate) await this.databaseProbeGate;
                    if (this.failDatabaseProbe) { this.failDatabaseProbe = false; throw new Error('test_database_probe_failed'); }
                    return super.databaseProbe();
                  }
                  testProbeCount() { return this.probeCount || 0; }
                  testHoldUploadBegin() {
                    this.uploadBeginStarted = new Promise(resolve => { this.startUploadBegin = resolve; });
                    this.uploadBeginRelease = new Promise(resolve => { this.releaseUploadBegin = resolve; });
                  }
                  testWaitUploadBegin() { return this.uploadBeginStarted; }
                  testReleaseUploadBegin() { this.releaseUploadBegin(); }
                  async beginUpload(deviceId, file, keyId) {
                    if (this.uploadBeginRelease) {
                      this.startUploadBegin();
                      await this.uploadBeginRelease;
                      this.uploadBeginRelease = null;
                    }
                    return super.beginUpload(deviceId, file, keyId);
                  }
                  testHoldMaintenance() {
                    this.maintenanceStarted = new Promise(resolve => { this.startMaintenance = resolve; });
                    this.maintenanceRelease = new Promise(resolve => { this.releaseMaintenance = resolve; });
                  }
                  testWaitMaintenance() { return this.maintenanceStarted; }
                  testReleaseMaintenance() { this.releaseMaintenance(); }
                  async maintain(roomId) {
                    if (this.maintenanceRelease) {
                      this.startMaintenance();
                      await this.maintenanceRelease;
                      this.maintenanceRelease = null;
                    }
                    return super.maintain(roomId);
                  }
                  testRunAlarm() { return super.alarm(); }
                  testReadAlarm() { return this.ctx.storage.getAlarm(); }
                  testSchema() { return this.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name != '__miniflare_do_name' ORDER BY name").toArray(); }
                  testAgeConnection(deviceId, timestamp) {
                    this.sql.exec('UPDATE devices SET last_active_at = ? WHERE device_id = ?', timestamp, deviceId);
                    for (const socket of this.ctx.getWebSockets()) {
                      const attachment = socket.deserializeAttachment();
                      if (attachment?.deviceId === deviceId) socket.serializeAttachment({ ...attachment, connectedAt: timestamp });
                    }
                  }
                  testAgeActivity(timestamp) {
                    this.lastActivity = timestamp;
                    this.sql.exec('UPDATE metadata SET value = ? WHERE key = ?', String(timestamp), 'lastActiveAt');
                  }
                  async testPublishPairingFailure(roomId) {
                    try { await super.publishPairing(roomId); return null; }
                    catch (error) { return error.message; }
                  }
                  storageUsage() {
                    const usage = super.storageUsage();
                    if (!this.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages'").toArray().length) return usage;
                    usage.bytes += ${virtualBaseBytes} + this.sql.exec('SELECT count(*) AS count FROM messages').one().count * ${virtualMessageBytes};
                    return usage;
                  }
                }`
            }
          }
        },
        env: {
          ALLOWED_ORIGINS: { type: 'text', value: origin },
          E2EE_PAIRING_REGISTRY: { type: 'durable-object', worker: 'sync-test', exportName: 'PairingRegistry' },
          E2EE_SYNC_ROOMS: { type: 'durable-object', worker: 'sync-test', exportName: 'SyncRoom' },
          E2EE_FILE_SHARDS: { type: 'durable-object', worker: 'sync-test', exportName: 'FileShard' }
        },
        exports: {
          PairingRegistry: { type: 'durable-object', storage: 'sqlite' },
          SyncRoom: { type: 'durable-object', storage: 'sqlite' },
          FileShard: { type: 'durable-object', storage: 'sqlite' }
        }
      }
    }]
  });
  await instance.ready;
  return instance;
}

after(async () => {
  for (const socket of sockets) if (socket.readyState === 1) socket.close();
  await runtime?.dispose();
});

afterEach(async () => {
  const storage = await runtime.unsafeGetDurableObjectStorage('sync-test', 'PairingRegistry', { name: 'registry' });
  await storage.exec('DELETE FROM offers');
  await storage.exec('DELETE FROM pair_candidates');
  await storage.exec('DELETE FROM pair_requests');
  client().state.offers.clear();
});

function client(instance = runtime) {
  const ip = `198.51.100.${nextIp++}`;
  return encryptedClient(instance, { origin, ip });
}

async function createSpace(request = client()) {
  const result = await request('/v1/spaces', { method: 'POST' });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body;
}

async function openSocket(roomId, instance = runtime, headers = {}) {
  const response = await instance.dispatchFetch(`https://sync.test/v1/spaces/${roomId}/socket`, {
    headers: { Origin: origin, Upgrade: 'websocket', 'CF-Connecting-IP': `192.0.2.${nextIp++}`, ...headers }
  });
  assert.equal(response.status, 101, response.status === 101 ? undefined : await response.text());
  if (headers['Sec-WebSocket-Protocol']?.startsWith('sync,')) assert.equal(response.headers.get('Sec-WebSocket-Protocol'), 'sync');
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
    async function onEvent(event) {
      if (type === 'message' && event.data !== 'pong' && ['key-rotation', 'rekey-required', 'pair-request', 'pair-finish'].includes(JSON.parse(event.data).type)) return;
      clearTimeout(timer);
      socket.removeEventListener(type, onEvent);
      const entry = socketSessions.get(socket);
      if (type === 'message' && entry && event.data !== 'pong') {
        try {
          await entry.request.update(entry.session);
          resolve({ data: JSON.stringify(await entry.request.decode(JSON.parse(event.data), entry.session)) });
        } catch (error) { reject(error); }
        return;
      }
      resolve(event);
    }
    socket.addEventListener(type, onEvent);
  });
}

async function authenticateSocket(space, instance = runtime) {
  const socket = await openSocket(space.roomId, instance);
  const request = client(instance);
  const session = request.state.sessions.get(space.token);
  await request.update(session);
  socketSessions.set(socket, { request, session });
  const ready = socketEvent(socket);
  socket.send(JSON.stringify({ type: 'auth', token: space.token }));
  const frame = JSON.parse((await ready).data);
  assert.equal(frame.type, 'ready');
  assert.equal(frame.deviceId, space.deviceId);
  return { socket, frame };
}

test('health identifies the sync service and exposes release metadata instead of only reporting reachability', async () => {
  const health = await client()('/health');
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, { ok: true, service: 'portfolio-sync', apiVersion: 1, encryptionVersion: 1, revision: null, versionId: null });
  assert.equal(health.headers.get('Cache-Control'), 'no-store');
});

async function rotateRemaining(request, space) {
  const session = request.state.sessions.get(space.token);
  await request.update(session);
  const listed = await request.raw(`/v1/spaces/${space.roomId}/devices`, { token: space.token });
  const recipients = listed.body.devices.map(device => ({ deviceId: device.deviceId, publicKey: session.trustedDevices[device.deviceId] }));
  const rotation = await cryptoClient.createKeyRotation(session, recipients);
  const result = await request.raw(`/v1/spaces/${space.roomId}/key-rotation`, { method: 'POST', token: space.token,
    headers: { 'X-Sync-Key-Id': rotation.previousKeyId },
    json: { rotationId: rotation.rotationId, newKeyId: rotation.newKeyId, removedDeviceId: null, grants: rotation.grants } });
  assert.equal(result.status, 200);
  await request.update(session);
}

test('authenticated reconnects use separate device budgets even after the shared IP anonymous budget is exhausted', async () => {
  const space = await createSpace();
  const peer = (await client()('/v1/pair', { method: 'POST', json: { code: space.code } })).body;
  const headers = { 'CF-Connecting-IP': '203.0.113.250', Upgrade: 'websocket', Origin: origin };
  const path = `https://sync.test/v1/spaces/${space.roomId}/socket`;
  for (let attempt = 0; attempt < 30; attempt++) {
    const socket = await openSocket(space.roomId, runtime, headers);
    socket.close();
  }
  const anonymous = await runtime.dispatchFetch(path, { headers });
  assert.equal(anonymous.status, 429);
  assert.ok(Number(anonymous.headers.get('Retry-After')) > 0);
  const invalid = await runtime.dispatchFetch(path, { headers: { ...headers, 'Sec-WebSocket-Protocol': `sync, auth.${'0'.repeat(64)}` } });
  assert.equal(invalid.status, 429);
  for (const device of [space, peer]) {
    const socket = await openSocket(space.roomId, runtime, { ...headers, 'Sec-WebSocket-Protocol': `sync, auth.${device.token}` });
    const ready = socketEvent(socket);
    socket.send(JSON.stringify({ type: 'auth', token: device.token }));
    assert.equal(JSON.parse((await ready).data).deviceId, device.deviceId);
    socket.close();
  }
  const storage = await runtime.unsafeGetDurableObjectStorage('sync-test', 'PairingRegistry', { name: 'registry' });
  await storage.exec('UPDATE attempts SET count = 60 WHERE key = ?', `socket-device:${space.roomId}:${space.deviceId}`);
  assert.equal((await runtime.dispatchFetch(path, { headers: { ...headers, 'Sec-WebSocket-Protocol': `sync, auth.${space.token}` } })).status, 429);
  const independent = await openSocket(space.roomId, runtime, { ...headers, 'Sec-WebSocket-Protocol': `sync, auth.${peer.token}` });
  const closed = socketEvent(independent, 'close');
  independent.send(JSON.stringify({ type: 'auth', token: space.token }));
  assert.equal((await closed).code, 4001, 'The first frame cannot change the device selected for rate limiting');
});

test('a local four-digit PAKE invitation creates separate device credentials without exposing the code to the relay', async () => {
  const request = client();
  const created = await createSpace(request);
  assert.match(created.code, /^\d{4}$/);
  const wire = await request.raw(`/v1/spaces/${created.roomId}`, { token: created.token });
  assert.equal(wire.status, 200);
  assert.equal(wire.body.pairing.code, undefined);
  assert.match(wire.body.pairing.secret, /^e2ee1\./);
  const joined = await client()('/v1/pair', { method: 'POST', json: { code: created.code } });
  assert.equal(joined.status, 200);
  assert.equal(joined.body.roomId, created.roomId);
  assert.notEqual(joined.body.token, created.token);
  assert.equal((await request(`/v1/spaces/${created.roomId}`, { token: created.token })).body.pairing, null);
  const invitation = await request(`/v1/spaces/${created.roomId}/pair-code`, { method: 'POST', token: created.token });
  const third = await client()('/v1/pair', { method: 'POST', json: { code: invitation.body.code } });
  assert.equal(third.status, 200);
  assert.equal(new Set([created.token, joined.body.token, third.body.token]).size, 3);
  const storage = await runtime.unsafeGetDurableObjectStorage('sync-test', 'SyncRoom', { name: created.roomId });
  const stored = await storage.exec('SELECT token_hash FROM devices');
  assert.equal(stored.length, 3);
  assert.ok(stored.every(row => ![created.token, joined.body.token, third.body.token].includes(row.token_hash)));
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

test('paired devices store encrypted profiles and the API rejects plaintext profiles', async () => {
  const request = client();
  const space = await createSpace(request);
  const paired = await client()('/v1/pair', { method: 'POST', json: { code: space.code } });
  const path = `/v1/spaces/${space.roomId}/devices`;
  for (const token of [space.token, paired.body.token]) {
    assert.equal((await request(`${path}/${space.deviceId}`, { method: 'PATCH', token, json: { name: '我的 Mac' } })).status, 200);
    assert.equal((await request(path, { token })).body.devices.find(device => device.deviceId === space.deviceId).name, '我的 Mac');
    const wire = await request.raw(path, { token });
    assert.ok(wire.body.devices.every(device => /^e2ee1\./.test(device.name)));
    assert.ok(!JSON.stringify(wire.body).includes('我的 Mac'));
  }
  const session = request.state.sessions.get(space.token);
  for (const name of [null, 123, [], {}, 'plaintext profile', 'e2ee1.invalid']) {
    const result = await request.raw(`${path}/${space.deviceId}`, { method: 'PATCH', token: space.token,
      headers: { 'X-Sync-Key-Id': session.keyring.currentKeyId }, json: { name } });
    assert.equal(result.status, 400);
  }
  const missing = await request(`${path}/${randomUUID()}`, { method: 'PATCH', token: space.token, json: { name: 'missing' } });
  assert.equal(missing.status, 404);
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
    assert.deepEqual(state.body.readReceipts, []);
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
  assert.ok((await storage.exec('SELECT last_active_at FROM devices')).every(device => device.last_active_at >= Date.now() - 10000));
});

test('upgrading an abandoned legacy room grants seven days before either its devices or room can expire', async () => {
  const space = await createSpace();
  const storage = await runtime.unsafeGetDurableObjectStorage('sync-test', 'SyncRoom', { name: space.roomId });
  await storage.exec('DROP INDEX devices_activity');
  await storage.exec('ALTER TABLE devices DROP COLUMN last_active_at');
  await storage.exec('UPDATE metadata SET value = ? WHERE key = ?', String(Date.now() - 8 * 24 * 60 * 60 * 1000), 'lastActiveAt');
  const registryStorage = await runtime.unsafeGetDurableObjectStorage('sync-test', 'PairingRegistry', { name: 'registry' });
  await registryStorage.exec('UPDATE offers SET expires_at = ? WHERE room_id = ?', Date.now() - 1, space.roomId);
  await runtime.unsafeEvictDurableObject('sync-test', 'SyncRoom', { name: space.roomId });
  const registry = (await runtime.getDurableObjectNamespace('E2EE_PAIRING_REGISTRY')).getByName('registry');
  await registry.refreshRoom(space.roomId);
  assert.equal(await registry.hasRoom(space.roomId), true);
  assert.equal((await client()(`/v1/spaces/${space.roomId}/devices`, { token: space.token })).status, 200);
});

test('seven days of device inactivity rejects HTTP and WebSocket credentials without waiting for maintenance', async () => {
  const request = client();
  const space = await createSpace(request);
  const storage = await runtime.unsafeGetDurableObjectStorage('sync-test', 'SyncRoom', { name: space.roomId });
  await storage.exec('UPDATE devices SET last_active_at = ?', Date.now() - sevenDays);
  const denied = await request(`/v1/spaces/${space.roomId}/devices`, { token: space.token });
  assert.equal(denied.status, 401);
  assert.deepEqual(await storage.exec('SELECT device_id FROM devices'), []);
  const socket = await openSocket(space.roomId);
  const closed = socketEvent(socket, 'close');
  socket.send(JSON.stringify({ type: 'auth', token: space.token }));
  assert.equal((await closed).code, 4001);
});

test('active devices renew independently and maintenance removes only inactive devices', async () => {
  const request = client();
  const space = await createSpace(request);
  const peer = (await client()('/v1/pair', { method: 'POST', json: { code: space.code } })).body;
  const storage = await runtime.unsafeGetDurableObjectStorage('sync-test', 'SyncRoom', { name: space.roomId });
  assert.ok((await storage.exec('SELECT last_active_at FROM devices WHERE device_id = ?', peer.deviceId))[0].last_active_at >= Date.now() - 10000);
  const session = request.state.sessions.get(space.token);
  await request.update(session);
  const expiredKeyring = structuredClone(request.state.sessions.get(peer.token).keyring);
  await storage.exec('UPDATE devices SET last_active_at = ? WHERE device_id = ?', Date.now() - sevenDays + 60000, space.deviceId);
  await storage.exec('UPDATE devices SET last_active_at = ? WHERE device_id = ?', Date.now() - sevenDays - 1, peer.deviceId);
  assert.equal((await request(`/v1/spaces/${space.roomId}/devices`, { token: space.token })).status, 200);
  const room = (await runtime.getDurableObjectNamespace('E2EE_SYNC_ROOMS')).getByName(space.roomId);
  await room.maintain(space.roomId);
  const remaining = await storage.exec('SELECT device_id, last_active_at FROM devices');
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].device_id, space.deviceId);
  assert.ok(remaining[0].last_active_at >= Date.now() - 10000);
  assert.equal((await request(`/v1/spaces/${space.roomId}/devices`, { token: space.token })).status, 200);
  assert.equal((await request(`/v1/spaces/${space.roomId}/messages`, { token: peer.token })).status, 401);
  assert.equal((await request.raw(`/v1/spaces/${space.roomId}`, { token: space.token })).body.rekeyRequired, true);
  const blockedId = randomUUID();
  const blocked = await request.raw(`/v1/spaces/${space.roomId}/messages`, {
    method: 'POST', token: space.token, headers: { 'X-Sync-Key-Id': session.keyring.currentKeyId },
    json: { clientId: blockedId, text: await cryptoClient.encryptPayload(session.keyring, space.roomId, `message:${space.deviceId}:${blockedId}`, { text: 'must rotate first' }) }
  });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error, 'rekey_required');
  await rotateRemaining(request, space);
  assert.ok(session.revokedDevices.includes(peer.deviceId));
  const clientId = randomUUID();
  const text = await cryptoClient.encryptPayload(session.keyring, space.roomId, `message:${space.deviceId}:${clientId}`, { text: 'survivors only' });
  assert.equal((await request.raw(`/v1/spaces/${space.roomId}/messages`, {
    method: 'POST', token: space.token, headers: { 'X-Sync-Key-Id': session.keyring.currentKeyId }, json: { clientId, text }
  })).status, 201);
  await assert.rejects(cryptoClient.decryptPayload(expiredKeyring, space.roomId, `message:${space.deviceId}:${clientId}`, text), { code: 'key_unavailable' });
});

test('hibernating WebSocket heartbeats renew a device, while abandoned sockets expire', async () => {
  const space = await createSpace();
  const peer = (await client()('/v1/pair', { method: 'POST', json: { code: space.code } })).body;
  const active = (await authenticateSocket(space)).socket;
  const abandoned = (await authenticateSocket({ ...peer, roomId: space.roomId })).socket;
  const room = (await runtime.getDurableObjectNamespace('E2EE_SYNC_ROOMS')).getByName(space.roomId);
  await room.testAgeConnection(space.deviceId, Date.now() - sevenDays - 1);
  await room.testAgeConnection(peer.deviceId, Date.now() - sevenDays - 1);
  const pong = socketEvent(active);
  active.send('ping');
  assert.equal((await pong).data, 'pong');
  const closed = socketEvent(abandoned, 'close');
  await room.testRunAlarm();
  assert.equal((await closed).code, 4001);
  const storage = await runtime.unsafeGetDurableObjectStorage('sync-test', 'SyncRoom', { name: space.roomId });
  assert.deepEqual((await storage.exec('SELECT device_id FROM devices')).map(row => row.device_id), [space.deviceId]);
  assert.ok(await room.testReadAlarm() > Date.now());
  active.close();
});

test('unregistered room IDs reject forged HTTP credentials and sockets without allocating SQLite databases', async t => {
  const instance = await createRuntime();
  t.after(() => instance.dispose());
  const request = client(instance);
  await createSpace(request);
  const registry = await instance.unsafeGetDurableObjectStorage('sync-test', 'PairingRegistry', { name: 'registry' });
  const usage = await registry.exec('SELECT room_id, bytes, oldest_at FROM room_usage ORDER BY room_id');
  const databases = await instance.listDurableObjectIds('E2EE_SYNC_ROOMS');
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
  assert.deepEqual(await instance.listDurableObjectIds('E2EE_SYNC_ROOMS'), databases);
  assert.deepEqual(await registry.exec('SELECT room_id, bytes, oldest_at FROM room_usage ORDER BY room_id'), usage);
});

test('a room without an online inviter cannot admit a new device from a retained offer', async t => {
  const instance = await createRuntime(); t.after(() => instance.dispose());
  const request = client(instance), space = await createSpace(request);
  assert.equal((await request(`/v1/spaces/${space.roomId}/device`, { method: 'DELETE', token: space.token })).status, 200);
  const registry = (await instance.getDurableObjectNamespace('E2EE_PAIRING_REGISTRY')).getByName('registry');
  await registry.refreshRoom(space.roomId);
  const joined = await client(instance)('/v1/pair', { method: 'POST', json: { code: space.code } });
  assert.equal(joined.status, 404);
});

test('empty rooms reclaim expired offers and stale credentials cannot recreate a database', async t => {
  const instance = await createRuntime(); t.after(() => instance.dispose());
  const request = client(instance), space = await createSpace(request);
  await request(`/v1/spaces/${space.roomId}/device`, { method: 'DELETE', token: space.token });
  const registryStorage = await instance.unsafeGetDurableObjectStorage('sync-test', 'PairingRegistry', { name: 'registry' });
  await registryStorage.exec('UPDATE offers SET expires_at = ? WHERE room_id = ?', Date.now() - 1, space.roomId);
  const registry = (await instance.getDurableObjectNamespace('E2EE_PAIRING_REGISTRY')).getByName('registry');
  await registry.refreshRoom(space.roomId);
  assert.equal(await registry.hasRoom(space.roomId), false);
  const room = (await instance.getDurableObjectNamespace('E2EE_SYNC_ROOMS')).getByName(space.roomId);
  assert.deepEqual(await room.testSchema(), []);
  assert.equal((await request.raw(`/v1/spaces/${space.roomId}`, { token: space.token })).status, 404);
  assert.deepEqual(await room.testSchema(), []);
});

test('empty-room reclamation retains devices, history, uploads and remaining shard or chunk rows', async t => {
  const instance = await createRuntime();
  t.after(() => instance.dispose());
  const registryStorage = await instance.unsafeGetDurableObjectStorage('sync-test', 'PairingRegistry', { name: 'registry' });
  const namespace = await instance.getDurableObjectNamespace('E2EE_PAIRING_REGISTRY');
  const registry = namespace.getByName('registry');
  for (const retained of ['device', 'message', 'upload', 'shard', 'chunk', 'deleting shards']) {
    await t.test(retained, async () => {
      const request = client(instance);
      const space = await createSpace(request);
      const storage = await instance.unsafeGetDurableObjectStorage('sync-test', 'SyncRoom', { name: space.roomId });
      const fileId = randomUUID();
      if (retained === 'message') {
        const sent = await request(`/v1/spaces/${space.roomId}/messages`, {
          method: 'POST', token: space.token, json: { clientId: randomUUID(), text: 'preserve this history' }
        });
        assert.equal(sent.status, 201);
      }
      if (retained === 'upload') {
        const started = await request(`/v1/spaces/${space.roomId}/files/uploads`, {
          method: 'POST', token: space.token,
          json: { clientId: randomUUID(), name: 'pending.bin', type: 'application/octet-stream', size: 8 }
        });
        assert.equal(started.status, 201);
      }
      if (retained === 'shard') await storage.exec('INSERT INTO file_shards (file_id, shard_index, bytes) VALUES (?, 0, 8)', fileId);
      if (retained === 'chunk') await storage.exec('INSERT INTO file_upload_chunks (file_id, chunk_index, size) VALUES (?, 0, 8)', fileId);
      if (retained === 'deleting shards') {
        await storage.exec("INSERT INTO files (file_id, device_id, client_id, name, type, size, text, status, created_at, updated_at, reserved_bytes) VALUES (?, ?, ?, 'old.bin', 'application/octet-stream', 40, '', 'deleting', ?, ?, 0)", fileId, space.deviceId, randomUUID(), Date.now(), Date.now());
        for (let index = 0; index < 5; index += 1) await storage.exec('INSERT INTO file_shards (file_id, shard_index, bytes) VALUES (?, ?, 8)', fileId, index);
      }
      if (retained !== 'device') await storage.exec('DELETE FROM devices');
      await registryStorage.exec('UPDATE offers SET expires_at = ? WHERE room_id = ?', Date.now() - 1, space.roomId);
      await registry.refreshRoom(space.roomId);
      assert.equal(await registry.hasRoom(space.roomId), true);
      assert.ok((await storage.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'devices'")).length);
      if (retained === 'deleting shards') {
        assert.deepEqual(await storage.exec('SELECT count(*) AS count FROM file_shards'), [{ count: 1 }]);
        await registry.refreshRoom(space.roomId);
        assert.equal(await registry.hasRoom(space.roomId), false);
        assert.deepEqual(await storage.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name != '__miniflare_do_name'"), []);
      }
    });
  }
});

test('daily maintenance reclaims a seven-day abandoned empty room despite old paired devices', async t => {
  const instance = await createRuntime();
  t.after(() => instance.dispose());
  const space = await createSpace(client(instance));
  const roomStorage = await instance.unsafeGetDurableObjectStorage('sync-test', 'SyncRoom', { name: space.roomId });
  const registryStorage = await instance.unsafeGetDurableObjectStorage('sync-test', 'PairingRegistry', { name: 'registry' });
  await roomStorage.exec('UPDATE metadata SET value = ? WHERE key = ?', String(Date.now() - 8 * 24 * 60 * 60 * 1000), 'lastActiveAt');
  await roomStorage.exec('UPDATE devices SET last_active_at = ?', Date.now() - sevenDays - 1);
  await registryStorage.exec('UPDATE offers SET expires_at = ? WHERE room_id = ?', Date.now() - 1, space.roomId);
  const registry = (await instance.getDurableObjectNamespace('E2EE_PAIRING_REGISTRY')).getByName('registry');
  await registry.maintainRooms();
  await registry.testRunAlarm();
  assert.equal(await registry.hasRoom(space.roomId), false);
  assert.deepEqual(await roomStorage.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name != '__miniflare_do_name'"), []);
  assert.equal((await client(instance)(`/v1/spaces/${space.roomId}`, { token: space.token })).status, 404);
});

test('abandoned-room reclamation preserves recent activity, online devices, invitations and pending contents', async t => {
  const instance = await createRuntime();
  t.after(() => instance.dispose());
  const registry = (await instance.getDurableObjectNamespace('E2EE_PAIRING_REGISTRY')).getByName('registry');
  const registryStorage = await instance.unsafeGetDurableObjectStorage('sync-test', 'PairingRegistry', { name: 'registry' });
  for (const retained of ['recent', 'online', 'invitation', 'history', 'upload']) {
    const request = client(instance);
    const space = await createSpace(request);
    const storage = await instance.unsafeGetDurableObjectStorage('sync-test', 'SyncRoom', { name: space.roomId });
    const socket = retained === 'online' ? (await authenticateSocket(space, instance)).socket : null;
    if (retained === 'history') await request(`/v1/spaces/${space.roomId}/messages`, { method: 'POST', token: space.token, json: { clientId: randomUUID(), text: 'keep' } });
    if (retained === 'upload') await request(`/v1/spaces/${space.roomId}/files/uploads`, { method: 'POST', token: space.token, json: { clientId: randomUUID(), name: 'pending.bin', type: 'application/octet-stream', size: 8 } });
    if (retained !== 'recent') await storage.exec('UPDATE metadata SET value = ? WHERE key = ?', String(Date.now() - 31 * 24 * 60 * 60 * 1000), 'lastActiveAt');
    if (retained !== 'invitation') await registryStorage.exec('UPDATE offers SET expires_at = ? WHERE room_id = ?', Date.now() - 1, space.roomId);
    await registry.refreshRoom(space.roomId);
    assert.equal(await registry.hasRoom(space.roomId), true, retained);
    socket?.close();
  }
});

test('successful authentication refreshes stale activity and existing rooms receive a full idle grace period on migration', async t => {
  const instance = await createRuntime();
  t.after(() => instance.dispose());
  const request = client(instance);
  const space = await createSpace(request);
  const storage = await instance.unsafeGetDurableObjectStorage('sync-test', 'SyncRoom', { name: space.roomId });
  const old = Date.now() - 31 * 24 * 60 * 60 * 1000;
  await storage.exec('UPDATE metadata SET value = ? WHERE key = ?', String(old), 'lastActiveAt');
  await instance.unsafeEvictDurableObject('sync-test', 'SyncRoom', { name: space.roomId });
  assert.equal((await request(`/v1/spaces/${space.roomId}/devices`, { token: space.token })).status, 200);
  assert.ok(Number((await storage.exec('SELECT value FROM metadata WHERE key = ?', 'lastActiveAt'))[0].value) > old);
  await storage.exec('DELETE FROM metadata WHERE key = ?', 'lastActiveAt');
  await instance.unsafeEvictDurableObject('sync-test', 'SyncRoom', { name: space.roomId });
  const room = (await instance.getDurableObjectNamespace('E2EE_SYNC_ROOMS')).getByName(space.roomId);
  assert.equal(await room.reclaimIfEmpty(), false);
  assert.ok(Number((await storage.exec('SELECT value FROM metadata WHERE key = ?', 'lastActiveAt'))[0].value) >= Date.now() - 10000);
});

test('closing a long-lived authenticated connection refreshes activity before an empty room can be reclaimed', async t => {
  const instance = await createRuntime();
  t.after(() => instance.dispose());
  const space = await createSpace(client(instance));
  const { socket } = await authenticateSocket(space, instance);
  const room = (await instance.getDurableObjectNamespace('E2EE_SYNC_ROOMS')).getByName(space.roomId);
  await room.testAgeActivity(Date.now() - 31 * 24 * 60 * 60 * 1000);
  const closed = socketEvent(socket, 'close');
  socket.close();
  await closed;
  const storage = await instance.unsafeGetDurableObjectStorage('sync-test', 'SyncRoom', { name: space.roomId });
  assert.ok(Number((await storage.exec('SELECT value FROM metadata WHERE key = ?', 'lastActiveAt'))[0].value) >= Date.now() - 10000);
  assert.equal(await room.reclaimIfEmpty(), false);
});

test('the relay requires a live PAKE transcript and never accepts a bare pairing code', async () => {
  const request = client();
  const space = await createSpace(request);
  const result = await request.raw('/v1/pair', { method: 'POST', json: { code: space.code } });
  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'invalid_pairing');
});

test('the relay rejects plaintext codes and malformed PAKE requests at its API boundary', async () => {
  for (const code of ['1234', '123', 1234, null, {}, []]) {
    const result = await client().raw('/v1/pair', { method: 'POST', json: { code } });
    assert.equal(result.status, 400);
    assert.equal(result.body.error, 'invalid_pairing');
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
  const oversized = await request.raw('/v1/pair', { method: 'POST', json: { code: '1'.repeat(32768) } });
  assert.equal(oversized.status, 413);
  const wrongType = await request('/v1/pair', { method: 'POST', body: '{"code":"1234"}' });
  assert.equal(wrongType.status, 400);
});

test('expired encrypted invitations stop PAKE admission while existing devices retain access', async () => {
  const request = client(), space = await createSpace(request);
  const registry = await runtime.unsafeGetDurableObjectStorage('sync-test', 'PairingRegistry', { name: 'registry' });
  await registry.exec('UPDATE offers SET expires_at = ? WHERE room_id = ?', Date.now() - 1, space.roomId);
  const joined = await client()('/v1/pair', { method: 'POST', json: { code: space.code } });
  assert.equal(joined.status, 404);
  assert.equal((await request(`/v1/spaces/${space.roomId}`, { token: space.token })).body.pairing, null);
});

test('concurrent offer generation reuses one active encrypted offer without extending expiry', async () => {
  const owner = client(), space = await createSpace(owner);
  const results = await Promise.all(Array.from({ length: 8 }, () => owner(`/v1/spaces/${space.roomId}/pair-code`, { method: 'POST', token: space.token })));
  assert.ok(results.every(result => result.status === 200));
  const { code, ...wire } = results[0].body;
  assert.deepEqual(wire, space.pairing);
  assert.ok(results.every(result => result.body.code === code && result.body.expiresAt === space.expiresAt));
});

test('offer generation rechecks expiry and the thirty-space limit after an online probe', async t => {
  for (const fillExpiredSlot of [false, true]) await t.test(fillExpiredSlot ? 'another space takes the expired slot' : 'the same space renews its expired slot', async t => {
    const instance = await createRuntime(); t.after(() => instance.dispose());
    const request = client(instance), space = await createSpace(request);
    const peer = (await client(instance)('/v1/pair', { method: 'POST', json: { code: space.code } })).body;
    const old = (await request(`/v1/spaces/${space.roomId}/pair-code`, { method: 'POST', token: space.token })).body;
    await authenticateSocket(space, instance);
    await Promise.all(Array.from({ length: 29 }, () => createSpace(client(instance))));
    const room = (await instance.getDurableObjectNamespace('E2EE_SYNC_ROOMS')).getByName(space.roomId);
    const storage = await instance.unsafeGetDurableObjectStorage('sync-test', 'PairingRegistry', { name: 'registry' });
    const hostSession = request.state.sessions.get(space.token), peerSession = request.state.sessions.get(peer.token);
    const secret = await cryptoClient.decryptPayload(hostSession.keyring, space.roomId, `offer:${old.offerId}`, old.secret);
    const expiresAt = Date.now() + 1000;
    const encrypted = await cryptoClient.encryptPayload(hostSession.keyring, space.roomId, `offer:${old.offerId}`, { ...secret, expiresAt });
    await storage.exec('UPDATE offers SET secret = ?, expires_at = ? WHERE room_id = ?', encrypted, expiresAt, space.roomId);
    await room.testHoldOnlineProbe();
    const probes = await room.testOnlineProbes();
    const pairing = new EncryptedPairing({ getSession: () => peerSession, api: async (path, options, session) => {
      const result = await request.raw(path, { method: options.method, body: options.body, token: session.token,
        headers: { 'Content-Type': 'application/json', ...options.headers } });
      if (result.status >= 400) throw Object.assign(new Error(result.body.error), { status: result.status, code: result.body.error });
      return result.body;
    } });
    const pending = pairing.createOffer().then(value => ({ value }), error => ({ error }));
    await room.testWaitOnlineProbes(probes + 1);
    await new Promise(resolve => setTimeout(resolve, Math.max(1, expiresAt - Date.now() + 10)));
    if (fillExpiredSlot) await createSpace(client(instance));
    await room.testReleaseOnlineProbe();
    const result = await pending;
    if (fillExpiredSlot) {
      assert.equal(result.error?.code, 'pairing_busy');
      assert.equal(result.error?.status, 503);
      assert.equal(pairing.offer, undefined);
    } else {
      assert.ifError(result.error);
      assert.notEqual(result.value.offerId, old.offerId);
      assert.equal(pairing.offer.ownerDeviceId, peer.deviceId);
      assert.match(pairing.offer.code, /^\d{4}$/);
      assert.ok(pairing.offer.expiresAt > Date.now());
    }
    assert.deepEqual(await storage.exec('SELECT count(*) AS count FROM offers WHERE expires_at > ?', Date.now()), [{ count: 30 }]);
    pairing.reset();
  });
});

test('offer publications are ordered and are never sent to another room or anonymous sockets', async () => {
  const request = client(), space = await createSpace(request), unrelated = await createSpace();
  const owner = await authenticateSocket(space), other = await authenticateSocket(unrelated);
  const anonymous = await openSocket(space.roomId);
  const observed = [], privateFrames = [];
  other.socket.addEventListener('message', event => observed.push(event.data));
  anonymous.addEventListener('message', event => privateFrames.push(event.data));
  const next = socketEvent(owner.socket);
  const offered = await request(`/v1/spaces/${space.roomId}/pair-code`, { method: 'POST', token: space.token });
  const { code, ...wire } = offered.body;
  assert.deepEqual(JSON.parse((await next).data), { type: 'pairing', pairing: wire });
  assert.deepEqual(observed, []); assert.deepEqual(privateFrames, []);
  assert.ok(!JSON.stringify(wire).includes(`"code":"${code}"`));
  const registry = (await runtime.getDurableObjectNamespace('E2EE_PAIRING_REGISTRY')).getByName('registry');
  await registry.testFailPairingRead();
  const room = (await runtime.getDurableObjectNamespace('E2EE_SYNC_ROOMS')).getByName(space.roomId);
  assert.match(await room.testPublishPairingFailure(space.roomId), /test_pairing_read_failed/);
  assert.equal((await authenticateSocket(space)).frame.type, 'ready');
});

test('pairing discovery excludes offline invitation owners without deleting their invitation and restores it on reconnect', async () => {
  const request = client(), active = await createSpace(request), offline = await createSpace();
  const host = await authenticateSocket(active);
  await openSocket(offline.roomId);
  const storage = await runtime.unsafeGetDurableObjectStorage('sync-test', 'PairingRegistry', { name: 'registry' });
  const retained = await storage.exec('SELECT * FROM offers ORDER BY offer_id');
  await runtime.unsafeEvictDurableObject('sync-test', 'SyncRoom', { name: active.roomId, webSockets: 'hibernate' });
  const exposed = await request.raw('/v1/pair/offers');
  assert.equal(exposed.status, 200);
  assert.deepEqual(exposed.body.offers, [{ offerId: active.pairing.offerId, expiresAt: active.pairing.expiresAt }]);
  assert.deepEqual(await storage.exec('SELECT * FROM offers ORDER BY offer_id'), retained);

  const requestId = randomUUID(), requestToken = 'b'.repeat(64);
  const start = await cryptoClient.startPairingClient(active.code, exposed.body.offers[0].offerId);
  const delivered = new Promise(resolve => host.socket.addEventListener('message', event => resolve(JSON.parse(event.data)), { once: true }));
  const started = await request.raw('/v1/pair', { method: 'POST', json: { requestId, requestToken, requests: [{ offerId: active.pairing.offerId, startLoginRequest: start.startLoginRequest }] } });
  assert.equal(started.status, 202);
  const frame = await delivered;
  assert.equal(frame.type, 'pair-request');
  const secret = request.state.offers.get(active.pairing.offerId).secret;
  const response = await cryptoClient.startPairingHost(secret, active.pairing.offerId, requestId, frame.startLoginRequest);
  assert.equal((await request.raw(`/v1/spaces/${active.roomId}/pair-challenge`, { method: 'POST', token: active.token, headers: { 'X-Sync-Key-Id': request.state.sessions.get(active.token).keyring.currentKeyId }, json: { offerId: active.pairing.offerId, requestId, loginResponse: response.loginResponse } })).status, 200);
  const polled = await request.raw(`/v1/pair/${requestId}`, { token: requestToken });
  assert.equal(polled.body.responses.length, exposed.body.offers.length, 'Every exposed candidate can answer; an unrelated offline invitation cannot force a timeout');
  await cryptoClient.finishPairingClient(start.clientState, active.pairing.offerId, requestId, polled.body.responses[0].loginResponse);
  assert.deepEqual((await request.raw(`/v1/spaces/${offline.roomId}/pair-requests`, { token: offline.token })).body.requests, []);
  await request.raw(`/v1/pair/${requestId}`, { method: 'DELETE', token: requestToken });

  const restored = await authenticateSocket(offline);
  const both = await request.raw('/v1/pair/offers');
  assert.deepEqual(both.body.offers.map(offer => offer.offerId).sort(), [active.pairing.offerId, offline.pairing.offerId].sort());
  const closed = socketEvent(restored.socket, 'close');
  restored.socket.close();
  await closed;
  const afterClose = await request.raw('/v1/pair/offers');
  assert.deepEqual(afterClose.body.offers, exposed.body.offers);
  assert.deepEqual(await storage.exec('SELECT * FROM offers ORDER BY offer_id'), retained);
});

test('anonymous discovery coalesces concurrent probes and limits one source without per-request database writes', async () => {
  const request = client(), space = await createSpace(request);
  await authenticateSocket(space);
  const room = (await runtime.getDurableObjectNamespace('E2EE_SYNC_ROOMS')).getByName(space.roomId);
  const registry = (await runtime.getDurableObjectNamespace('E2EE_PAIRING_REGISTRY')).getByName('registry');
  const storage = await runtime.unsafeGetDurableObjectStorage('sync-test', 'PairingRegistry', { name: 'registry' });
  const attempts = await storage.exec('SELECT * FROM attempts ORDER BY key');
  const discoveryAttempts = await registry.testDiscoveryAttempts();
  const probes = await room.testOnlineProbes();
  await room.testHoldOnlineProbe();
  const requests = Array.from({ length: 6 }, () => request.raw('/v1/pair/offers'));
  await room.testWaitOnlineProbes(probes + 1);
  await registry.testWaitDiscoveryAttempts(discoveryAttempts + 6);
  assert.equal(await room.testOnlineProbes(), probes + 1);
  await room.testReleaseOnlineProbe();
  for (const result of await Promise.all(requests)) {
    assert.equal(result.status, 200);
    assert.equal(result.body.offers[0].offerId, space.pairing.offerId);
  }
  assert.equal(await room.testOnlineProbes(), probes + 1);
  for (let index = 0; index < 4; index++) assert.equal((await request.raw('/v1/pair/offers')).status, 200);
  assert.equal(await room.testOnlineProbes(), probes + 5, 'Completed online results are not cached across disconnects');
  const blocked = await request.raw('/v1/pair/offers');
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error, 'rate_limited');
  assert.ok(Number(blocked.headers.get('Retry-After')) >= 1 && Number(blocked.headers.get('Retry-After')) <= 60);
  assert.equal(await room.testOnlineProbes(), probes + 5);
  assert.equal((await client().raw('/v1/pair/offers')).status, 200);
  assert.deepEqual(await storage.exec('SELECT * FROM attempts ORDER BY key'), attempts);
  await registry.testExpireDiscoveryWindow();
  assert.equal((await request.raw('/v1/pair/offers')).status, 200);
  assert.equal(await registry.testDiscoverySources(), 1);
  await registry.testFillDiscoveryWindow();
  assert.equal((await client().raw('/v1/pair/offers')).status, 429);
  assert.equal(await registry.testDiscoverySources(), 1024);
  await registry.testExpireDiscoveryWindow();
});

test('discovery revalidates an invitation changed during online probes and does not reuse an obsolete snapshot', async () => {
  const request = client(), space = await createSpace(request);
  await authenticateSocket(space);
  const room = (await runtime.getDurableObjectNamespace('E2EE_SYNC_ROOMS')).getByName(space.roomId);
  await room.testHoldOnlineProbe();
  const first = request.raw('/v1/pair/offers');
  await room.testWaitOnlineProbes(1);
  assert.equal((await request(`/v1/spaces/${space.roomId}/pair-code`, { method: 'DELETE', token: space.token })).status, 200);
  const replacement = await request(`/v1/spaces/${space.roomId}/pair-code`, { method: 'POST', token: space.token });
  const second = request.raw('/v1/pair/offers');
  await room.testWaitOnlineProbes(2);
  await room.testReleaseOnlineProbe();
  assert.deepEqual((await first).body.offers, []);
  assert.deepEqual((await second).body.offers, [{ offerId: replacement.body.offerId, expiresAt: replacement.body.expiresAt }]);
});

test('discovery excludes invitations expiring during probes and fails closed on an uncertain online result', async () => {
  const request = client(), space = await createSpace(request);
  await authenticateSocket(space);
  const room = (await runtime.getDurableObjectNamespace('E2EE_SYNC_ROOMS')).getByName(space.roomId);
  await room.testFailOnlineProbe();
  const failed = await request.raw('/v1/pair/offers');
  assert.equal(failed.status, 500);
  assert.equal((await request.raw('/v1/pair/offers')).body.offers.length, 1, 'A failed probe must not poison subsequent discovery');
  await room.testHoldOnlineProbe();
  const pending = request.raw('/v1/pair/offers');
  await room.testWaitOnlineProbes(3);
  const storage = await runtime.unsafeGetDurableObjectStorage('sync-test', 'PairingRegistry', { name: 'registry' });
  await storage.exec('UPDATE offers SET expires_at = ? WHERE room_id = ?', Date.now() - 1, space.roomId);
  await room.testReleaseOnlineProbe();
  assert.deepEqual((await pending).body.offers, []);
});

test('leaving thirty invitation spaces releases every slot immediately for a new space', async () => {
  const owners = await Promise.all(Array.from({ length: 30 }, () => createSpace()));
  const request = client();
  for (const owner of owners) assert.equal((await request(`/v1/spaces/${owner.roomId}/device`, { method: 'DELETE', token: owner.token })).status, 200);
  const storage = await runtime.unsafeGetDurableObjectStorage('sync-test', 'PairingRegistry', { name: 'registry' });
  assert.deepEqual(await storage.exec('SELECT count(*) AS count FROM offers'), [{ count: 0 }]);
  const next = await createSpace();
  assert.match(next.code, /^\d{4}$/);
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
  for (let index = 0; index < 20; index += 1) {
    const result = await request('/v1/pair', { method: 'POST', json: { code: 'invalid' } });
    assert.equal(result.status, 400);
  }
  const limited = await request('/v1/pair', { method: 'POST', json: { code: space.code } });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('Retry-After')) > 0);
  const independent = await client()('/v1/pair', { method: 'POST', json: { code: space.code } });
  assert.equal(independent.status, 200);
  const invitation = await client()(`/v1/spaces/${space.roomId}/pair-code`, { method: 'POST', token: space.token });

  const registry = await runtime.unsafeGetDurableObjectStorage('sync-test', 'PairingRegistry', { name: 'registry' });
  await registry.exec('UPDATE attempts SET expires_at = ? WHERE key LIKE ?', Date.now() - 1, 'pair:%');
  const resumed = await request('/v1/pair', { method: 'POST', json: { code: invitation.body.code } });
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
  const session = request.state.sessions.get(space.token);
  for (const text of ['', ' \n\t ', null, 123, 'plaintext content', 'e2ee1.invalid']) {
    const result = await request.raw(`/v1/spaces/${space.roomId}/messages`, {
      method: 'POST', token: space.token, headers: { 'X-Sync-Key-Id': session.keyring.currentKeyId }, json: { clientId: randomUUID(), text }
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
  const firstFrame = JSON.parse((await firstMessage).data);
  assert.deepEqual(firstFrame.message, next.body);
  assert.equal(firstFrame.history.latestId, next.body.id);
  const secondFrame = JSON.parse((await secondMessage).data);
  assert.deepEqual(secondFrame, firstFrame);

  const firstCleared = socketEvent(first.socket);
  const secondCleared = socketEvent(second.socket);
  const cleared = await request(`/v1/spaces/${space.roomId}/messages`, { method: 'DELETE', token: space.token });
  assert.equal(cleared.status, 200);
  const clearedFrame = JSON.parse((await firstCleared).data);
  assert.equal(clearedFrame.type, 'cleared');
  assert.equal(clearedFrame.history.latestId, null);
  assert.notEqual(clearedFrame.history.generation, first.frame.history.generation);
  assert.deepEqual(JSON.parse((await secondCleared).data), clearedFrame);
  const reconnected = await authenticateSocket(space);
  assert.deepEqual(reconnected.frame.messages, []);
});

test('explicit read receipts persist, broadcast to peers and advance without duplicate writes', async () => {
  const request = client();
  const space = await createSpace(request);
  const peer = (await client()('/v1/pair', { method: 'POST', json: { code: space.code } })).body;
  const messages = [];
  for (let index = 0; index < 3; index++) {
    const sent = await request(`/v1/spaces/${space.roomId}/messages`, {
      method: 'POST', token: space.token, json: { clientId: randomUUID(), text: `message ${index}` }
    });
    assert.equal(sent.status, 201);
    messages.push(sent.body);
  }
  const owner = await authenticateSocket(space);
  const reader = await authenticateSocket(peer);
  assert.deepEqual(owner.frame.readReceipts, []);
  assert.deepEqual(reader.frame.readReceipts, []);
  const storage = await runtime.unsafeGetDurableObjectStorage('sync-test', 'SyncRoom', { name: space.roomId });
  await storage.exec('CREATE TABLE receipt_writes (message_id INTEGER)');
  await storage.exec('CREATE TRIGGER count_receipt_writes AFTER UPDATE OF read_message_id ON devices BEGIN INSERT INTO receipt_writes VALUES (NEW.read_message_id); END');

  const firstOwner = socketEvent(owner.socket);
  const firstReader = socketEvent(reader.socket);
  reader.socket.send(JSON.stringify({ type: 'read', messageId: messages[1].id }));
  const receipt = { type: 'read', deviceId: peer.deviceId, messageId: messages[1].id };
  assert.deepEqual(JSON.parse((await firstOwner).data), receipt);
  assert.deepEqual(JSON.parse((await firstReader).data), receipt);
  const snapshot = await request(`/v1/spaces/${space.roomId}/messages`, { token: space.token });
  assert.deepEqual(snapshot.body.readReceipts, [{ deviceId: peer.deviceId, messageId: messages[1].id }]);

  await runtime.unsafeEvictDurableObject('sync-test', 'SyncRoom', { name: space.roomId, webSockets: 'hibernate' });
  const reconnected = await authenticateSocket(space);
  assert.deepEqual(reconnected.frame.readReceipts, snapshot.body.readReceipts);
  const nextOwner = socketEvent(owner.socket);
  const nextReader = socketEvent(reader.socket);
  reader.socket.send(JSON.stringify({ type: 'read', messageId: messages[1].id }));
  reader.socket.send(JSON.stringify({ type: 'read', messageId: messages[0].id }));
  reader.socket.send(JSON.stringify({ type: 'read', messageId: Number.MAX_SAFE_INTEGER }));
  const latest = { type: 'read', deviceId: peer.deviceId, messageId: messages[2].id };
  assert.deepEqual(JSON.parse((await nextOwner).data), latest);
  assert.deepEqual(JSON.parse((await nextReader).data), latest);
  assert.deepEqual(await storage.exec('SELECT message_id FROM receipt_writes'), messages.slice(1).map(message => ({ message_id: message.id })));

  const removed = await request(`/v1/spaces/${space.roomId}/devices/${peer.deviceId}`, { method: 'DELETE', token: space.token });
  assert.equal(removed.status, 200);
  const afterRemoval = await request(`/v1/spaces/${space.roomId}/messages`, { token: space.token });
  assert.deepEqual(afterRemoval.body.readReceipts, []);
});

test('read receipts reject unauthenticated and malformed frames at the WebSocket boundary', async () => {
  const request = client();
  const space = await createSpace(request);
  await request(`/v1/spaces/${space.roomId}/messages`, {
    method: 'POST', token: space.token, json: { clientId: randomUUID(), text: 'private' }
  });
  const anonymous = await openSocket(space.roomId);
  const anonymousClosed = socketEvent(anonymous, 'close');
  anonymous.send(JSON.stringify({ type: 'read', messageId: 1 }));
  assert.equal((await anonymousClosed).code, 1008);
  for (const messageId of [0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1, null]) {
    const { socket } = await authenticateSocket(space);
    const closed = socketEvent(socket, 'close');
    socket.send(JSON.stringify({ type: 'read', messageId }));
    assert.equal((await closed).code, 1008);
  }
  const state = await request(`/v1/spaces/${space.roomId}/messages`, { token: space.token });
  assert.deepEqual(state.body.readReceipts, []);
});

test('clearing history does not let old read receipts mark new messages as read', async () => {
  const request = client();
  const space = await createSpace(request);
  const sent = await request(`/v1/spaces/${space.roomId}/messages`, {
    method: 'POST', token: space.token, json: { clientId: randomUUID(), text: 'before clear' }
  });
  const reader = await authenticateSocket(space);
  const firstRead = socketEvent(reader.socket);
  reader.socket.send(JSON.stringify({ type: 'read', messageId: sent.body.id }));
  await firstRead;
  const clearedFrame = socketEvent(reader.socket);
  await request(`/v1/spaces/${space.roomId}/messages`, { method: 'DELETE', token: space.token });
  assert.equal(JSON.parse((await clearedFrame).data).type, 'cleared');
  const nextFrame = socketEvent(reader.socket);
  const next = await request(`/v1/spaces/${space.roomId}/messages`, {
    method: 'POST', token: space.token, json: { clientId: randomUUID(), text: 'after clear' }
  });
  await nextFrame;
  assert.ok(next.body.id > sent.body.id);
  const state = await request(`/v1/spaces/${space.roomId}/messages`, { token: space.token });
  assert.deepEqual(state.body.readReceipts, [{ deviceId: space.deviceId, messageId: sent.body.id }]);
  assert.ok(state.body.readReceipts[0].messageId < next.body.id);
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

  const invitation = await request(`/v1/spaces/${space.roomId}/pair-code`, { method: 'POST', token: space.token });
  const ownerAdded = socketEvent(owner.socket);
  const peerAdded = socketEvent(peer.socket);
  const third = await client()('/v1/pair', { method: 'POST', json: { code: invitation.body.code } });
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
  await rotateRemaining(request, paired.body);

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
  await rotateRemaining(request, paired.body);
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
  assert.equal(state.body.messages.length, 50);
  assert.equal(state.body.messages[0].text, 'message 451');
  assert.equal(state.body.messages[49].text, 'message 500');
  assert.equal(state.body.history.hasMore, true);
  const all = [...state.body.messages];
  while (all[0].id > state.body.history.oldestId) {
    const older = await request(`/v1/spaces/${space.roomId}/messages?before=${all[0].id}&generation=${state.body.history.generation}`, { token: space.token });
    assert.equal(older.body.historyMode, 'prepend');
    assert.ok(older.body.messages.length <= 50);
    all.unshift(...older.body.messages);
  }
  assert.equal(all.length, 500);
  assert.equal(all[0].text, 'message 1');
  await request(`/v1/spaces/${space.roomId}/messages`, { method: 'DELETE', token: space.token });
  const storage = await runtime.unsafeGetDurableObjectStorage('sync-test', 'SyncRoom', { name: space.roomId });
  assert.deepEqual(await storage.exec('SELECT count(*) AS count FROM messages'), [{ count: 0 }]);
});

test('the alarm removes seven-day history without a page visit and broadcasts the surviving history', async () => {
  const request = client();
  const space = await createSpace(request);
  const sent = [];
  for (const text of ['expired history', 'still within seven days']) {
    const result = await request(`/v1/spaces/${space.roomId}/messages`, {
      method: 'POST', token: space.token, json: { clientId: randomUUID(), text }
    });
    assert.equal(result.status, 201);
    sent.push(result.body);
  }
  const connected = await authenticateSocket(space);
  const storage = await runtime.unsafeGetDurableObjectStorage('sync-test', 'SyncRoom', { name: space.roomId });
  const now = Date.now();
  const survivorTime = now - sevenDays + 60000;
  await storage.exec('UPDATE messages SET created_at = ? WHERE id = ?', now - sevenDays - 60000, sent[0].id);
  await storage.exec('UPDATE messages SET created_at = ? WHERE id = ?', survivorTime, sent[1].id);
  const namespace = await runtime.getDurableObjectNamespace('E2EE_SYNC_ROOMS');
  const room = namespace.getByName(space.roomId);
  const history = socketEvent(connected.socket);
  await room.testRunAlarm();
  const frame = JSON.parse((await history).data);
  assert.equal(frame.type, 'history');
  assert.deepEqual(frame.messages.map(message => message.text), ['still within seven days']);
  assert.deepEqual(await storage.exec('SELECT id FROM messages'), [{ id: sent[1].id }]);
  assert.equal(await room.testReadAlarm(), survivorTime + sevenDays);
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
    await storage.exec('UPDATE messages SET created_at = ?', Date.now() - sevenDays - 1000);
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

test('unchanged read-only deadlines skip alarm writes while deadline changes and real expiry still rearm cleanup', async t => {
  const instance = await createRuntime(); t.after(() => instance.dispose());
  const request = client(instance), space = await createSpace(request);
  const room = (await instance.getDurableObjectNamespace('E2EE_SYNC_ROOMS')).getByName(space.roomId);
  const storage = await instance.unsafeGetDurableObjectStorage('sync-test', 'SyncRoom', { name: space.roomId });
  const initialAlarm = await room.testReadAlarm(), initialWrites = await room.testAlarmWrites();
  for (let index = 0; index < 25; index++) assert.equal((await request(`/v1/spaces/${space.roomId}`, { token: space.token })).status, 200);
  assert.equal(await room.testReadAlarm(), initialAlarm);
  assert.equal(await room.testAlarmWrites(), initialWrites, 'Repeated reads must not rewrite an unchanged alarm');

  const sent = await request(`/v1/spaces/${space.roomId}/messages`, { method: 'POST', token: space.token, json: { clientId: randomUUID(), text: 'alarm cleanup' } });
  const earlyDeadline = Date.now() + 60000;
  await storage.exec('UPDATE messages SET created_at = ? WHERE id = ?', earlyDeadline - sevenDays, sent.body.id);
  const beforeEarly = await room.testAlarmWrites();
  await room.testScheduleAlarm();
  assert.equal(await room.testReadAlarm(), earlyDeadline);
  assert.equal(await room.testAlarmWrites(), beforeEarly + 1);
  await room.testScheduleAlarm();
  assert.equal(await room.testAlarmWrites(), beforeEarly + 1);
  const laterDeadline = earlyDeadline + 60000;
  await storage.exec('UPDATE messages SET created_at = ? WHERE id = ?', laterDeadline - sevenDays, sent.body.id);
  await room.testScheduleAlarm();
  assert.equal(await room.testReadAlarm(), laterDeadline);
  assert.equal(await room.testAlarmWrites(), beforeEarly + 2);

  await storage.exec('UPDATE messages SET created_at = ? WHERE id = ?', Date.now() - sevenDays + 300, sent.body.id);
  await room.testScheduleAlarm();
  const beforeExpiry = await room.testAlarmWrites();
  await room.testWaitAlarm();
  const cycle = await room.testAlarmCycle();
  assert.equal(cycle.running, null, 'A running alarm has no scheduled timestamp until explicitly rearmed');
  assert.equal(cycle.scheduled, initialAlarm);
  assert.equal(await room.testAlarmWrites(), beforeExpiry + 1);
  assert.deepEqual(await storage.exec('SELECT count(*) AS count FROM messages'), [{ count: 0 }]);
});

test('message expiry and pending authentication share the earliest alarm without losing retention', async () => {
  const request = client();
  const space = await createSpace(request);
  const sent = await request(`/v1/spaces/${space.roomId}/messages`, {
    method: 'POST', token: space.token, json: { clientId: randomUUID(), text: 'retention deadline' }
  });
  assert.equal(sent.status, 201);
  const namespace = await runtime.getDurableObjectNamespace('E2EE_SYNC_ROOMS');
  const room = namespace.getByName(space.roomId);
  const storage = await runtime.unsafeGetDurableObjectStorage('sync-test', 'SyncRoom', { name: space.roomId });
  const deviceDeadline = (await storage.exec('SELECT min(last_active_at) AS oldest FROM devices'))[0].oldest + sevenDays;
  assert.equal(await room.testReadAlarm(), Math.min(deviceDeadline, sent.body.createdAt + sevenDays));
  const socket = await openSocket(space.roomId);
  const authAlarm = await room.testReadAlarm();
  assert.ok(authAlarm > Date.now() && authAlarm <= Date.now() + 10000);
  const ready = socketEvent(socket);
  socket.send(JSON.stringify({ type: 'auth', token: space.token }));
  assert.equal(JSON.parse((await ready).data).type, 'ready');
  const authenticatedDeviceDeadline = (await storage.exec('SELECT min(last_active_at) AS oldest FROM devices'))[0].oldest + sevenDays;
  assert.equal(await room.testReadAlarm(), Math.min(authenticatedDeviceDeadline, sent.body.createdAt + sevenDays));
  const cleared = socketEvent(socket);
  await request(`/v1/spaces/${space.roomId}/messages`, { method: 'DELETE', token: space.token });
  assert.equal(JSON.parse((await cleared).data).type, 'cleared');
  assert.equal(await room.testReadAlarm(), (await storage.exec('SELECT min(last_active_at) AS oldest FROM devices'))[0].oldest + sevenDays);
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
  const namespace = await runtime.getDurableObjectNamespace('E2EE_SYNC_ROOMS');
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
  const registryNamespace = await instance.getDurableObjectNamespace('E2EE_PAIRING_REGISTRY');
  const registry = registryNamespace.getByName('registry');
  const snapshot = async () => (await Promise.all(storage.map(async (handle, index) => {
    const session = request.state.sessions.get(spaces[index].token);
    const rows = await handle.exec('SELECT text, client_id AS clientId, device_id AS deviceId, created_at FROM messages');
    return Promise.all(rows.map(row => request.decode(row, session)));
  }))).flat().sort((a, b) => a.created_at - b.created_at);
  const append = async (number, round) => {
    for (let index = 0; index < number; index += 1) {
      const space = spaces[index % 2];
      const sent = await request(`/v1/spaces/${space.roomId}/messages`, {
        method: 'POST', token: space.token, json: { clientId: randomUUID(), text: `round ${round} message ${index}` }
      });
      assert.equal(sent.status, 201);
    }
  };
  await append(48, 1);
  const start = Date.now() - 120000;
  for (let index = 0; index < 48; index += 1) {
    await storage[index % 2].exec('UPDATE messages SET created_at = ? WHERE id = ?', start + index * 1000, Math.floor(index / 2) + 1);
  }
  for (const space of spaces) await registry.refreshRoom(space.roomId);

  for (const round of [1, 2]) {
    if (round === 2) await append(30, 2);
    const original = await snapshot();
    assert.equal(original.length, 48);
    const before = await registry.storageBytes();
    assert.ok(before >= 4_800_000_000);
    const blocked = await request(`/v1/spaces/${spaces[1].roomId}/messages`, {
      method: 'POST', token: spaces[1].token, json: { clientId: randomUUID(), text: 'wait for automatic cleanup' }
    });
    assert.equal(blocked.status, 503);
    assert.equal(blocked.body.error, 'storage_cleaning');
    assert.equal(blocked.headers.get('Retry-After'), '1');
    assert.deepEqual(await registryStorage.exec('SELECT phase, cursor, target_bytes FROM cleanup'), [{ phase: 'refresh', cursor: '', target_bytes: null }]);
    assert.ok(await registry.testReadAlarm() !== null);
    assert.equal((await snapshot()).length, 48);

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
    assert.equal((await snapshot()).length, 18);
    assert.deepEqual((await snapshot()).map(message => message.text), expected.slice(-18).map(message => message.text));
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
  const namespace = await instance.getDurableObjectNamespace('E2EE_PAIRING_REGISTRY');
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

test('concurrent space creation admits only one room when storage has headroom for one new room', async t => {
  const instance = await createRuntime();
  t.after(() => instance.dispose());
  const existing = await createSpace(client(instance));
  const registryStorage = await instance.unsafeGetDurableObjectStorage('sync-test', 'PairingRegistry', { name: 'registry' });
  const namespace = await instance.getDurableObjectNamespace('E2EE_PAIRING_REGISTRY');
  const registry = namespace.getByName('registry');
  const availableBefore = 4_800_000_000 - 200_000;
  const total = await registry.storageBytes();
  await registryStorage.exec('UPDATE room_usage SET bytes = bytes + ? WHERE room_id = ?', availableBefore - total, existing.roomId);
  assert.equal(await registry.storageBytes(), availableBefore);

  const results = await Promise.all([client(instance), client(instance)].map(request => request('/v1/spaces', { method: 'POST' })));
  assert.deepEqual(results.map(result => result.status).sort(), [201, 507]);
  const created = results.find(result => result.status === 201).body;
  assert.equal(results.find(result => result.status === 507).body.error, 'storage_full');
  const expected = [existing.roomId, created.roomId].sort();
  assert.deepEqual((await registryStorage.exec('SELECT room_id FROM room_usage ORDER BY room_id')).map(row => row.room_id), expected);
  assert.deepEqual((await registryStorage.exec('SELECT room_id FROM offers ORDER BY room_id')).map(row => row.room_id), expected);
  assert.equal((await instance.listDurableObjectIds('E2EE_SYNC_ROOMS')).length, 2);
  assert.deepEqual(await registryStorage.exec('SELECT 1 FROM cleanup'), []);

  for (const space of [existing, created]) {
    const state = await client(instance)(`/v1/spaces/${space.roomId}`, { token: space.token });
    assert.equal(state.status, 200);
    assert.deepEqual(state.body.messages, []);
  }
});

test('space creation under storage pressure starts cleanup without allocating another room', async t => {
  const instance = await createRuntime();
  t.after(() => instance.dispose());
  const request = client(instance);
  const space = await createSpace(request);
  const sent = await request(`/v1/spaces/${space.roomId}/messages`, {
    method: 'POST', token: space.token, json: { clientId: randomUUID(), text: 'removable history' }
  });
  assert.equal(sent.status, 201);
  const registryStorage = await instance.unsafeGetDurableObjectStorage('sync-test', 'PairingRegistry', { name: 'registry' });
  await registryStorage.exec('UPDATE room_usage SET bytes = ? WHERE room_id = ?', 4_800_000_000, space.roomId);
  const blocked = await client(instance)('/v1/spaces', { method: 'POST' });
  assert.equal(blocked.status, 503);
  assert.equal(blocked.body.error, 'storage_cleaning');
  assert.equal(blocked.headers.get('Retry-After'), '1');
  assert.deepEqual(await registryStorage.exec('SELECT room_id FROM room_usage'), [{ room_id: space.roomId }]);
  assert.deepEqual(await registryStorage.exec('SELECT room_id FROM offers'), [{ room_id: space.roomId }]);
  assert.equal((await instance.listDurableObjectIds('E2EE_SYNC_ROOMS')).length, 1);
  assert.deepEqual(await registryStorage.exec('SELECT phase, cursor FROM cleanup'), [{ phase: 'refresh', cursor: '' }]);
  const namespace = await instance.getDurableObjectNamespace('E2EE_PAIRING_REGISTRY');
  assert.ok(await namespace.getByName('registry').testReadAlarm() !== null);
});

test('full storage with no removable history returns 507 while paired credentials keep working', async t => {
  const instance = await createRuntime({ virtualBaseBytes: 2_400_000_000 });
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
  await storage[0].exec('UPDATE messages SET created_at = ?', Date.now() - sevenDays - 60000);
  const registryStorage = await instance.unsafeGetDurableObjectStorage('sync-test', 'PairingRegistry', { name: 'registry' });
  const namespace = await instance.getDurableObjectNamespace('E2EE_PAIRING_REGISTRY');
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


test('a slow room maintenance does not hold another room behind a registry-wide lock', async t => {
  const instance = await createRuntime(); t.after(() => instance.dispose());
  const request = client(instance);
  const slow = await createSpace(request), fast = await createSpace(request);
  const held = (await instance.getDurableObjectNamespace('E2EE_SYNC_ROOMS')).getByName(slow.roomId);
  await held.testHoldMaintenance();
  const waiting = request(`/v1/spaces/${slow.roomId}`, { token: slow.token });
  await held.testWaitMaintenance();
  let response;
  try {
    response = await Promise.race([
      request(`/v1/spaces/${fast.roomId}/messages`, { method: 'POST', token: fast.token, json: { clientId: randomUUID(), text: 'independent room' } }),
      new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('unrelated room was blocked')), 2000); timer.unref(); })
    ]);
  } finally { await held.testReleaseMaintenance(); await waiting; }
  assert.equal(response.status, 201);
});

test('history cursors return deltas and reset safely after clear, expiry and pruning', async () => {
  const request = client(), space = await createSpace(request);
  const post = async text => (await request(`/v1/spaces/${space.roomId}/messages`, { method: 'POST', token: space.token, json: { clientId: randomUUID(), text } })).body;
  const first = await post('first');
  const initial = (await request(`/v1/spaces/${space.roomId}`, { token: space.token })).body;
  const second = await post('second');
  let delta = await request(`/v1/spaces/${space.roomId}/messages?after=${first.id}&generation=${initial.history.generation}`, { token: space.token });
  assert.equal(delta.body.historyMode, 'append'); assert.deepEqual(delta.body.messages, [second]);
  const response = await runtime.dispatchFetch(`https://sync.test/v1/spaces/${space.roomId}/socket?after=${first.id}&generation=${initial.history.generation}`, { headers: { Origin: origin, Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `sync, auth.${space.token}` } });
  assert.equal(response.status, 101);
  const socket = response.webSocket; socket.accept(); sockets.add(socket);
  socketSessions.set(socket, { request, session: request.state.sessions.get(space.token) });
  const ready = socketEvent(socket); socket.send(JSON.stringify({ type: 'auth', token: space.token }));
  const frame = JSON.parse((await ready).data);
  assert.equal(frame.historyMode, 'append'); assert.deepEqual(frame.messages, [second]);
  socket.close(); sockets.delete(socket);
  await request(`/v1/spaces/${space.roomId}/messages`, { method: 'DELETE', token: space.token });
  const third = await post('after clear');
  delta = await request(`/v1/spaces/${space.roomId}/messages?after=${second.id}&generation=${initial.history.generation}`, { token: space.token });
  assert.equal(delta.body.historyMode, 'replace'); assert.deepEqual(delta.body.messages, [third]);
  const afterClear = delta.body.history, fourth = await post('survivor');
  const storage = await runtime.unsafeGetDurableObjectStorage('sync-test', 'SyncRoom', { name: space.roomId });
  await storage.exec('UPDATE messages SET created_at = ? WHERE id = ?', Date.now() - sevenDays - 1, third.id);
  delta = await request(`/v1/spaces/${space.roomId}/messages?before=${fourth.id}&generation=${afterClear.generation}`, { token: space.token });
  assert.equal(delta.body.historyMode, 'replace'); assert.deepEqual(delta.body.messages, [fourth]);
  assert.notEqual(delta.body.history.generation, afterClear.generation);
  const beforePrune = delta.body.history;
  await (await runtime.getDurableObjectNamespace('E2EE_SYNC_ROOMS')).getByName(space.roomId).pruneOldest();
  delta = await request(`/v1/spaces/${space.roomId}/messages?after=${fourth.id}&generation=${beforePrune.generation}`, { token: space.token });
  assert.equal(delta.body.historyMode, 'replace'); assert.deepEqual(delta.body.messages, []);
  assert.notEqual(delta.body.history.generation, beforePrune.generation);
  for (const query of ['before=-1', 'after=not-a-number', 'limit=51', 'before=1&after=2']) assert.equal((await request(`/v1/spaces/${space.roomId}/messages?${query}`, { token: space.token })).status, 400);
});

test('public storage status is read only, aggregate only and distinguishes project storage from account usage', async t => {
  const instance = await createRuntime(); t.after(() => instance.dispose());
  const request = client(instance), space = await createSpace(request);
  await request(`/v1/spaces/${space.roomId}/messages`, { method: 'POST', token: space.token, json: { clientId: randomUUID(), text: 'private content must not appear' } });
  const storage = await instance.unsafeGetDurableObjectStorage('sync-test', 'PairingRegistry', { name: 'registry' });
  const before = await storage.exec('SELECT * FROM room_usage'), response = await request('/v1/status');
  assert.equal(response.status, 200); assert.equal(response.body.ok, true);
  assert.equal(response.body.database.registry.ok, true); assert.equal(response.body.database.sampledRoom.ok, true);
  assert.equal(response.body.storage.roomCount, 1); assert.equal(response.body.storage.scope, 'this-project');
  assert.equal(response.body.storage.accountUsageAvailable, false);
  assert.equal(response.body.storage.highWaterBytes, 4_800_000_000); assert.equal(response.body.storage.cleanupBytes, 3_000_000_000);
  assert.ok(response.body.storage.bytes > 0);
  for (const privateValue of ['private content', space.roomId, space.deviceId, space.token]) assert.equal(JSON.stringify(response.body).includes(privateValue), false);
  const publicStrings = Object.values(response.body).flatMap(function strings(value) {
    return typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
  });
  assert.equal(publicStrings.includes(space.code), false);
  assert.deepEqual(await storage.exec('SELECT * FROM room_usage'), before);
  const registry = (await instance.getDurableObjectNamespace('E2EE_PAIRING_REGISTRY')).getByName('registry');
  await registry.maintainRooms(); await registry.testDropAlarm();
  await registry.testExpireDiagnosticsCache();
  const running = await request('/v1/status');
  assert.equal(running.body.maintenance.running, true); assert.ok(running.body.maintenance.startedAt > 0);
  await registry.testRunAlarm();
  await registry.testExpireDiagnosticsCache();
  const finished = await request('/v1/status');
  assert.equal(finished.body.maintenance.running, false); assert.ok(finished.body.maintenance.lastSuccessAt >= running.body.maintenance.startedAt);
});

test('public status coalesces diagnostics, caches healthy snapshots for fifteen seconds and retries failures', async t => {
  const instance = await createRuntime(); t.after(() => instance.dispose());
  const request = client(instance), space = await createSpace(request);
  const registry = (await instance.getDurableObjectNamespace('E2EE_PAIRING_REGISTRY')).getByName('registry');
  const room = (await instance.getDurableObjectNamespace('E2EE_SYNC_ROOMS')).getByName(space.roomId);
  const storage = await instance.unsafeGetDurableObjectStorage('sync-test', 'PairingRegistry', { name: 'registry' });
  const before = await storage.exec('SELECT total_changes() AS changes');
  await room.testHoldDatabaseProbe();
  const pending = Array.from({ length: 6 }, () => request('/v1/status'));
  await registry.testWaitStatusCalls(6);
  assert.equal(await room.testProbeCount(), 1);
  await room.testReleaseDatabaseProbe();
  const snapshots = await Promise.all(pending);
  for (const result of snapshots) { assert.equal(result.status, 200); assert.deepEqual(result.body, snapshots[0].body); }
  assert.equal(await registry.testDiagnosticsCacheUntil(), snapshots[0].body.checkedAt + 15000);
  const cached = await request('/v1/status');
  assert.equal(cached.body.checkedAt, snapshots[0].body.checkedAt);
  assert.equal(await room.testProbeCount(), 1);
  assert.deepEqual(await storage.exec('SELECT total_changes() AS changes'), before);

  await registry.testExpireDiagnosticsCache();
  await room.testFailDatabaseProbe();
  const failed = await request('/v1/status');
  assert.equal(failed.body.ok, false); assert.equal(failed.body.database.sampledRoom.ok, false);
  assert.equal((await request('/v1/status')).body.ok, true);
  assert.equal(await room.testProbeCount(), 3, 'A failed database probe must not leave a cached failure');
  await registry.testExpireDiagnosticsCache();
  await registry.testFailDiagnostics();
  assert.equal((await request('/v1/status')).status, 500);
  assert.equal((await request('/v1/status')).body.ok, true);
  assert.equal(await room.testProbeCount(), 4, 'A rejected diagnostic collection must not leave an in-flight promise');
});

test('reconnect catch-up pages are bounded and continuation visits every retained message once', async t => {
  const instance = await createRuntime(); t.after(() => instance.dispose());
  const request = client(instance), space = await createSpace(request);
  const storage = await instance.unsafeGetDurableObjectStorage('sync-test', 'SyncRoom', { name: space.roomId });
  const text = '汉'.repeat(10000);
  for (let index = 0; index < 135; index += 1) await storage.exec('INSERT INTO messages (client_id, device_id, text, created_at) VALUES (?, ?, ?, ?)', randomUUID(), space.deviceId, text, Date.now());
  const initial = (await request(`/v1/spaces/${space.roomId}`, { token: space.token })).body;
  const response = await instance.dispatchFetch(`https://sync.test/v1/spaces/${space.roomId}/socket?after=1&generation=${initial.history.generation}`, { headers: { Origin: origin, Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `sync, auth.${space.token}` } });
  const reconnect = response.webSocket; reconnect.accept(); sockets.add(reconnect);
  const ready = socketEvent(reconnect); reconnect.send(JSON.stringify({ type: 'auth', token: space.token }));
  let page = JSON.parse((await ready).data);
  assert.equal(page.historyMode, 'append'); assert.equal(page.messages.length, 50);
  assert.equal(page.history.continuationId, 51); assert.equal(page.history.hasNewer, true);
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 1_600_000);
  const ids = page.messages.map(message => message.id);
  while (page.history.hasNewer) {
    page = (await request(`/v1/spaces/${space.roomId}/messages?after=${page.history.continuationId}&limit=50&generation=${page.history.generation}`, { token: space.token })).body;
    assert.ok(page.messages.length <= 50);
    ids.push(...page.messages.map(message => message.id));
  }
  assert.deepEqual(ids, Array.from({ length: 134 }, (_, index) => index + 2));
  assert.equal(page.history.continuationId, 135);
  reconnect.close(); sockets.delete(reconnect);
});

test('status rotates room probes and distinguishes missing, stale, overdue and recovered maintenance', async t => {
  const instance = await createRuntime(); t.after(() => instance.dispose());
  const request = client(instance), first = await createSpace(request), second = await createSpace(request);
  const namespace = await instance.getDurableObjectNamespace('E2EE_SYNC_ROOMS');
  const rooms = [namespace.getByName(first.roomId), namespace.getByName(second.roomId)];
  const storage = await instance.unsafeGetDurableObjectStorage('sync-test', 'PairingRegistry', { name: 'registry' });
  const registry = (await instance.getDurableObjectNamespace('E2EE_PAIRING_REGISTRY')).getByName('registry');
  let response = await request('/v1/status');
  assert.equal(response.body.maintenance.status, 'never'); assert.equal(response.body.maintenance.lastSuccessAt, null);
  assert.equal(response.body.maintenance.stale, true); assert.equal(response.body.maintenance.overdue, false);
  await registry.testExpireDiagnosticsCache();
  await request('/v1/status');
  assert.deepEqual(await Promise.all(rooms.map(room => room.testProbeCount())), [1, 1]);
  const oldSuccess = Date.now() - 27 * 60 * 60 * 1000;
  await storage.exec('INSERT INTO registry_metadata (key, value) VALUES (?, ?)', 'lastMaintenanceSuccessAt', oldSuccess);
  await registry.testExpireDiagnosticsCache();
  response = await request('/v1/status');
  assert.equal(response.body.maintenance.status, 'overdue'); assert.equal(response.body.maintenance.stale, true);
  await registry.maintainRooms(); await registry.testDropAlarm();
  await registry.testExpireDiagnosticsCache();
  response = await request('/v1/status');
  assert.equal(response.body.maintenance.overdue, true); assert.equal(response.body.maintenance.nextAlarmAt, null);
  await registry.testRunAlarm();
  await registry.testExpireDiagnosticsCache();
  response = await request('/v1/status');
  assert.equal(response.body.maintenance.status, 'healthy'); assert.equal(response.body.maintenance.stale, false);
  const recentFailure = Date.now() + 1000;
  await storage.exec('INSERT INTO registry_metadata (key, value) VALUES (?, ?)', 'lastMaintenanceFailureAt', recentFailure);
  await registry.testExpireDiagnosticsCache();
  response = await request('/v1/status');
  assert.equal(response.body.maintenance.status, 'failed'); assert.equal(response.body.maintenance.lastFailureCode, 'maintenance_failed');
  await storage.exec('UPDATE registry_metadata SET value = ? WHERE key = ?', recentFailure + 1000, 'lastMaintenanceSuccessAt');
  await registry.testExpireDiagnosticsCache();
  response = await request('/v1/status');
  assert.equal(response.body.maintenance.status, 'healthy'); assert.equal(response.body.maintenance.lastFailureCode, null);
});

test('in-flight upload reservations protect global capacity while another room remains responsive', async t => {
  const instance = await createRuntime({ virtualBaseBytes: 1_000_000_000 }); t.after(() => instance.dispose());
  const request = client(instance), first = await createSpace(request), second = await createSpace(request);
  const namespace = await instance.getDurableObjectNamespace('E2EE_SYNC_ROOMS'), held = namespace.getByName(first.roomId);
  const registryStorage = await instance.unsafeGetDurableObjectStorage('sync-test', 'PairingRegistry', { name: 'registry' });
  await held.testHoldUploadBegin();
  const begin = space => request(`/v1/spaces/${space.roomId}/files/uploads`, { method: 'POST', token: space.token, json: { clientId: randomUUID(), name: 'large.bin', size: 2 * 1024 ** 3, type: 'application/octet-stream' } });
  const pending = begin(first);
  await held.testWaitUploadBegin();
  try {
    const reservations = await registryStorage.exec('SELECT room_id, bytes FROM reservations');
    assert.equal(reservations.length, 1); assert.equal(reservations[0].room_id, first.roomId); assert.ok(reservations[0].bytes > 2 * 1024 ** 3);
    const blocked = await begin(second);
    assert.equal(blocked.status, 507); assert.equal(blocked.body.error, 'storage_full');
    assert.deepEqual(await registryStorage.exec('SELECT room_id, bytes FROM reservations'), reservations);
  } finally { await held.testReleaseUploadBegin(); }
  assert.equal((await pending).status, 201);
  assert.deepEqual(await registryStorage.exec('SELECT 1 FROM reservations'), []);
});


test('pairing sources are assigned by the relay, scoped to each offer and retained on resume', async () => {
  const owner = client();
  const spaces = [await createSpace(owner), await createSpace(owner)];
  const source = client();
  const other = client();
  const frames = await Promise.all(spaces.map(async space => ({ offerId: space.pairing.offerId,
    startLoginRequest: (await cryptoClient.startPairingClient('1234', space.pairing.offerId)).startLoginRequest })));
  const begin = async (request, values = frames) => {
    const requestId = randomUUID();
    const result = await request.raw('/v1/pair', { method: 'POST', json: { requestId, requestToken: 'a'.repeat(64), requests: values } });
    return { ...result, requestId };
  };
  for (const json of [
    { requestId: randomUUID(), requestToken: 'a'.repeat(64), requests: frames, sourceId: 'b'.repeat(64) },
    { requestId: randomUUID(), requestToken: 'a'.repeat(64), requests: [{ ...frames[0], sourceId: 'b'.repeat(64) }] }
  ]) assert.equal((await source.raw('/v1/pair', { method: 'POST', json })).status, 400);
  const first = await begin(source), second = await begin(source), independent = await begin(other);
  assert.equal(first.status, 202);
  assert.equal(second.status, 202);
  assert.equal(independent.status, 202);
  const storage = await runtime.unsafeGetDurableObjectStorage('sync-test', 'PairingRegistry', { name: 'registry' });
  const rows = await storage.exec('SELECT request_id, offer_id, source_id FROM pair_candidates');
  const sourceFor = (request, space) => rows.find(row => row.request_id === request.requestId && row.offer_id === space.pairing.offerId).source_id;
  const id = sourceFor(first, spaces[0]);
  assert.match(id, /^[0-9a-f]{64}$/);
  assert.equal(id, sourceFor(second, spaces[0]), 'one source retains the same attempt bucket');
  assert.notEqual(id, sourceFor(independent, spaces[0]), 'another source has an independent budget');
  assert.notEqual(id, sourceFor(first, spaces[1]), 'identifiers cannot correlate a source across rooms');
  const pending = await owner.raw(`/v1/spaces/${spaces[0].roomId}/pair-requests`, { token: spaces[0].token });
  assert.equal(pending.status, 200);
  assert.equal(pending.body.requests.find(event => event.requestId === first.requestId).sourceId, id);
  const publicOffers = await source('/v1/pair/offers');
  assert.ok(publicOffers.body.offers.every(offer => !Object.hasOwn(offer, 'sourceId')));
});
