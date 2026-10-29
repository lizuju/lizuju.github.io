import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, afterEach, before, test } from 'node:test';
import { Miniflare } from 'miniflare';
import { encryptedClient, cryptoClient } from './e2ee-client.mjs';

const origin = 'https://lizuju.github.io';
const MiB = 1024 * 1024;
const chunkSize = 8 * MiB;
const maximumFileSize = 2 * 1024 * MiB;
const sevenDays = 7 * 24 * 60 * 60 * 1000;
let runtime;
let nextIp = 1;
const sockets = new Set();

before(async () => { runtime = await createRuntime(); });
after(async () => {
  for (const socket of sockets) if (socket.readyState === 1) socket.close();
  await runtime?.dispose();
});
afterEach(async () => {
  const request = client();
  for (const session of request.state.sessions.values()) await request.raw(`/v1/spaces/${session.roomId}/pair-code`, { method: 'DELETE', token: session.token });
  request.state.offers.clear();
});

async function createRuntime({ virtualMessageBytes = 0, virtualBaseBytes = 0, observedLogs = [] } = {}) {
  const instance = new Miniflare({
    unsafeInspectDurableObjects: true,
    handleStructuredLogs: entry => { observedLogs.push(entry.message); },
    workers: [{
      config: {
        name: 'sync-files-test',
        compatibilityDate: '2026-10-23',
        manifest: {
          mainModule: 'harness.js',
          modules: {
            'index.js': { type: 'esm', contents: await readFile(new URL('../src/index.js', import.meta.url), 'utf8') },
            'daily-usage.js': { type: 'esm', contents: await readFile(new URL('../src/daily-usage.js', import.meta.url), 'utf8') },
            'api-version.js': { type: 'esm', contents: await readFile(new URL('../src/api-version.js', import.meta.url), 'utf8') },
            'harness.js': {
              type: 'esm',
              contents: `import worker, { E2eeSyncRoom as ProductionSyncRoom, E2eePairingRegistry as ProductionRegistry, E2eeFileShard as ProductionFileShard } from './index.js';
                export class FileShard extends ProductionFileShard {
                  testHoldSize(fail = false) {
                    this.sizeObserved = true;
                    this.sizeFail = fail;
                    this.sizeGate = new Promise(resolve => { this.releaseSize = resolve; });
                  }
                  testReleaseSize() { this.releaseSize(); this.sizeGate = null; }
                  async storageBytes() {
                    if (!this.sizeObserved) return super.storageBytes();
                    const registry = this.env.E2EE_PAIRING_REGISTRY.getByName('registry');
                    await registry.testSizeStart();
                    try {
                      if (this.sizeGate) await this.sizeGate;
                      if (this.sizeFail) { this.sizeFail = false; throw new Error('test_size_probe_failed'); }
                      return super.storageBytes();
                    } finally { await registry.testSizeEnd(); }
                  }
                  testHoldDatabaseProbe() { this.probeGate = new Promise(resolve => { this.releaseProbe = resolve; }); }
                  testReleaseDatabaseProbe() { this.releaseProbe(); this.probeGate = null; }
                  async databaseProbe() { this.probeCount = (this.probeCount || 0) + 1; if (this.probeGate) await this.probeGate; return super.databaseProbe(); }
                  testProbeCount() { return this.probeCount || 0; }
                  testFailRead() { this.failRead = true; }
                  testHoldRead() { this.readGate = new Promise(resolve => { this.releaseRead = resolve; }); }
                  testReleaseRead() { this.releaseRead(); this.readGate = null; }
                  async readStream(offset, length) {
                    if (this.failRead) throw new Error('private-rpc-sentinel-ticket-and-secret');
                    this.readRequests ||= [];
                    this.readRequests.push({ offset, length });
                    if (this.readGate) await this.readGate;
                    return super.readStream(offset, length);
                  }
                  testReadRequests() { return this.readRequests || []; }
                }
                export default {
                  fetch(request, env, ctx) {
                    const declared = request.headers.get('X-Test-Content-Length');
                    if (declared !== null) {
                      const headers = new Headers(request.headers);
                      if (declared === 'omit') headers.delete('Content-Length');
                      else headers.set('Content-Length', declared);
                      request = new Request(request, { headers });
                    }
                    return worker.fetch(request, env, ctx);
                  }
                };
                export class PairingRegistry extends ProductionRegistry {
                  hasRoom(roomId) { this.roomLookups = (this.roomLookups || 0) + 1; return super.hasRoom(roomId); }
                  testRoomLookups() { return this.roomLookups || 0; }
                  async testExpireDiagnosticsCache() { this.diagnosticsCacheUntil = Date.now() - 1; await caches.default.delete('https://sync.test/v1/status?release=local'); }
                  testSizeStart() {
                    this.sizeCalls = (this.sizeCalls || 0) + 1;
                    this.sizeActive = (this.sizeActive || 0) + 1;
                    this.sizeMaximum = Math.max(this.sizeMaximum || 0, this.sizeActive);
                    for (const waiter of this.sizeWaiters || []) if (!waiter.finished && this.sizeCalls >= waiter.count) waiter.resolve();
                  }
                  testSizeEnd() {
                    this.sizeActive--;
                    this.sizeFinished = (this.sizeFinished || 0) + 1;
                    for (const waiter of this.sizeWaiters || []) if (waiter.finished && this.sizeFinished >= waiter.count) waiter.resolve();
                  }
                  testSizeStats() { return [this.sizeCalls || 0, this.sizeActive || 0, this.sizeMaximum || 0, this.sizeFinished || 0]; }
                  testWaitSizeCalls(count, finished = false) {
                    if ((finished ? this.sizeFinished || 0 : this.sizeCalls || 0) >= count) return;
                    return new Promise(resolve => { (this.sizeWaiters ||= []).push({ count, finished, resolve }); });
                  }
                  refreshRoom(roomId) { this.refreshes = (this.refreshes || 0) + 1; return super.refreshRoom(roomId); }
                  testRefreshes() { return this.refreshes || 0; }
                  rememberUsage(...args) {
                    const before = this.sql.exec('SELECT total_changes() AS count').one().count;
                    super.rememberUsage(...args);
                    this.usageWrites = (this.usageWrites || 0) + this.sql.exec('SELECT total_changes() AS count').one().count - before;
                  }
                  testUsageWrites() { return this.usageWrites || 0; }
                  testRunAlarm() { return super.alarm(); }
                  testReadAlarm() { return this.ctx.storage.getAlarm(); }
                }
                export class SyncRoom extends ProductionSyncRoom {
                  testRebuildAccounting() { this.shardBytes = null; return this.storageUsage(); }
                  testBeginReads() {
                    this.readCursors = [];
                    const sql = this.sql;
                    this.sql = new Proxy(sql, { get: (target, key) => key === 'exec' ? (...args) => {
                      const cursor = target.exec(...args); this.readCursors.push(cursor); return cursor;
                    } : Reflect.get(target, key, target) });
                  }
                  testFileLookups(messageId) {
                    const queries = [
                      this.sql.exec("SELECT * FROM files WHERE message_id = ? AND status = 'complete'", messageId),
                      this.sql.exec("SELECT min(updated_at) AS updated_at FROM files WHERE status = 'uploading'"),
                      this.sql.exec("SELECT 1 FROM files WHERE status = 'deleting' LIMIT 1")
                    ];
                    return queries.map(cursor => ({ rows: cursor.toArray(), reads: cursor.rowsRead }));
                  }
                  testReadCount() { return this.readCursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0); }
                  testArmUploadAuthorization() { this.uploadAuthorizationArmed = true; this.uploadAuthorized = false; }
                  testUploadAuthorized() { return !!this.uploadAuthorized; }
                  checkWrite(...args) {
                    const result = super.checkWrite(...args);
                    if (this.uploadAuthorizationArmed) this.uploadAuthorized = true;
                    return result;
                  }
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
          E2EE_PAIRING_REGISTRY: { type: 'durable-object', worker: 'sync-files-test', exportName: 'PairingRegistry' },
          E2EE_SYNC_ROOMS: { type: 'durable-object', worker: 'sync-files-test', exportName: 'SyncRoom' },
          E2EE_FILE_SHARDS: { type: 'durable-object', worker: 'sync-files-test', exportName: 'FileShard' }
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

function client(instance = runtime) {
  const ip = `198.51.100.${nextIp++}`;
  return encryptedClient(instance, { origin, ip });
}

async function createSpace(request = client()) {
  const result = await request('/v1/spaces', { method: 'POST' });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body;
}

function initiate(request, space, { clientId = randomUUID(), name = 'file.bin', type = 'application/octet-stream', size = 0, text = '', fingerprint } = {}) {
  return request(`/v1/spaces/${space.roomId}/files/uploads`, {
    method: 'POST', token: space.token, json: { clientId, name, type, size, text, fingerprint }
  });
}

function putChunk(request, space, uploadId, index, bytes, headers = {}) {
  return request(`/v1/spaces/${space.roomId}/files/uploads/${uploadId}/chunks/${index}`, {
    method: 'PUT', token: space.token, body: bytes,
    headers: { 'Content-Type': 'application/octet-stream', ...headers }
  });
}

function complete(request, space, uploadId) {
  return request(`/v1/spaces/${space.roomId}/files/uploads/${uploadId}/complete`, { method: 'POST', token: space.token });
}

async function upload(request, space, { bytes = Buffer.from('attachment'), ...metadata } = {}) {
  const started = await initiate(request, space, { ...metadata, size: bytes.length });
  assert.ok([200, 201].includes(started.status), JSON.stringify(started.body));
  if (started.body.message) return { ...started, body: started.body.message };
  assert.equal(started.body.chunkSize, chunkSize);
  for (let offset = 0, index = 0; offset < bytes.length; offset += chunkSize, index += 1) {
    const stored = await putChunk(request, space, started.body.uploadId, index, bytes.subarray(offset, offset + chunkSize));
    assert.equal(stored.status, 200, JSON.stringify(stored.body));
    assert.equal(stored.body.receivedBytes, Math.min(offset + chunkSize, bytes.length));
  }
  return complete(request, space, started.body.uploadId);
}

async function roomStorage(space, instance = runtime) {
  return instance.unsafeGetDurableObjectStorage('sync-files-test', 'SyncRoom', { name: space.roomId });
}

async function roomObject(space, instance = runtime) {
  const namespace = await instance.getDurableObjectNamespace('E2EE_SYNC_ROOMS');
  return namespace.getByName(space.roomId);
}

async function shardRows(ids, instance = runtime) {
  const rows = [];
  for (const id of ids) {
    const storage = await instance.unsafeGetDurableObjectStorage('sync-files-test', 'FileShard', { id });
    if (!(await storage.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chunks'")).length) continue;
    rows.push(...await storage.exec('SELECT length(data) AS bytes FROM chunks'));
  }
  return rows;
}

async function drainDeletedFiles(space, instance = runtime) {
  const room = await roomObject(space, instance);
  const storage = await roomStorage(space, instance);
  for (let turn = 0; turn < 10; turn += 1) {
    if (!(await storage.exec("SELECT 1 FROM files WHERE status = 'deleting'")).length) return;
    await room.maintain();
  }
  assert.fail('file cleanup did not finish within ten bounded maintenance turns');
}

function socketEvent(socket, type = 'message') {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener(type, onEvent);
      reject(new Error(`WebSocket ${type} event did not arrive`));
    }, 5000);
    function onEvent(event) {
      clearTimeout(timeout);
      socket.removeEventListener(type, onEvent);
      resolve(event);
    }
    socket.addEventListener(type, onEvent);
  });
}

async function authenticateSocket(space, instance = runtime) {
  const request = client(instance);
  const session = request.state.sessions.get(space.token);
  await request.update(session);
  const response = await instance.dispatchFetch(`https://sync.test/v1/spaces/${space.roomId}/socket`, {
    headers: { Origin: origin, Upgrade: 'websocket', 'CF-Connecting-IP': `203.0.113.${nextIp++}` }
  });
  assert.equal(response.status, 101);
  const socket = response.webSocket;
  socket.accept();
  sockets.add(socket);
  socket.addEventListener('close', () => sockets.delete(socket));
  const ready = socketEvent(socket);
  socket.send(JSON.stringify({ type: 'auth', token: space.token }));
  const frame = JSON.parse((await ready).data);
  assert.equal(frame.type, 'ready');
  frame.messages = await Promise.all(frame.messages.map(async value => ({ ...value,
    ...await cryptoClient.decryptPayload(session.keyring, session.roomId, `message:${value.deviceId}:${value.clientId}`, value.text) })));
  return { socket, frame };
}

test('a binary file crosses 8 MiB upload chunks and 64 MiB shards without losing bytes after restart', async () => {
  const request = client();
  const space = await createSpace(request);
  const connected = await authenticateSocket(space);
  const bytes = randomBytes(64 * MiB + 731);
  const name = '演奏片段 🎹.mov';
  const sent = await upload(request, space, { bytes, name, type: 'video/quicktime', text: '跨分片中文说明' });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  assert.deepEqual(sent.body.attachment, { name, type: 'video/quicktime', size: bytes.length });
  assert.equal(sent.body.deviceId, space.deviceId);
  assert.equal(sent.body.text, '跨分片中文说明');
  const shardIds = await runtime.listDurableObjectIds('E2EE_FILE_SHARDS');
  assert.equal(shardIds.length, 2);
  const chunks = await shardRows(shardIds);
  assert.equal(chunks.length, 65);
  assert.ok(chunks.every(chunk => chunk.bytes > 0 && chunk.bytes <= MiB));
  assert.equal(chunks.reduce((total, chunk) => total + chunk.bytes, 0), bytes.length);
  for (const id of shardIds) await runtime.unsafeEvictDurableObject('sync-files-test', 'FileShard', { id });
  await runtime.unsafeEvictDurableObject('sync-files-test', 'SyncRoom', { name: space.roomId, webSockets: 'hibernate' });
  const downloaded = await request(`/v1/spaces/${space.roomId}/files/${sent.body.id}`, { token: space.token });
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.headers.get('Content-Type'), 'application/octet-stream');
  assert.equal(downloaded.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(downloaded.headers.get('Cache-Control'), 'no-store');
  assert.match(downloaded.headers.get('Content-Disposition'), /^attachment;/);
  assert.ok(!downloaded.headers.get('Content-Disposition').includes(encodeURIComponent(name)));
  assert.equal(downloaded.headers.get('Content-Disposition'), 'attachment; filename="encrypted-file"');
  assert.equal(downloaded.body.length, bytes.length);
  assert.equal(createHash('sha256').update(downloaded.body).digest('hex'), createHash('sha256').update(bytes).digest('hex'));
  for (const [start, end] of [[MiB - 9, MiB + 11], [64 * MiB - 17, 64 * MiB + 43], [64 * MiB + 107, bytes.length - 1]]) {
    const ranged = await request(`/v1/spaces/${space.roomId}/files/${sent.body.id}`, { token: space.token, headers: { Range: `bytes=${start}-${end}` } });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get('Content-Range'), `bytes ${start}-${end}/${bytes.length}`);
    assert.equal(ranged.headers.get('Content-Length'), String(end - start + 1));
    assert.deepEqual(ranged.body, bytes.subarray(start, end + 1));
  }
  const state = await request(`/v1/spaces/${space.roomId}`, { token: space.token });
  assert.deepEqual(state.body.messages, [sent.body]);
  const restored = await authenticateSocket(space);
  assert.deepEqual(restored.frame.messages, [sent.body]);
  const plain = await request(`/v1/spaces/${space.roomId}/messages`, {
    method: 'POST', token: space.token, json: { clientId: randomUUID(), text: 'still plain text' }
  });
  assert.equal(plain.status, 201);
  assert.deepEqual(Object.keys(plain.body).sort(), ['clientId', 'createdAt', 'deviceId', 'id', 'text']);
  assert.equal((await request(`/v1/spaces/${space.roomId}/files/${plain.body.id}`, { token: space.token })).status, 404);
  connected.socket.close();
  restored.socket.close();
});

test('expired device credentials revoke download tickets and abandoned uploads without deleting shared history', async () => {
  const request = client();
  const space = await createSpace(request);
  const peer = (await client()('/v1/pair', { method: 'POST', json: { code: space.code } })).body;
  const sent = await upload(request, space);
  const ticket = await request(`/v1/spaces/${space.roomId}/files/${sent.body.id}/download`, { method: 'POST', token: space.token });
  const pending = await initiate(request, space, { size: 1024 });
  const storage = await roomStorage(space);
  await storage.exec('UPDATE devices SET last_active_at = ? WHERE device_id = ?', Date.now() - sevenDays, space.deviceId);
  assert.equal((await request(`/v1/spaces/${space.roomId}/downloads/${ticket.body.ticket}`)).status, 401);
  assert.deepEqual(await storage.exec('SELECT ticket FROM download_tickets'), []);
  assert.equal((await storage.exec('SELECT status FROM files WHERE file_id = ?', pending.body.uploadId))[0].status, 'deleting');
  const received = await request(`/v1/spaces/${space.roomId}/files/${sent.body.id}`, { token: peer.token });
  assert.equal(received.status, 200);
  assert.equal(received.body.toString(), 'attachment');
});

test('empty files and Chinese image names complete without allocating unnecessary upload chunks', async () => {
  const request = client();
  const space = await createSpace(request);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64');
  for (const fixture of [
    { bytes: png, name: '中文图片.png', type: 'image/png' },
    { bytes: Buffer.alloc(0), name: 'empty.txt', type: 'text/plain' },
    { bytes: Buffer.from('no MIME'), name: 'data', type: '' }
  ]) {
    const sent = await upload(request, space, fixture);
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    assert.deepEqual(sent.body.attachment, { name: fixture.name, type: fixture.type || 'application/octet-stream', size: fixture.bytes.length });
    assert.equal(sent.body.text, '');
    const downloaded = await request(`/v1/spaces/${space.roomId}/files/${sent.body.id}`, { token: space.token });
    assert.equal(downloaded.status, 200);
    assert.deepEqual(downloaded.body, fixture.bytes);
    if (!fixture.bytes.length) {
      const range = await request(`/v1/spaces/${space.roomId}/files/${sent.body.id}`, { token: space.token, headers: { Range: 'bytes=0-' } });
      assert.equal(range.status, 416);
      assert.equal(range.headers.get('Content-Range'), 'bytes */0');
    }
  }
});

test('upload chunks retain the initial global reservation without running registry maintenance on every chunk', async () => {
  const request = client();
  const space = await createSpace(request);
  const started = await initiate(request, space, { size: chunkSize * 2 + 3 });
  assert.equal(started.status, 201);
  const namespace = await runtime.getDurableObjectNamespace('E2EE_PAIRING_REGISTRY');
  const registry = namespace.getByName('registry');
  const registryStorage = await runtime.unsafeGetDurableObjectStorage('sync-files-test', 'PairingRegistry', { name: 'registry' });
  const snapshot = await registryStorage.exec('SELECT bytes FROM room_usage WHERE room_id = ?', space.roomId);
  const refreshes = await registry.testRefreshes();
  for (const [index, bytes] of [Buffer.alloc(chunkSize), Buffer.alloc(chunkSize), Buffer.from('end')].entries()) {
    const result = await putChunk(request, space, started.body.uploadId, index, bytes);
    assert.equal(result.status, 200);
    assert.equal(await registry.testRefreshes(), refreshes);
    assert.deepEqual(await registryStorage.exec('SELECT bytes FROM room_usage WHERE room_id = ?', space.roomId), snapshot);
    const room = await roomObject(space);
    assert.ok((await room.storageUsage()).bytes <= snapshot[0].bytes, 'Initial reservation must still cover all stored chunks and remaining upload bytes');
  }
  assert.equal((await complete(request, space, started.body.uploadId)).status, 201);
  assert.equal(await registry.testRefreshes(), refreshes + 1);
  const cancelled = await initiate(request, space, { size: chunkSize });
  assert.equal(cancelled.status, 201);
  const beforeCancel = await registryStorage.exec('SELECT bytes FROM room_usage WHERE room_id = ?', space.roomId);
  assert.equal((await request(`/v1/spaces/${space.roomId}/files/uploads/${cancelled.body.uploadId}`, { method: 'DELETE', token: space.token })).status, 200);
  assert.ok((await registryStorage.exec('SELECT bytes FROM room_usage WHERE room_id = ?', space.roomId))[0].bytes < beforeCancel[0].bytes);
});

test('storage diagnostics separate pending uploads across rooms from stored bytes without double counting capacity', async t => {
  const instance = await createRuntime();
  t.after(() => instance.dispose());
  const request = client(instance);
  const spaces = [await createSpace(request), await createSpace(request)];
  const starts = [await initiate(request, spaces[0], { size: maximumFileSize }), await initiate(request, spaces[1], { size: chunkSize })];
  assert.ok(starts.every(result => result.status === 201));
  const registry = (await instance.getDurableObjectNamespace('E2EE_PAIRING_REGISTRY')).getByName('registry');
  const reserved = await Promise.all(spaces.map(async space => {
    const storage = await roomStorage(space, instance);
    return (await storage.exec('SELECT sum(reserved_bytes) AS bytes FROM files'))[0].bytes;
  }));
  const status = await request('/v1/status');
  assert.equal(status.body.storage.reservedBytes, reserved[0] + reserved[1]);
  assert.ok(status.body.storage.reservedBytes > maximumFileSize + chunkSize);
  assert.ok(status.body.storage.storedBytes < MiB);
  assert.equal(status.body.storage.bytes, status.body.storage.storedBytes + status.body.storage.reservedBytes);
  assert.equal(status.body.storage.bytes, await registry.storageBytes());
  for (const [index, space] of spaces.entries()) {
    assert.equal((await request(`/v1/spaces/${space.roomId}/files/uploads/${starts[index].body.uploadId}`, { method: 'DELETE', token: space.token })).status, 200);
  }
  await registry.testExpireDiagnosticsCache();
  const cancelled = await request('/v1/status');
  assert.equal(cancelled.body.storage.reservedBytes, 0);
  assert.equal(cancelled.body.storage.bytes, cancelled.body.storage.storedBytes);
  assert.equal(cancelled.body.storage.bytes, await registry.storageBytes());
});

test('an attachment at the history limit broadcasts only its message and updated deletion boundary', async () => {
  const request = client();
  const space = await createSpace(request);
  const connected = await authenticateSocket(space);
  const storage = await roomStorage(space);
  await storage.exec("WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 500) INSERT INTO messages (client_id, device_id, text, created_at) SELECT 'older-' || n, ?, 'retained history', ? FROM seq", space.deviceId, Date.now());
  const frames = [];
  connected.socket.addEventListener('message', event => frames.push(JSON.parse(event.data)));
  const delivered = socketEvent(connected.socket);
  const sent = await upload(request, space, { bytes: Buffer.from('attachment at the boundary') });
  assert.equal(sent.status, 201);
  await delivered;
  assert.equal(frames.length, 1);
  assert.equal(frames[0].type, 'message');
  assert.equal(frames[0].message.id, 501);
  assert.equal(frames[0].history.oldestId, 2);
  assert.equal(frames[0].history.latestId, 501);
  assert.notEqual(frames[0].history.generation, connected.frame.history.generation);
  assert.deepEqual(await storage.exec('SELECT count(*) AS count FROM messages'), [{ count: 500 }]);
  connected.socket.close();
});

test('unchanged usage refreshes and read-only attachment requests avoid registry writes', async () => {
  const request = client();
  const space = await createSpace(request);
  const bytes = Buffer.from('read-only attachment');
  const sent = await upload(request, space, { bytes });
  assert.equal(sent.status, 201);
  const namespace = await runtime.getDurableObjectNamespace('E2EE_PAIRING_REGISTRY');
  const registry = namespace.getByName('registry');
  await registry.refreshRoom(space.roomId);
  const writes = await registry.testUsageWrites();
  for (let index = 0; index < 3; index += 1) await registry.refreshRoom(space.roomId);
  assert.equal(await registry.testUsageWrites(), writes);
  const refreshes = await registry.testRefreshes();
  const path = `/v1/spaces/${space.roomId}/files/${sent.body.id}`;
  for (let index = 0; index < 5; index += 1) {
    assert.equal((await request(path, { method: 'HEAD', token: space.token })).status, 200);
    const downloaded = await request(path, { token: space.token });
    assert.equal(downloaded.status, 200);
    assert.deepEqual(downloaded.body, bytes);
  }
  assert.equal(await registry.testRefreshes(), refreshes);
  assert.equal(await registry.testUsageWrites(), writes);
  const storage = await roomStorage(space);
  await storage.exec('UPDATE files SET created_at = ? WHERE message_id = ?', Date.now() - sevenDays - 1000, sent.body.id);
  assert.equal((await request(path, { method: 'HEAD', token: space.token })).status, 404);
  assert.equal((await request(path, { token: space.token })).status, 404);
});

test('upload finalization bounds shard probes to four and updates only changed accounting', async t => {
  const instance = await createRuntime(); t.after(() => instance.dispose());
  const request = client(instance), space = await createSpace(request);
  const started = await initiate(request, space);
  const storage = await roomStorage(space, instance);
  const shards = await instance.getDurableObjectNamespace('E2EE_FILE_SHARDS');
  const registry = (await instance.getDurableObjectNamespace('E2EE_PAIRING_REGISTRY')).getByName('registry');
  const objects = [];
  // Empty virtual shards exercise finalization scheduling without duplicating the large-transfer test.
  for (let index = 0; index < 9; index++) {
    const shard = shards.getByName(`${started.body.uploadId}:${index}`);
    const bytes = await shard.storageBytes();
    await storage.exec('INSERT INTO file_shards (file_id, shard_index, bytes) VALUES (?, ?, ?)', started.body.uploadId, index, bytes + ([2, 5].includes(index) ? 4096 : 0));
    await shard.testHoldSize();
    objects.push(shard);
  }
  await storage.exec('CREATE TABLE finalize_updates (shard_index INTEGER)');
  await storage.exec('CREATE TRIGGER count_finalize_updates AFTER UPDATE OF bytes ON file_shards BEGIN INSERT INTO finalize_updates VALUES (NEW.shard_index); END');
  const pending = complete(request, space, started.body.uploadId);
  await registry.testWaitSizeCalls(4);
  assert.deepEqual(await registry.testSizeStats(), [4, 4, 4, 0]);
  await Promise.all(objects.slice(0, 4).map(shard => shard.testReleaseSize()));
  await registry.testWaitSizeCalls(8);
  assert.deepEqual(await registry.testSizeStats(), [8, 4, 4, 4]);
  await Promise.all(objects.slice(4, 8).map(shard => shard.testReleaseSize()));
  await registry.testWaitSizeCalls(9);
  assert.deepEqual(await registry.testSizeStats(), [9, 1, 4, 8]);
  await objects[8].testReleaseSize();
  const completed = await pending;
  assert.equal(completed.status, 201);
  assert.deepEqual(await registry.testSizeStats(), [9, 0, 4, 9]);
  assert.deepEqual(await storage.exec('SELECT shard_index FROM finalize_updates ORDER BY shard_index'), [{ shard_index: 2 }, { shard_index: 5 }]);
  assert.equal((await complete(request, space, started.body.uploadId)).status, 200);
  assert.deepEqual(await registry.testSizeStats(), [9, 0, 4, 9]);
});

test('a failed finalization waits for its active batch before retrying and never publishes partial files', async t => {
  const instance = await createRuntime(); t.after(() => instance.dispose());
  const request = client(instance), space = await createSpace(request);
  const started = await initiate(request, space);
  const storage = await roomStorage(space, instance);
  const shards = await instance.getDurableObjectNamespace('E2EE_FILE_SHARDS');
  const registry = (await instance.getDurableObjectNamespace('E2EE_PAIRING_REGISTRY')).getByName('registry');
  const objects = [];
  for (let index = 0; index < 5; index++) {
    const shard = shards.getByName(`${started.body.uploadId}:${index}`);
    await storage.exec('INSERT INTO file_shards (file_id, shard_index, bytes) VALUES (?, ?, ?)', started.body.uploadId, index, await shard.storageBytes() + 4096);
    await shard.testHoldSize(index === 0);
    objects.push(shard);
  }
  await storage.exec('CREATE TABLE finalize_updates (shard_index INTEGER)');
  await storage.exec('CREATE TRIGGER count_finalize_updates AFTER UPDATE OF bytes ON file_shards BEGIN INSERT INTO finalize_updates VALUES (NEW.shard_index); END');
  let settled = false;
  const pending = complete(request, space, started.body.uploadId).then(result => { settled = true; return result; });
  await registry.testWaitSizeCalls(4);
  await objects[0].testReleaseSize();
  await registry.testWaitSizeCalls(1, true);
  assert.equal(settled, false);
  assert.deepEqual(await registry.testSizeStats(), [4, 3, 4, 1]);
  await Promise.all(objects.slice(1, 4).map(shard => shard.testReleaseSize()));
  assert.equal((await pending).status, 500);
  assert.deepEqual(await registry.testSizeStats(), [4, 0, 4, 4]);
  assert.deepEqual(await storage.exec('SELECT status FROM files WHERE file_id = ?', started.body.uploadId), [{ status: 'uploading' }]);
  assert.deepEqual(await storage.exec('SELECT count(*) AS count FROM messages'), [{ count: 0 }]);
  assert.deepEqual(await storage.exec('SELECT count(*) AS count FROM finalize_updates'), [{ count: 0 }]);
  await objects[4].testReleaseSize();
  const retried = await complete(request, space, started.body.uploadId);
  assert.equal(retried.status, 201);
  assert.deepEqual(await registry.testSizeStats(), [9, 0, 4, 9]);
  assert.deepEqual(await storage.exec('SELECT count(*) AS count FROM finalize_updates'), [{ count: 5 }]);
  assert.equal((await complete(request, space, started.body.uploadId)).status, 200);
  assert.deepEqual(await registry.testSizeStats(), [9, 0, 4, 9]);
});

test('concurrent download and preview requests reuse persisted tickets per device without extending their lifetime', async () => {
  const request = client();
  const space = await createSpace(request);
  const sent = await upload(request, space, { name: 'note.txt' });
  const path = `/v1/spaces/${space.roomId}/files/${sent.body.id}/download`;
  const results = await Promise.all(Array.from({ length: 8 }, () => request(path, { method: 'POST', token: space.token })));
  for (const result of results) {
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, results[0].body);
  }
  const storage = await roomStorage(space);
  assert.deepEqual(await storage.exec('SELECT count(*) AS count FROM download_tickets'), [{ count: 1 }]);
  await runtime.unsafeEvictDurableObject('sync-files-test', 'SyncRoom', { name: space.roomId });
  assert.deepEqual((await request(path, { method: 'POST', token: space.token })).body, results[0].body);
  const paired = await client()('/v1/pair', { method: 'POST', json: { code: space.code } });
  const peer = await request(path, { method: 'POST', token: paired.body.token });
  assert.notEqual(peer.body.ticket, results[0].body.ticket);
  await storage.exec('UPDATE download_tickets SET expires_at = ? WHERE device_id = ?', Date.now() + 30000, space.deviceId);
  const renewed = await request(path, { method: 'POST', token: space.token });
  assert.notEqual(renewed.body.ticket, results[0].body.ticket);
  assert.ok(renewed.body.expiresAt > Date.now() + 60000);
});

test('upload initialization validates the 2 GiB boundary and reserves an idempotent upload without transferring it', async () => {
  const request = client();
  const space = await createSpace(request);
  const clientId = randomUUID();
  const maximumCipherSize = maximumFileSize + Math.ceil(maximumFileSize / (512 * 1024 - 16)) * 16;
  const started = await initiate(request, space, { clientId, size: maximumCipherSize, name: 'maximum.bin' });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  assert.equal(started.body.chunkSize, chunkSize);
  assert.equal(started.body.receivedBytes, 0);
  assert.match(started.body.uploadId, /^[0-9a-f-]{36}$/);
  const retry = await initiate(request, space, { clientId, size: maximumCipherSize, name: 'maximum.bin' });
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.body, started.body);
  const state = await request(`/v1/spaces/${space.roomId}`, { token: space.token });
  assert.deepEqual(state.body.messages, []);
  const tooLarge = await initiate(request, space, { size: maximumCipherSize + 1 });
  assert.equal(tooLarge.status, 413);
  for (const size of [-1, 1.5, '8', null]) {
    const invalid = await initiate(request, space, { size });
    assert.ok([400, 413].includes(invalid.status), JSON.stringify(size));
  }
  const cancelled = await request(`/v1/spaces/${space.roomId}/files/uploads/${started.body.uploadId}`, { method: 'DELETE', token: space.token });
  assert.equal(cancelled.status, 200);
});

test('upload metadata rejects invalid names, sizes, MIME types and text before creating an upload', async () => {
  const request = client();
  const space = await createSpace(request);
  const session = request.state.sessions.get(space.token);
  const clientId = randomUUID();
  const text = await cryptoClient.encryptPayload(session.keyring, space.roomId, `message:${space.deviceId}:${clientId}`, { text: '', attachment: { name: 'private.bin', type: 'application/octet-stream', size: 0 } });
  const validWire = { clientId, name: randomUUID(), type: 'application/octet-stream', size: 0, text, fingerprint: 'a'.repeat(64) };
  for (const fixture of [
    { clientId: '' }, { clientId: '1234' }, { clientId: '00000000-0000-1000-8000-000000000000' },
    { text: 'x'.repeat(10001) }, { text: null },
    { name: '' }, { name: 'x'.repeat(256) }, { name: 'folder/file.txt' }, { name: 'folder\\file.txt' },
    { name: 'bad\u0000file.txt' }, { name: 'bad\u0001file.txt' }, { name: 'bad\r\nfile.txt' },
    { type: 'application' }, { type: 'text/' }, { type: '/plain' }, { type: 'text/plain; charset=utf-8' },
    { type: `application/${'x'.repeat(244)}` }
  ]) {
    const result = await request.raw(`/v1/spaces/${space.roomId}/files/uploads`, {
      method: 'POST', token: space.token, headers: { 'X-Sync-Key-Id': session.keyring.currentKeyId }, json: { ...validWire, ...fixture }
    });
    assert.equal(result.status, 400, JSON.stringify(fixture));
  }
  const valid = await upload(request, space, {
    bytes: Buffer.alloc(0), name: `${'x'.repeat(251)}.bin`, type: `application/${'x'.repeat(243)}`, text: '中'.repeat(10000)
  });
  assert.equal(valid.status, 201, JSON.stringify(valid.body));
  const storage = await roomStorage(space);
  assert.deepEqual(await storage.exec('SELECT count(*) AS count FROM files'), [{ count: 1 }]);
});

test('chunk size checks, retries and concurrent completion preserve one file and one broadcast', async () => {
  const request = client();
  const space = await createSpace(request);
  const connected = await authenticateSocket(space);
  const frames = [];
  connected.socket.addEventListener('message', event => frames.push(event.data));
  const bytes = randomBytes(chunkSize + 17);
  const clientId = randomUUID();
  const started = await initiate(request, space, { clientId, size: bytes.length });
  assert.equal(started.status, 201);
  const uploadId = started.body.uploadId;
  assert.equal((await complete(request, space, uploadId)).status, 409);
  assert.equal((await putChunk(request, space, uploadId, 1, bytes.subarray(chunkSize))).status, 400);
  for (const [index, body] of [[0, bytes.subarray(0, chunkSize - 1)], [1, Buffer.alloc(18)], [2, Buffer.alloc(17)]]) {
    const invalid = await putChunk(request, space, uploadId, index, body);
    assert.ok(invalid.status >= 400 && invalid.status < 500, JSON.stringify(invalid));
  }
  const first = await putChunk(request, space, uploadId, 0, bytes.subarray(0, chunkSize));
  assert.equal(first.status, 200);
  assert.equal(first.body.receivedBytes, chunkSize);
  const room = await roomObject(space);
  const before = (await room.storageUsage()).bytes;
  const retried = await putChunk(request, space, uploadId, 0, bytes.subarray(0, chunkSize));
  assert.equal(retried.status, 200);
  assert.equal(retried.body.receivedBytes, chunkSize);
  assert.equal((await room.storageUsage()).bytes, before);
  const changed = Buffer.from(bytes.subarray(0, chunkSize));
  changed[0] ^= 1;
  assert.equal((await putChunk(request, space, uploadId, 0, changed)).status, 409);
  const resumed = await initiate(request, space, { clientId, size: bytes.length });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.uploadId, uploadId);
  assert.equal(resumed.body.receivedBytes, chunkSize);
  const last = await putChunk(request, space, uploadId, 1, bytes.subarray(chunkSize));
  assert.equal(last.status, 200);
  assert.equal(last.body.receivedBytes, bytes.length);
  const completed = await Promise.all([complete(request, space, uploadId), complete(request, space, uploadId)]);
  assert.deepEqual(completed.map(result => result.status).sort(), [200, 201]);
  assert.deepEqual(completed[0].body, completed[1].body);
  const alreadyDone = await initiate(request, space, { clientId, size: bytes.length });
  assert.equal(alreadyDone.status, 200);
  assert.deepEqual(alreadyDone.body.message, completed[0].body);
  const pong = socketEvent(connected.socket);
  connected.socket.send('ping');
  assert.equal((await pong).data, 'pong');
  const session = request.state.sessions.get(space.token);
  assert.deepEqual(await Promise.all(frames.filter(frame => frame !== 'pong').map(async frame => {
    const { history, ...event } = JSON.parse(frame);
    assert.equal(history.latestId, completed[0].body.id);
    event.message = { ...event.message, ...await cryptoClient.decryptPayload(session.keyring, space.roomId, `message:${event.message.deviceId}:${event.message.clientId}`, event.message.text) };
    return event;
  })), [
    { type: 'message', message: completed[0].body }
  ]);
  const state = await request(`/v1/spaces/${space.roomId}`, { token: space.token });
  assert.deepEqual(state.body.messages, [completed[0].body]);
  const downloaded = await request(`/v1/spaces/${space.roomId}/files/${completed[0].body.id}`, { token: space.token });
  assert.deepEqual(downloaded.body, bytes);
  connected.socket.close();
});

test('chunk streams reject bytes beyond 8 MiB even when Content-Length lies or is absent', async () => {
  const request = client();
  const space = await createSpace(request);
  const started = await initiate(request, space, { size: chunkSize });
  assert.equal(started.status, 201);
  // The Worker answers 413 and closes as soon as the body passes the limit, which can reset
  // the connection before the client finishes sending; retry only that transport failure.
  const putOversized = async (declared) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await putChunk(request, space, started.body.uploadId, 0, Buffer.alloc(chunkSize + 1), { 'X-Test-Content-Length': declared });
      } catch (error) {
        if (attempt === 3 || error.message !== 'fetch failed') throw error;
      }
    }
  };
  for (const declared of ['1', 'omit']) {
    const result = await putOversized(declared);
    assert.equal(result.status, 413, JSON.stringify(result.body));
  }
  const retry = await initiate(request, space, { clientId: randomUUID(), size: 0 });
  assert.equal(retry.status, 201);
  const storage = await roomStorage(space);
  assert.deepEqual(await storage.exec('SELECT count(*) AS count FROM file_upload_chunks'), [{ count: 0 }]);
  assert.equal((await request(`/v1/spaces/${space.roomId}/files/uploads/${started.body.uploadId}`, { method: 'DELETE', token: space.token })).status, 200);
  assert.equal((await request(`/v1/spaces/${space.roomId}/files/uploads/${retry.body.uploadId}`, { method: 'DELETE', token: space.token })).status, 200);
});

test('upload mutations belong to their device while completed downloads are shared only within the space', async () => {
  const request = client();
  const space = await createSpace(request);
  const stranger = await createSpace();
  const paired = await client()('/v1/pair', { method: 'POST', json: { code: space.code } });
  assert.equal(paired.status, 200);
  const peer = { ...space, ...paired.body };
  const bytes = randomBytes(1731);
  const started = await initiate(request, space, { size: bytes.length });
  assert.equal(started.status, 201);
  const uploadPath = `/v1/spaces/${space.roomId}/files/uploads/${started.body.uploadId}`;
  for (const token of [undefined, '', '0'.repeat(64), stranger.token]) {
    for (const [method, path, body, headers] of [
      ['PUT', `${uploadPath}/chunks/0`, bytes, { 'Content-Type': 'application/octet-stream' }],
      ['POST', `${uploadPath}/complete`, undefined, {}], ['DELETE', uploadPath, undefined, {}]
    ]) {
      const denied = await request(path, { method, token, body, headers });
      assert.equal(denied.status, 401);
    }
  }
  for (const action of [
    () => putChunk(request, peer, started.body.uploadId, 0, bytes),
    () => complete(request, peer, started.body.uploadId),
    () => request(uploadPath, { method: 'DELETE', token: peer.token })
  ]) {
    const denied = await action();
    assert.ok([403, 404].includes(denied.status), JSON.stringify(denied.body));
  }
  assert.equal((await putChunk(request, space, started.body.uploadId, 0, bytes)).status, 200);
  const sent = await complete(request, space, started.body.uploadId);
  assert.equal(sent.status, 201);
  const path = `/v1/spaces/${space.roomId}/files/${sent.body.id}`;
  assert.deepEqual((await request(path, { token: peer.token })).body, bytes);
  for (const token of [undefined, '0'.repeat(64), stranger.token]) assert.equal((await request(path, { token })).status, 401);
  assert.equal((await request(`/v1/spaces/${stranger.roomId}/files/${sent.body.id}`, { token: space.token })).status, 401);
  const revoked = await request(`/v1/spaces/${space.roomId}/devices/${peer.deviceId}`, { method: 'DELETE', token: space.token });
  assert.equal(revoked.status, 200);
  assert.equal((await request(path, { token: peer.token })).status, 401);
  assert.equal((await initiate(request, peer)).status, 401);
  assert.deepEqual((await request(path, { token: space.token })).body, bytes);
});

test('native download tickets allow resumable ranges for 24 hours and reject expiry, revocation and deletion', async () => {
  const request = client();
  const space = await createSpace(request);
  const paired = await client()('/v1/pair', { method: 'POST', json: { code: space.code } });
  assert.equal(paired.status, 200);
  const bytes = randomBytes(15731);
  const sent = await upload(request, space, { bytes, name: '中文下载.pdf', type: 'application/pdf' });
  assert.equal(sent.status, 201);
  const ticketPath = `/v1/spaces/${space.roomId}/files/${sent.body.id}/download`;
  assert.equal((await request(ticketPath, { method: 'POST' })).status, 401);
  const now = Date.now();
  const issued = await request(ticketPath, { method: 'POST', token: space.token });
  assert.equal(issued.status, 200);
  assert.match(issued.body.ticket, /^[0-9a-f]{64}$/);
  assert.ok(issued.body.expiresAt >= now + 24 * 60 * 60 * 1000 && issued.body.expiresAt <= Date.now() + 24 * 60 * 60 * 1000);
  const path = `/v1/spaces/${space.roomId}/downloads/${issued.body.ticket}`;
  const consumed = await Promise.all([request(path, { headers: { Origin: null } }), request(path, { headers: { Origin: null } })]);
  assert.deepEqual(consumed.map(result => result.status), [200, 200]);
  const downloaded = consumed[0];
  assert.deepEqual(downloaded.body, bytes);
  assert.equal(downloaded.headers.get('Content-Type'), 'application/octet-stream');
  assert.equal(downloaded.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.match(downloaded.headers.get('Content-Disposition'), /^attachment;/);
  const prefix = await request(path, { headers: { Origin: null, Range: 'bytes=0-7000' } });
  const suffix = await request(path, { headers: { Origin: null, Range: 'bytes=7001-' } });
  assert.equal(prefix.status, 206);
  assert.equal(suffix.status, 206);
  assert.deepEqual(Buffer.concat([prefix.body, suffix.body]), bytes);
  assert.equal(prefix.headers.get('Accept-Ranges'), 'bytes');
  assert.equal(prefix.headers.get('Content-Range'), `bytes 0-7000/${bytes.length}`);
  assert.equal(prefix.headers.get('Content-Length'), '7001');
  const etag = prefix.headers.get('ETag');
  const modified = prefix.headers.get('Last-Modified');
  assert.match(etag, /^"[0-9a-f-]{36}"$/);
  assert.ok(Number.isFinite(Date.parse(modified)));
  for (const validator of [etag, modified]) {
    const resumed = await request(path, { headers: { Range: 'bytes=17-31', 'If-Range': validator } });
    assert.equal(resumed.status, 206);
    assert.deepEqual(resumed.body, bytes.subarray(17, 32));
    assert.equal(resumed.headers.get('ETag'), etag);
    assert.equal(resumed.headers.get('Last-Modified'), modified);
  }
  for (const validator of ['"changed"', `W/${etag}`, new Date(Date.parse(modified) - 1000).toUTCString(), 'invalid']) {
    const changed = await request(path, { headers: { Range: 'bytes=17-31', 'If-Range': validator } });
    assert.equal(changed.status, 200);
    assert.equal(changed.headers.get('Content-Range'), null);
    assert.deepEqual(changed.body, bytes);
  }
  for (const [range, expectedStart, expectedEnd] of [
    ['bytes=-31', bytes.length - 31, bytes.length - 1],
    ['bytes=7-999999999999999999999', 7, bytes.length - 1],
    ['bytes=-999999999999999999999', 0, bytes.length - 1],
    ['bytes=4-4', 4, 4]
  ]) {
    const ranged = await request(path, { headers: { Range: range } });
    assert.equal(ranged.status, 206, range);
    assert.equal(ranged.headers.get('Content-Range'), `bytes ${expectedStart}-${expectedEnd}/${bytes.length}`);
    assert.deepEqual(ranged.body, bytes.subarray(expectedStart, expectedEnd + 1));
  }
  for (const range of ['bytes=15731-', 'bytes=9-2', 'bytes=-0', 'bytes=-', 'bytes=0-1,4-5', 'items=0-1', 'bytes=1.5-2']) {
    const invalid = await request(path, { headers: { Range: range } });
    assert.equal(invalid.status, 416, range);
    assert.equal(invalid.headers.get('Content-Range'), `bytes */${bytes.length}`);
    assert.equal(invalid.headers.get('Content-Length'), '0');
    assert.equal(invalid.body.length, 0);
  }
  for (const [headPath, token] of [[path, undefined], [`/v1/spaces/${space.roomId}/files/${sent.body.id}`, space.token]]) {
    const head = await request(headPath, { method: 'HEAD', token, headers: { Range: 'bytes=1-2' } });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('Content-Length'), String(bytes.length));
    assert.equal(head.headers.get('Content-Range'), null);
    assert.equal(head.body.length, 0);
  }
  const preflight = await request(path, { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'range' } });
  assert.match(preflight.headers.get('Access-Control-Allow-Headers'), /Range/);
  assert.match(preflight.headers.get('Access-Control-Allow-Headers'), /If-Range/);
  assert.match(prefix.headers.get('Access-Control-Expose-Headers'), /Content-Range/);
  assert.match(prefix.headers.get('Access-Control-Expose-Headers'), /ETag/);

  const expired = await request(ticketPath, { method: 'POST', token: space.token });
  const storage = await roomStorage(space);
  await storage.exec('UPDATE download_tickets SET expires_at = ?', Date.now() - 1);
  assert.equal((await request(`/v1/spaces/${space.roomId}/downloads/${expired.body.ticket}`)).status, 404);
  assert.equal((await request(`/v1/spaces/${space.roomId}/downloads/${expired.body.ticket}`, { method: 'HEAD' })).status, 404);
  const peerTicket = await request(ticketPath, { method: 'POST', token: paired.body.token });
  assert.equal(peerTicket.status, 200);
  assert.equal((await request(`/v1/spaces/${space.roomId}/devices/${paired.body.deviceId}`, { method: 'DELETE', token: space.token })).status, 200);
  assert.ok([401, 404].includes((await request(`/v1/spaces/${space.roomId}/downloads/${peerTicket.body.ticket}`)).status));
  const deletedTicket = await request(ticketPath, { method: 'POST', token: space.token });
  assert.equal((await request(`/v1/spaces/${space.roomId}/messages`, { method: 'DELETE', token: space.token })).status, 200);
  assert.equal((await request(`/v1/spaces/${space.roomId}/downloads/${deletedTicket.body.ticket}`)).status, 404);
});

test('resuming the end of a 2 GiB file reads only the requested shard and rejects an expired attachment', async t => {
  const instance = await createRuntime();
  t.after(() => instance.dispose());
  const request = client(instance);
  const space = await createSpace(request);
  const started = await initiate(request, space, { size: maximumFileSize });
  assert.equal(started.status, 201);
  const fileId = started.body.uploadId;
  const storage = await roomStorage(space, instance);
  const [{ client_id: clientId }] = await storage.exec('SELECT client_id FROM files WHERE file_id = ?', fileId);
  const attachment = JSON.stringify({ name: 'file.bin', type: 'application/octet-stream', size: maximumFileSize });
  const [{ id }] = await storage.exec('INSERT INTO messages (client_id, device_id, text, created_at, attachment) VALUES (?, ?, ?, ?, ?) RETURNING id', clientId, space.deviceId, '', Date.now(), attachment);
  await storage.exec("UPDATE files SET status = 'complete', message_id = ?, reserved_bytes = 0 WHERE file_id = ?", id, fileId);
  const shardNamespace = await instance.getDurableObjectNamespace('E2EE_FILE_SHARDS');
  const lastShard = shardNamespace.getByName(`${fileId}:31`);
  await lastShard.writePart(255, new Uint8Array([0]).buffer);
  const shardStorage = await instance.unsafeGetDurableObjectStorage('sync-files-test', 'FileShard', { name: `${fileId}:31` });
  const lastMiB = randomBytes(MiB);
  await shardStorage.exec('INSERT OR REPLACE INTO chunks (chunk_index, data) VALUES (?, ?)', 63, lastMiB);
  const issued = await request(`/v1/spaces/${space.roomId}/files/${id}/download`, { method: 'POST', token: space.token });
  const path = `/v1/spaces/${space.roomId}/downloads/${issued.body.ticket}`;
  const ranged = await request(path, { headers: { Range: 'bytes=-23' } });
  assert.equal(ranged.status, 206);
  assert.deepEqual(ranged.body, lastMiB.subarray(MiB - 23));
  assert.equal(ranged.headers.get('Content-Range'), `bytes ${maximumFileSize - 23}-${maximumFileSize - 1}/${maximumFileSize}`);
  assert.deepEqual(await lastShard.testReadRequests(), [{ offset: 64 * MiB - 23, length: 23 }]);
  assert.equal((await instance.listDurableObjectIds('E2EE_FILE_SHARDS')).length, 1);
  assert.equal((await request(path, { method: 'HEAD' })).headers.get('Content-Length'), String(maximumFileSize));
  assert.equal((await lastShard.testReadRequests()).length, 1);

  await storage.exec('UPDATE files SET created_at = ?', Date.now() - sevenDays - 1);
  for (const method of ['GET', 'HEAD']) {
    assert.equal((await request(path, { method, headers: { Range: 'bytes=-23' } })).status, 404);
  }
  assert.equal((await lastShard.testReadRequests()).length, 1);
});

test('encrypted ticket responses keep every private media type opaque while retaining range and credential checks', async () => {
  const request = client();
  const space = await createSpace(request);
  const bytes = Buffer.from('preview fixture bytes');
  for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'video/mp4', 'video/webm', 'video/ogg', 'application/pdf', 'text/html', 'image/svg+xml', 'application/octet-stream']) {
    const sent = await upload(request, space, { bytes, type });
    const issued = await request(`/v1/spaces/${space.roomId}/files/${sent.body.id}/download`, { method: 'POST', token: space.token });
    const path = `/v1/spaces/${space.roomId}/downloads/${issued.body.ticket}`;
    const preview = await request(`${path}?preview=1`, { headers: { Range: 'bytes=3-9' } });
    assert.equal(preview.status, 206, type);
    assert.deepEqual(preview.body, bytes.subarray(3, 10));
    assert.equal(preview.headers.get('Content-Range'), `bytes 3-9/${bytes.length}`);
    assert.equal(preview.headers.get('Content-Length'), '7');
    assert.equal(preview.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(preview.headers.get('Content-Type'), 'application/octet-stream');
    assert.ok(preview.headers.get('Content-Disposition').startsWith('attachment;'));
    const head = await request(`${path}?preview=1`, { method: 'HEAD' });
    assert.equal(head.headers.get('Content-Type'), preview.headers.get('Content-Type'));
    assert.equal(head.body.length, 0);
    const downloaded = await request(path);
    assert.equal(downloaded.headers.get('Content-Type'), 'application/octet-stream');
    assert.match(downloaded.headers.get('Content-Disposition'), /^attachment;/);
    const direct = await request(`/v1/spaces/${space.roomId}/files/${sent.body.id}?preview=1`, { token: space.token });
    assert.equal(direct.headers.get('Content-Type'), 'application/octet-stream');
  }
  const sent = await upload(request, space, { bytes, type: 'application/pdf' });
  const paired = await client()('/v1/pair', { method: 'POST', json: { code: space.code } });
  const issued = await request(`/v1/spaces/${space.roomId}/files/${sent.body.id}/download`, { method: 'POST', token: paired.body.token });
  const path = `/v1/spaces/${space.roomId}/downloads/${issued.body.ticket}?preview=1`;
  await request(`/v1/spaces/${space.roomId}/devices/${paired.body.deviceId}`, { method: 'DELETE', token: space.token });
  assert.equal((await request(path)).status, 404);
  assert.equal((await request(path, { method: 'HEAD' })).status, 404);
});

test('clearing history removes file manifests, upload rows and physical shard bytes from storage usage', async () => {
  const request = client();
  const space = await createSpace(request);
  const previous = await runtime.listDurableObjectIds('E2EE_FILE_SHARDS');
  const sent = await upload(request, space, { bytes: randomBytes(2 * MiB + 97) });
  assert.equal(sent.status, 201);
  const shardIds = (await runtime.listDurableObjectIds('E2EE_FILE_SHARDS')).filter(id => !previous.includes(id));
  const room = await roomObject(space);
  const before = await room.storageUsage();
  assert.ok(before.bytes > 2 * MiB);
  const cleared = await request(`/v1/spaces/${space.roomId}/messages`, { method: 'DELETE', token: space.token });
  assert.equal(cleared.status, 200);
  await drainDeletedFiles(space);
  const storage = await roomStorage(space);
  for (const table of ['messages', 'files', 'file_shards', 'file_upload_chunks', 'download_tickets']) {
    assert.deepEqual(await storage.exec(`SELECT count(*) AS count FROM ${table}`), [{ count: 0 }], table);
  }
  assert.deepEqual(await shardRows(shardIds), []);
  const after = await room.storageUsage();
  assert.ok(before.bytes - after.bytes >= 2 * MiB, `${before.bytes} -> ${after.bytes}`);
  assert.equal((await request(`/v1/spaces/${space.roomId}/files/${sent.body.id}`, { token: space.token })).status, 404);
});

test('expired messages delete their shards while live attachments remain downloadable', async () => {
  const request = client();
  const space = await createSpace(request);
  const previous = await runtime.listDurableObjectIds('E2EE_FILE_SHARDS');
  const expired = await upload(request, space, { bytes: randomBytes(MiB + 9), name: 'expired.bin' });
  assert.equal(expired.status, 201);
  const expiredShards = (await runtime.listDurableObjectIds('E2EE_FILE_SHARDS')).filter(id => !previous.includes(id));
  const survivorBytes = Buffer.from('keep this attachment');
  const survivor = await upload(request, space, { bytes: survivorBytes, name: 'surviving.txt', type: 'text/plain' });
  assert.equal(survivor.status, 201);
  const storage = await roomStorage(space);
  await storage.exec('UPDATE messages SET created_at = ? WHERE id = ?', Date.now() - sevenDays - 1000, expired.body.id);
  const room = await roomObject(space);
  await room.testRunAlarm();
  await drainDeletedFiles(space);
  assert.deepEqual(await shardRows(expiredShards), []);
  const state = await request(`/v1/spaces/${space.roomId}`, { token: space.token });
  assert.deepEqual(state.body.messages, [survivor.body]);
  assert.equal((await request(`/v1/spaces/${space.roomId}/files/${expired.body.id}`, { token: space.token })).status, 404);
  assert.deepEqual((await request(`/v1/spaces/${space.roomId}/files/${survivor.body.id}`, { token: space.token })).body, survivorBytes);
});

test('the 500-message limit marks an evicted attachment for bounded shard cleanup', async () => {
  const request = client();
  const space = await createSpace(request);
  const previous = await runtime.listDurableObjectIds('E2EE_FILE_SHARDS');
  const expired = await upload(request, space, { bytes: randomBytes(MiB + 31) });
  assert.equal(expired.status, 201);
  const expiredShards = (await runtime.listDurableObjectIds('E2EE_FILE_SHARDS')).filter(id => !previous.includes(id));
  const storage = await roomStorage(space);
  const timestamp = Date.now();
  for (let index = 0; index < 499; index += 1) {
    await storage.exec('INSERT INTO messages (client_id, device_id, text, created_at) VALUES (?, ?, ?, ?)',
      randomUUID(), space.deviceId, `retained text ${index}`, timestamp);
  }
  const survivingBytes = Buffer.from('latest attachment');
  const latest = await upload(request, space, { bytes: survivingBytes });
  assert.equal(latest.status, 201);
  await drainDeletedFiles(space);
  assert.deepEqual(await storage.exec('SELECT count(*) AS count FROM messages'), [{ count: 500 }]);
  assert.deepEqual(await storage.exec('SELECT id FROM messages WHERE id = ?', expired.body.id), []);
  assert.deepEqual(await shardRows(expiredShards), []);
  assert.equal((await request(`/v1/spaces/${space.roomId}/files/${expired.body.id}`, { token: space.token })).status, 404);
  assert.deepEqual((await request(`/v1/spaces/${space.roomId}/files/${latest.body.id}`, { token: space.token })).body, survivingBytes);
});

test('cancelling and expiring unfinished uploads release uploaded shards and their reservations', async () => {
  const request = client();
  const space = await createSpace(request);
  const room = await roomObject(space);
  const baseline = await room.storageUsage();
  const storage = await roomStorage(space);
  for (const abandon of ['cancel', 'expire']) {
    const previous = await runtime.listDurableObjectIds('E2EE_FILE_SHARDS');
    const started = await initiate(request, space, { size: chunkSize + 1 });
    assert.equal(started.status, 201);
    assert.equal((await putChunk(request, space, started.body.uploadId, 0, randomBytes(chunkSize))).status, 200);
    const shardIds = (await runtime.listDurableObjectIds('E2EE_FILE_SHARDS')).filter(id => !previous.includes(id));
    assert.ok((await room.storageUsage()).bytes > baseline.bytes + chunkSize);
    if (abandon === 'cancel') {
      const cancelled = await request(`/v1/spaces/${space.roomId}/files/uploads/${started.body.uploadId}`, { method: 'DELETE', token: space.token });
      assert.equal(cancelled.status, 200);
    } else {
      await storage.exec('UPDATE files SET updated_at = ? WHERE file_id = ?', Date.now() - 24 * 60 * 60 * 1000 - 1000, started.body.uploadId);
      await room.testRunAlarm();
    }
    await drainDeletedFiles(space);
    assert.deepEqual(await storage.exec('SELECT file_id FROM files WHERE file_id = ?', started.body.uploadId), []);
    assert.deepEqual(await storage.exec('SELECT count(*) AS count FROM file_upload_chunks'), [{ count: 0 }]);
    assert.deepEqual(await shardRows(shardIds), []);
    assert.ok((await room.storageUsage()).bytes < baseline.bytes + 128 * 1024);
    assert.ok([404, 409].includes((await complete(request, space, started.body.uploadId)).status));
  }
});

test('clearing from a peer invalidates an unfinished upload before the original device can complete it', async () => {
  const request = client();
  const space = await createSpace(request);
  const paired = await client()('/v1/pair', { method: 'POST', json: { code: space.code } });
  assert.equal(paired.status, 200);
  const started = await initiate(request, space, { size: chunkSize + 1 });
  assert.equal(started.status, 201);
  assert.equal((await putChunk(request, space, started.body.uploadId, 0, randomBytes(chunkSize))).status, 200);
  const cleared = await request(`/v1/spaces/${space.roomId}/messages`, { method: 'DELETE', token: paired.body.token });
  assert.equal(cleared.status, 200);
  assert.equal((await complete(request, space, started.body.uploadId)).status, 404);
  assert.equal((await putChunk(request, space, started.body.uploadId, 1, Buffer.alloc(1))).status, 404);
  await drainDeletedFiles(space);
  const state = await request(`/v1/spaces/${space.roomId}`, { token: space.token });
  assert.deepEqual(state.body.messages, []);
  const storage = await roomStorage(space);
  assert.deepEqual(await storage.exec('SELECT count(*) AS count FROM files'), [{ count: 0 }]);
});

test('file tables initialize around encrypted messages without changing their shape or device credentials', async t => {
  const instance = await createRuntime();
  t.after(() => instance.dispose());
  const request = client(instance);
  const space = await createSpace(request);
  const sent = await request(`/v1/spaces/${space.roomId}/messages`, {
    method: 'POST', token: space.token, json: { clientId: randomUUID(), text: 'encrypted message before file tables' }
  });
  assert.equal(sent.status, 201);
  const storage = await roomStorage(space, instance);
  const triggers = await storage.exec("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'messages'");
  for (const trigger of triggers) await storage.exec(`DROP TRIGGER "${trigger.name}"`);
  for (const table of ['download_tickets', 'file_upload_chunks', 'file_shards', 'files']) await storage.exec(`DROP TABLE ${table}`);
  await instance.unsafeEvictDurableObject('sync-files-test', 'SyncRoom', { name: space.roomId });
  const state = await request(`/v1/spaces/${space.roomId}`, { token: space.token });
  assert.equal(state.status, 200);
  assert.deepEqual(state.body.messages, [sent.body]);
  const attachment = await upload(request, space, { bytes: Buffer.from('after upgrade') });
  assert.equal(attachment.status, 201);
  await instance.unsafeEvictDurableObject('sync-files-test', 'SyncRoom', { name: space.roomId });
  const reopened = await request(`/v1/spaces/${space.roomId}`, { token: space.token });
  assert.deepEqual(reopened.body.messages, [sent.body, attachment.body]);
  assert.deepEqual((await request(`/v1/spaces/${space.roomId}/files/${attachment.body.id}`, { token: space.token })).body, Buffer.from('after upgrade'));
});

test('global pressure rejects new reservations, prunes old file shards and allows a bounded retry', async t => {
  const instance = await createRuntime({ virtualMessageBytes: 1_000_000_000 });
  t.after(() => instance.dispose());
  const request = client(instance);
  const spaces = [await createSpace(request), await createSpace(request)];
  const files = [];
  for (let index = 0; index < 5; index += 1) {
    const space = spaces[index % 2];
    const previous = await instance.listDurableObjectIds('E2EE_FILE_SHARDS');
    const sent = await upload(request, space, { bytes: randomBytes(1000 + index), name: `old-${index}.bin` });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    const shardIds = (await instance.listDurableObjectIds('E2EE_FILE_SHARDS')).filter(id => !previous.includes(id));
    files.push({ space, message: sent.body, shardIds });
  }
  const storage = await Promise.all(spaces.map(space => roomStorage(space, instance)));
  for (let index = 0; index < files.length; index += 1) {
    await storage[index % 2].exec('UPDATE messages SET created_at = ? WHERE id = ?', Date.now() - 60000 + index * 1000, files[index].message.id);
  }
  const registryNamespace = await instance.getDurableObjectNamespace('E2EE_PAIRING_REGISTRY');
  const registry = registryNamespace.getByName('registry');
  for (const space of spaces) await registry.refreshRoom(space.roomId);
  const before = await registry.storageBytes();
  assert.ok(before >= 4_800_000_000);
  const blocked = await initiate(request, spaces[0], { size: 1024 });
  assert.equal(blocked.status, 503);
  assert.equal(blocked.body.error, 'storage_cleaning');
  const registryStorage = await instance.unsafeGetDurableObjectStorage('sync-files-test', 'PairingRegistry', { name: 'registry' });
  let turns = 0;
  while ((await registryStorage.exec('SELECT 1 FROM cleanup')).length) {
    assert.ok(turns++ < 20, 'global cleanup must make bounded progress');
    await registry.testRunAlarm();
  }
  for (const space of spaces) await drainDeletedFiles(space, instance);
  let removed = 0;
  for (const file of files) {
    const downloaded = await request(`/v1/spaces/${file.space.roomId}/files/${file.message.id}`, { token: file.space.token });
    if (downloaded.status === 404) {
      removed += 1;
      assert.deepEqual(await shardRows(file.shardIds, instance), []);
    } else assert.equal(downloaded.status, 200);
  }
  assert.ok(removed >= 3);
  assert.ok(before - await registry.storageBytes() >= 3_000_000_000);
  const retry = await upload(request, spaces[0], { bytes: Buffer.from('allowed after cleanup') });
  assert.equal(retry.status, 201, JSON.stringify(retry.body));
});

for (const { separateRoom, unknownUsage, clearedHistory } of [
  { separateRoom: false, unknownUsage: false, clearedHistory: true },
  { separateRoom: true, unknownUsage: false, clearedHistory: true },
  { separateRoom: true, unknownUsage: true, clearedHistory: true },
  { separateRoom: false, unknownUsage: false, clearedHistory: false }
]) {
  test(`capacity cleanup drains ${clearedHistory ? 'already deleted' : 'oldest live'} files before pruning ${separateRoom ? 'another room' : 'new messages in the same room'}${unknownUsage ? ' with unrefreshed room usage' : ''}`, async t => {
    const instance = await createRuntime();
    t.after(() => instance.dispose());
    const request = client(instance);
    const deletedSpace = await createSpace(request);
    const survivorSpace = separateRoom ? await createSpace(request) : deletedSpace;
    const deletedStorage = await roomStorage(deletedSpace, instance);
    const timestamp = Date.now() - 10000;
    // Keep the production deletion batches without writing 4 GiB of test data.
    for (let index = 0; index < 2; index += 1) {
      const fileId = randomUUID();
      const clientId = randomUUID();
      const attachment = JSON.stringify({ name: 'cleared.bin', type: 'application/octet-stream', size: maximumFileSize });
      const [{ id }] = await deletedStorage.exec('INSERT INTO messages (client_id, device_id, text, created_at, attachment) VALUES (?, ?, ?, ?, ?) RETURNING id', clientId, deletedSpace.deviceId, '', timestamp + index, attachment);
      await deletedStorage.exec('INSERT INTO files (file_id, device_id, client_id, name, type, size, text, status, created_at, updated_at, message_id, reserved_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        fileId, deletedSpace.deviceId, clientId, 'cleared.bin', 'application/octet-stream', maximumFileSize, '', 'complete', timestamp + index, timestamp + index, id, 0);
      for (let shard = 0; shard < 32; shard += 1) {
        await deletedStorage.exec('INSERT INTO file_shards (file_id, shard_index, bytes) VALUES (?, ?, ?)', fileId, shard, 64 * MiB);
      }
    }
    await (await roomObject(deletedSpace, instance)).testRebuildAccounting();
    if (clearedHistory) {
      const cleared = await request(`/v1/spaces/${deletedSpace.roomId}/messages`, { method: 'DELETE', token: deletedSpace.token });
      assert.equal(cleared.status, 200);
    }
    const survivor = await request(`/v1/spaces/${survivorSpace.roomId}/messages`, {
      method: 'POST', token: survivorSpace.token, json: { clientId: randomUUID(), text: 'keep this history' }
    });
    assert.equal(survivor.status, 201);
    const survivorStorage = await roomStorage(survivorSpace, instance);
    const retainedCiphertext = await survivorStorage.exec('SELECT text FROM messages WHERE id = ?', survivor.body.id);
    assert.match(retainedCiphertext[0].text, /^e2ee1\./);
    if (separateRoom) {
      await survivorStorage.exec('UPDATE messages SET created_at = ? WHERE id = ?', timestamp - 10000, survivor.body.id);
    }
    const registryNamespace = await instance.getDurableObjectNamespace('E2EE_PAIRING_REGISTRY');
    const registry = registryNamespace.getByName('registry');
    if (separateRoom) await registry.refreshRoom(survivorSpace.roomId);
    const blocked = await initiate(request, survivorSpace, { size: maximumFileSize });
    assert.equal(blocked.status, 503);
    assert.equal(blocked.body.error, 'storage_cleaning');
    const registryStorage = await instance.unsafeGetDurableObjectStorage('sync-files-test', 'PairingRegistry', { name: 'registry' });
    await registry.testRunAlarm();
    const [state] = await registryStorage.exec('SELECT phase, target_bytes FROM cleanup');
    assert.equal(state.phase, 'prune');
    const before = await registry.storageBytes();
    assert.equal(state.target_bytes, before - 3_000_000_000);
    assert.ok((await deletedStorage.exec('SELECT sum(bytes) AS bytes FROM file_shards'))[0].bytes >= 3_000_000_000);
    if (unknownUsage) await registryStorage.exec('UPDATE room_usage SET deleting_files = NULL');
    let turns = 0;
    while ((await registryStorage.exec('SELECT 1 FROM cleanup')).length) {
      assert.ok(turns++ < 5, 'pending file deletion must make bounded progress');
      await registry.testRunAlarm();
      assert.deepEqual(await survivorStorage.exec('SELECT text FROM messages WHERE id = ?', survivor.body.id), retainedCiphertext);
      for (const pending of await registryStorage.exec('SELECT phase, target_bytes FROM cleanup')) assert.deepEqual(pending, state);
    }
    assert.ok(before - await registry.storageBytes() >= 3_000_000_000);
    const retried = await initiate(request, survivorSpace, { size: maximumFileSize });
    assert.equal(retried.status, 201, JSON.stringify(retried.body));
  });
}

test('capacity cleanup preserves a newer active upload when older completed files reclaim enough space', async t => {
  const instance = await createRuntime();
  t.after(() => instance.dispose());
  const request = client(instance);
  const space = await createSpace(request);
  const storage = await roomStorage(space, instance);
  const timestamp = Date.now() - 10000;
  // Exercise bounded deletion of 3 GiB using accounting rows, without allocating those file bytes.
  for (let index = 0; index < 2; index += 1) {
    const fileId = randomUUID();
    const clientId = randomUUID();
    const size = 1536 * MiB;
    const attachment = JSON.stringify({ name: 'old.bin', type: 'application/octet-stream', size });
    const [{ id }] = await storage.exec('INSERT INTO messages (client_id, device_id, text, created_at, attachment) VALUES (?, ?, ?, ?, ?) RETURNING id', clientId, space.deviceId, '', timestamp + index, attachment);
    await storage.exec('INSERT INTO files (file_id, device_id, client_id, name, type, size, text, status, created_at, updated_at, message_id, reserved_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      fileId, space.deviceId, clientId, 'old.bin', 'application/octet-stream', size, '', 'complete', timestamp + index, timestamp + index, id, 0);
    for (let shard = 0; shard < 24; shard += 1) await storage.exec('INSERT INTO file_shards (file_id, shard_index, bytes) VALUES (?, ?, ?)', fileId, shard, 64 * MiB);
  }
  await (await roomObject(space, instance)).testRebuildAccounting();
  const freshClientId = randomUUID();
  const fresh = await initiate(request, space, { clientId: freshClientId, size: 1024 * MiB });
  assert.equal(fresh.status, 201);
  const [beforeFresh] = await storage.exec('SELECT status, reserved_bytes FROM files WHERE file_id = ?', fresh.body.uploadId);
  const blocked = await initiate(request, space, { size: maximumFileSize });
  assert.equal(blocked.status, 503);
  const registryStorage = await instance.unsafeGetDurableObjectStorage('sync-files-test', 'PairingRegistry', { name: 'registry' });
  const registryNamespace = await instance.getDurableObjectNamespace('E2EE_PAIRING_REGISTRY');
  const registry = registryNamespace.getByName('registry');
  await registry.testRunAlarm();
  const before = await registry.storageBytes();
  const [{ target_bytes: target }] = await registryStorage.exec('SELECT target_bytes FROM cleanup');
  assert.equal(before - target, 3_000_000_000);
  for (let turn = 0; (await registryStorage.exec('SELECT 1 FROM cleanup')).length; turn += 1) {
    assert.ok(turn < 5);
    await registry.testRunAlarm();
    assert.deepEqual(await storage.exec('SELECT status, reserved_bytes FROM files WHERE file_id = ?', fresh.body.uploadId), [beforeFresh]);
  }
  assert.ok(await registry.storageBytes() <= target);
  const resumed = await initiate(request, space, { clientId: freshClientId, size: 1024 * MiB });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.uploadId, fresh.body.uploadId);
  assert.equal((await complete(request, space, fresh.body.uploadId)).body.error, 'upload_incomplete');
});

test('capacity pruning protects an older active upload while reclaiming completed history', async () => {
  const request = client();
  const space = await createSpace(request);
  const started = await initiate(request, space, { size: MiB });
  const storage = await roomStorage(space);
  await storage.exec('UPDATE files SET created_at = ?', Date.now() - 10000);
  const sent = await request(`/v1/spaces/${space.roomId}/messages`, { method: 'POST', token: space.token, json: { clientId: randomUUID(), text: 'newer history survives' } });
  const ciphertext = await storage.exec('SELECT text FROM messages');
  assert.match(ciphertext[0].text, /^e2ee1\./);
  const room = await roomObject(space);
  await room.pruneOldest();
  assert.deepEqual(await storage.exec('SELECT text FROM messages'), []);
  assert.equal(sent.body.text, 'newer history survives');
  assert.deepEqual(await storage.exec('SELECT file_id FROM files WHERE file_id = ?', started.body.uploadId), [{ file_id: started.body.uploadId }]);
  assert.equal((await putChunk(request, space, started.body.uploadId, 0, Buffer.alloc(MiB))).status, 200);
  assert.equal((await complete(request, space, started.body.uploadId)).status, 201);
});

test('capacity pressure rejects a new upload instead of reclaiming live uploads and still expires abandoned uploads', async t => {
  const instance = await createRuntime();
  t.after(() => instance.dispose());
  const request = client(instance);
  const first = await createSpace(request), second = await createSpace(request), third = await createSpace(request);
  const active = await initiate(request, first, { size: maximumFileSize });
  assert.equal(active.status, 201);
  assert.equal((await putChunk(request, first, active.body.uploadId, 0, Buffer.alloc(chunkSize))).status, 200);
  const other = await initiate(request, second, { size: maximumFileSize });
  assert.equal(other.status, 201);
  const blocked = await initiate(request, third, { size: 1024 * MiB });
  assert.equal(blocked.status, 507);
  assert.equal(blocked.body.error, 'storage_full');
  const namespace = await instance.getDurableObjectNamespace('E2EE_PAIRING_REGISTRY');
  const registry = namespace.getByName('registry');
  await registry.maintainRooms();
  await registry.testRunAlarm();
  const storage = await roomStorage(first, instance);
  assert.deepEqual(await storage.exec('SELECT status, received_bytes FROM files WHERE file_id = ?', active.body.uploadId), [{ status: 'uploading', received_bytes: chunkSize }]);
  assert.equal((await putChunk(request, first, active.body.uploadId, 1, Buffer.alloc(chunkSize))).status, 200);
  const abandonedStorage = await roomStorage(second, instance);
  await abandonedStorage.exec('UPDATE files SET updated_at = ? WHERE file_id = ?', Date.now() - 24 * 60 * 60 * 1000 - 1000, other.body.uploadId);
  await registry.refreshRoom(second.roomId);
  assert.deepEqual(await abandonedStorage.exec('SELECT file_id FROM files'), []);
  assert.equal((await initiate(request, third, { size: 1024 * MiB })).status, 201);
});

test('persisted upload progress migrates lazily and remains exact across retries and restart', async () => {
  const request = client(), space = await createSpace(request), clientId = randomUUID();
  const bytes = Buffer.alloc(chunkSize + 17, 83);
  const started = await initiate(request, space, { clientId, size: bytes.length }), uploadId = started.body.uploadId;
  assert.equal((await putChunk(request, space, uploadId, 0, bytes.subarray(0, chunkSize))).status, 200);
  const storage = await roomStorage(space);
  assert.deepEqual(await storage.exec('SELECT received_bytes, received_chunks FROM files WHERE file_id = ?', uploadId), [{ received_bytes: chunkSize, received_chunks: 1 }]);
  await storage.exec('UPDATE files SET received_bytes = NULL, received_chunks = NULL WHERE file_id = ?', uploadId);
  const resumed = await initiate(request, space, { clientId, size: bytes.length }); assert.equal(resumed.body.receivedBytes, chunkSize);
  assert.deepEqual(await storage.exec('SELECT received_bytes, received_chunks FROM files WHERE file_id = ?', uploadId), [{ received_bytes: chunkSize, received_chunks: 1 }]);
  for (const result of await Promise.all([putChunk(request, space, uploadId, 0, bytes.subarray(0, chunkSize)), putChunk(request, space, uploadId, 0, bytes.subarray(0, chunkSize))])) { assert.equal(result.status, 200); assert.equal(result.body.receivedBytes, chunkSize); }
  await runtime.unsafeEvictDurableObject('sync-files-test', 'SyncRoom', { name: space.roomId });
  const last = await putChunk(request, space, uploadId, 1, bytes.subarray(chunkSize)); assert.equal(last.status, 200); assert.equal(last.body.receivedBytes, bytes.length);
  assert.deepEqual(await storage.exec('SELECT received_bytes, received_chunks FROM files WHERE file_id = ?', uploadId), [{ received_bytes: bytes.length, received_chunks: 2 }]);
  assert.equal((await complete(request, space, uploadId)).status, 201);
});

test('a shard RPC download failure exposes only a generic stream error', async t => {
  const observedLogs = [], instance = await createRuntime({ observedLogs }); t.after(() => instance.dispose());
  const request = client(instance), space = await createSpace(request);
  const sent = await upload(request, space, { bytes: Buffer.from('private file bytes') });
  const storage = await roomStorage(space, instance);
  const [{ file_id: fileId }] = await storage.exec('SELECT file_id FROM files WHERE message_id = ?', sent.body.id);
  const namespace = await instance.getDurableObjectNamespace('E2EE_FILE_SHARDS');
  await namespace.getByName(`${fileId}:0`).testFailRead();
  await assert.rejects(async () => {
    const response = await instance.dispatchFetch(`https://sync.test/v1/spaces/${space.roomId}/files/${sent.body.id}`, { headers: { Origin: origin, Authorization: `Bearer ${space.token}` } });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }, error => !String(error).includes('private-rpc-sentinel-ticket-and-secret'));
  assert.equal(observedLogs.some(message => message.includes('private-rpc-sentinel-ticket-and-secret')), false);
});

test('upload resume compares persisted content identity and metadata before accepting an existing client ID', async () => {
  const request = client(), space = await createSpace(request);
  const metadata = { clientId: randomUUID(), name: randomUUID(), type: 'application/octet-stream', size: 4, fingerprint: 'a'.repeat(64) };
  const started = await initiate(request, space, metadata);
  assert.equal(started.status, 201);
  const storage = await roomStorage(space);
  assert.equal((await storage.exec('SELECT fingerprint FROM files WHERE file_id = ?', started.body.uploadId))[0].fingerprint, metadata.fingerprint);
  for (const change of [{ fingerprint: 'b'.repeat(64) }, { name: randomUUID() }, { size: 5 }]) {
    const mismatched = await initiate(request, space, { ...metadata, ...change });
    assert.equal(mismatched.status, 409); assert.equal(mismatched.body.error, 'upload_conflict');
  }
  const resumed = await initiate(request, space, metadata);
  assert.equal(resumed.status, 200); assert.equal(resumed.body.uploadId, started.body.uploadId);
  assert.equal((await putChunk(request, space, started.body.uploadId, 0, Buffer.from('file'))).status, 200);
  assert.equal((await complete(request, space, started.body.uploadId)).status, 201);
  assert.equal((await initiate(request, space, metadata)).body.message.attachment.name, metadata.name);
  assert.equal((await initiate(request, space, { ...metadata, fingerprint: 'b'.repeat(64) })).status, 409);
  const legacyId = randomUUID();
  assert.equal((await initiate(request, space, { clientId: legacyId, size: 4, fingerprint: 'c'.repeat(64) })).status, 201);
  assert.equal((await initiate(request, space, { clientId: legacyId, size: 4, fingerprint: 'a'.repeat(64) })).status, 409);
  const session = request.state.sessions.get(space.token);
  const text = await cryptoClient.encryptPayload(session.keyring, space.roomId, `message:${space.deviceId}:${randomUUID()}`, { text: '' });
  for (const change of [{ type: 'image/png' }, { fingerprint: undefined }]) {
    const invalid = await request.raw(`/v1/spaces/${space.roomId}/files/uploads`, { method: 'POST', token: space.token,
      headers: { 'X-Sync-Key-Id': session.keyring.currentKeyId }, json: { ...metadata, text, ...change } });
    assert.equal(invalid.status, 400);
  }
  for (const fingerprint of ['', 'a'.repeat(63), 'A'.repeat(64), 123]) {
    const invalid = await initiate(request, space, { fingerprint });
    assert.equal(invalid.status, 400); assert.equal(invalid.body.error, 'invalid_fingerprint');
  }
});

test('public diagnostics rotates existing shard samples without creating missing shard tables', async t => {
  const instance = await createRuntime(); t.after(() => instance.dispose());
  const request = client(instance), space = await createSpace(request);
  await upload(request, space, { bytes: Buffer.from('one') });
  await upload(request, space, { bytes: Buffer.from('two') });
  const storage = await roomStorage(space, instance);
  const files = await storage.exec('SELECT file_id FROM files ORDER BY file_id');
  const registry = (await instance.getDurableObjectNamespace('E2EE_PAIRING_REGISTRY')).getByName('registry');
  const namespace = await instance.getDurableObjectNamespace('E2EE_FILE_SHARDS');
  const shards = files.map(file => namespace.getByName(`${file.file_id}:0`));
  for (let i = 0; i < 2; i += 1) {
    await registry.testExpireDiagnosticsCache();
    const status = await request('/v1/status');
    assert.equal(status.body.database.sampledShard.ok, true);
    assert.equal(status.body.database.sampledShard.initialized, true);
  }
  assert.deepEqual(await Promise.all(shards.map(shard => shard.testProbeCount())), [1, 1]);
  await storage.exec('INSERT INTO file_shards (file_id, shard_index, bytes) VALUES (?, 9, 1)', files[0].file_id);
  const missing = await instance.unsafeGetDurableObjectStorage('sync-files-test', 'FileShard', { name: `${files[0].file_id}:9` });
  const schema = "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('chunks', 'parts')";
  assert.deepEqual(await missing.exec(schema), []);
  let missingStatus;
  for (let i = 0; i < 3; i += 1) {
    await registry.testExpireDiagnosticsCache();
    const status = await request('/v1/status');
    if (!status.body.database.sampledShard.ok) missingStatus = status.body;
  }
  assert.ok(missingStatus); assert.equal(missingStatus.ok, false);
  assert.equal(missingStatus.database.sampledShard.initialized, false);
  assert.deepEqual(await missing.exec(schema), []);
  assert.deepEqual(await storage.exec('SELECT file_id FROM files ORDER BY file_id'), files);
});

test('a stalled shard health probe preserves the healthy room result and recovers without a cached failure', async t => {
  const instance = await createRuntime(); t.after(() => instance.dispose());
  const request = client(instance), space = await createSpace(request);
  await upload(request, space, { bytes: Buffer.from('probe fixture') });
  const storage = await roomStorage(space, instance);
  const [{ file_id: fileId }] = await storage.exec('SELECT file_id FROM files');
  const shard = (await instance.getDurableObjectNamespace('E2EE_FILE_SHARDS')).getByName(`${fileId}:0`);
  await shard.testHoldDatabaseProbe();
  const started = Date.now();
  const partial = await request('/v1/status');
  assert.ok(Date.now() - started < 6000);
  assert.equal(partial.status, 200);
  assert.equal(partial.body.ok, false);
  assert.equal(partial.body.database.sampledRoom.ok, true);
  assert.equal(partial.body.database.sampledShard.ok, false);
  assert.equal(partial.body.storage.roomCount, 1);
  await shard.testReleaseDatabaseProbe();
  const recovered = await request('/v1/status');
  assert.equal(recovered.body.ok, true);
  assert.equal(recovered.body.database.sampledShard.ok, true);
});

test('download row reads stay bounded across thousands of streamed network chunks', async t => {
  const instance = await createRuntime(); t.after(() => instance.dispose());
  const request = client(instance), space = await createSpace(request);
  const bytes = randomBytes(chunkSize);
  const sent = await upload(request, space, { bytes });
  const room = await roomObject(space, instance);
  await room.testBeginReads();
  const response = await instance.dispatchFetch(`https://sync.test/v1/spaces/${space.roomId}/files/${sent.body.id}`, {
    headers: { Origin: origin, Authorization: `Bearer ${space.token}` }
  });
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.ok(await room.testReadCount() < 20, 'download access checks must not query on every transport chunk');
});

for (const mutation of ['remove-device', 'clear-history', 'prune-history', 'remove-other-device']) {
  test(`a pending shard read honors ${mutation} before releasing bytes`, async t => {
    const instance = await createRuntime(); t.after(() => instance.dispose());
    const request = client(instance), space = await createSpace(request);
    const room = await roomObject(space, instance);
    const peer = await room.addDevice();
    const bytes = randomBytes(32768);
    const sent = await upload(request, space, { bytes });
    const storage = await roomStorage(space, instance);
    const [{ file_id: fileId }] = await storage.exec('SELECT file_id FROM files WHERE message_id = ?', sent.body.id);
    const shard = (await instance.getDurableObjectNamespace('E2EE_FILE_SHARDS')).getByName(`${fileId}:0`);
    await shard.testHoldRead();
    const response = await instance.dispatchFetch(`https://sync.test/v1/spaces/${space.roomId}/files/${sent.body.id}`, {
      headers: { Origin: origin, Authorization: `Bearer ${space.token}` }
    });
    const reading = response.arrayBuffer();
    const result = reading.then(value => ({ value }), error => ({ error }));
    while (!(await shard.testReadRequests()).length) await new Promise(resolve => setTimeout(resolve, 0));
    if (mutation === 'remove-device') await room.removeDevice(space.deviceId);
    else if (mutation === 'remove-other-device') await room.removeDevice(peer.deviceId, space.deviceId);
    else if (mutation === 'clear-history') await room.clearMessages(space.deviceId);
    else {
      // Deletion is synchronous; shard cleanup awaits a separate RPC and need not finish for access to end.
      await room.pruneOldest();
    }
    await shard.testReleaseRead();
    const outcome = await result;
    if (mutation === 'remove-other-device') assert.deepEqual(Buffer.from(outcome.value), bytes);
    else assert.ok(outcome.error, 'revocation/deletion must reject the in-flight bytes');
  });
}

for (const mutation of ['remove-device', 'rotate-key']) {
  test(`an upload rechecks ${mutation} after waiting for the request body`, async t => {
    const instance = await createRuntime(); t.after(() => instance.dispose());
    const request = client(instance), space = await createSpace(request);
    const started = await initiate(request, space, { size: 2 });
    const room = await roomObject(space, instance);
    const keyId = request.state.sessions.get(space.token).keyring.currentKeyId;
    await room.testArmUploadAuthorization();
    let controller;
    const body = new ReadableStream({ start(value) { controller = value; value.enqueue(Uint8Array.of(1)); } });
    const pending = instance.dispatchFetch(`https://sync.test/v1/spaces/${space.roomId}/files/uploads/${started.body.uploadId}/chunks/0`, {
      method: 'PUT', body, duplex: 'half', headers: { Origin: origin, Authorization: `Bearer ${space.token}`, 'X-Sync-Key-Id': keyId }
    });
    for (let attempt = 0; attempt < 100 && !await room.testUploadAuthorized(); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(await room.testUploadAuthorized(), true);
    if (mutation === 'remove-device') await room.removeDevice(space.deviceId);
    else {
      const nextKeyId = randomUUID();
      const envelope = await cryptoClient.encryptPayload(request.state.sessions.get(space.token).keyring, space.roomId, 'test-rotation', { nextKeyId });
      const rotated = await room.rotateKeys(space.deviceId, keyId, { rotationId: randomUUID(), newKeyId: nextKeyId, removedDeviceId: null,
        grants: [{ deviceId: space.deviceId, envelope }] });
      assert.equal(rotated.ok, true);
    }
    controller.enqueue(Uint8Array.of(2)); controller.close();
    const response = await pending;
    assert.equal(response.status, mutation === 'remove-device' ? 401 : 409);
    const storage = await roomStorage(space, instance);
    assert.deepEqual(await storage.exec('SELECT * FROM file_upload_chunks'), []);
  });
}

test('upload chunks bypass the global registry while retaining device authentication', async t => {
  const instance = await createRuntime(); t.after(() => instance.dispose());
  const request = client(instance), space = await createSpace(request);
  const started = await initiate(request, space, { size: 4 });
  const registry = (await instance.getDurableObjectNamespace('E2EE_PAIRING_REGISTRY')).getByName('registry');
  const before = await registry.testRoomLookups();
  const path = `https://sync.test/v1/spaces/${space.roomId}/files/uploads/${started.body.uploadId}/chunks/0`;
  const keyId = request.state.sessions.get(space.token).keyring.currentKeyId;
  for (const token of [undefined, 'a'.repeat(64), space.token]) {
    const response = await instance.dispatchFetch(path, { method: 'PUT', body: Buffer.from('file'),
      headers: { Origin: origin, 'X-Sync-Key-Id': keyId, ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
    assert.equal(response.status, token === space.token ? 200 : 401);
    await response.arrayBuffer();
  }
  assert.equal(await registry.testRoomLookups(), before);
  assert.equal((await complete(request, space, started.body.uploadId)).status, 201);
});


test('file lookup and upload cleanup stay bounded with 500 retained attachments', async () => {
  const request = client();
  const space = await createSpace(request);
  const storage = await roomStorage(space);
  await storage.exec(`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 500)
    INSERT INTO files (file_id, device_id, client_id, name, type, size, text, status, created_at, updated_at, message_id, reserved_bytes)
    SELECT 'index-' || n, ?, 'index-' || n, 'encrypted', 'application/octet-stream', 0, '',
      CASE WHEN n = 500 THEN 'uploading' ELSE 'complete' END, ?, ?, n, 0 FROM numbers`, space.deviceId, Date.now(), Date.now());
  const results = await (await roomObject(space)).testFileLookups(250);
  assert.equal(results[0].rows[0].message_id, 250);
  assert.ok(results[1].rows[0].updated_at > 0);
  assert.deepEqual(results[2].rows, []);
  for (const { reads } of results) assert.ok(reads <= 3, `expected indexed lookup, read ${reads} rows`);
});


test('warm storage accounting avoids rescanning completed attachments and survives a cold rebuild', async () => {
  const request = client();
  const space = await createSpace(request);
  const storage = await roomStorage(space);
  const room = await roomObject(space);
  await storage.exec(`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 499)
    INSERT INTO files (file_id, device_id, client_id, name, type, size, text, status, created_at, updated_at, message_id, reserved_bytes)
    SELECT 'usage-' || n, ?, 'usage-' || n, 'encrypted', 'application/octet-stream', 0, '', 'complete', ?, ?, n, 0 FROM numbers`, space.deviceId, Date.now(), Date.now());
  await storage.exec("INSERT INTO file_shards (file_id, shard_index, bytes) SELECT file_id, 0, 16384 FROM files");
  const cold = await room.testRebuildAccounting();
  await room.testBeginReads();
  for (let index = 0; index < 3; index++) assert.equal((await room.storageUsage()).bytes, cold.bytes);
  assert.ok(await room.testReadCount() < 20, 'warm usage reads must not grow with the retained file count');
  assert.equal((await room.testRebuildAccounting()).bytes, cold.bytes);
});
