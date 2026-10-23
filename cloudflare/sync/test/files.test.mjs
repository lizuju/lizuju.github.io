import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { Miniflare } from 'miniflare';

const origin = 'https://lizuju.github.io';
const MiB = 1024 * 1024;
const chunkSize = 8 * MiB;
const maximumFileSize = 2 * 1024 * MiB;
const fiveDays = 5 * 24 * 60 * 60 * 1000;
let runtime;
let nextIp = 1;
const sockets = new Set();

before(async () => { runtime = await createRuntime(); });
after(async () => {
  for (const socket of sockets) if (socket.readyState === 1) socket.close();
  await runtime?.dispose();
});

async function createRuntime({ virtualMessageBytes = 0, virtualBaseBytes = 0 } = {}) {
  const instance = new Miniflare({
    unsafeInspectDurableObjects: true,
    workers: [{
      config: {
        name: 'sync-files-test',
        compatibilityDate: '2026-10-23',
        manifest: {
          mainModule: 'harness.js',
          modules: {
            'index.js': { type: 'esm', contents: await readFile(new URL('../src/index.js', import.meta.url), 'utf8') },
            'harness.js': {
              type: 'esm',
              contents: `import worker, { SyncRoom as ProductionSyncRoom, PairingRegistry as ProductionRegistry, FileShard as ProductionFileShard } from './index.js';
                export class FileShard extends ProductionFileShard {
                  readStream(offset, length) {
                    this.readRequests ||= [];
                    this.readRequests.push({ offset, length });
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
                  refreshRoom(roomId) { this.refreshes = (this.refreshes || 0) + 1; return super.refreshRoom(roomId); }
                  testRefreshes() { return this.refreshes || 0; }
                  testRunAlarm() { return super.alarm(); }
                  testReadAlarm() { return this.ctx.storage.getAlarm(); }
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
          PAIRING_REGISTRY: { type: 'durable-object', worker: 'sync-files-test', exportName: 'PairingRegistry' },
          SYNC_ROOMS: { type: 'durable-object', worker: 'sync-files-test', exportName: 'SyncRoom' },
          FILE_SHARDS: { type: 'durable-object', worker: 'sync-files-test', exportName: 'FileShard' }
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
  return async (path, { method = 'GET', token, json, body, headers = {} } = {}) => {
    const requestHeaders = { Origin: origin, 'CF-Connecting-IP': ip, ...headers };
    if (requestHeaders.Origin === null) delete requestHeaders.Origin;
    if (token !== undefined) requestHeaders.Authorization = `Bearer ${token}`;
    if (json !== undefined) {
      requestHeaders['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    }
    const response = await instance.dispatchFetch(`https://sync.test${path}`, { method, headers: requestHeaders, body });
    return {
      status: response.status,
      headers: response.headers,
      body: method !== 'HEAD' && response.headers.get('Content-Type')?.includes('application/json')
        ? await response.json()
        : Buffer.from(await response.arrayBuffer())
    };
  };
}

async function createSpace(request = client()) {
  const result = await request('/v1/spaces', { method: 'POST' });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body;
}

function initiate(request, space, { clientId = randomUUID(), name = 'file.bin', type = 'application/octet-stream', size = 0, text = '' } = {}) {
  return request(`/v1/spaces/${space.roomId}/files/uploads`, {
    method: 'POST', token: space.token, json: { clientId, name, type, size, text }
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
  const namespace = await instance.getDurableObjectNamespace('SYNC_ROOMS');
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
  const shardIds = await runtime.listDurableObjectIds('FILE_SHARDS');
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
  assert.ok(downloaded.headers.get('Content-Disposition').includes(`filename*=UTF-8''${encodeURIComponent(name)}`));
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
  const namespace = await runtime.getDurableObjectNamespace('PAIRING_REGISTRY');
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
  const started = await initiate(request, space, { clientId, size: maximumFileSize, name: 'maximum.bin' });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  assert.equal(started.body.chunkSize, chunkSize);
  assert.equal(started.body.receivedBytes, 0);
  assert.match(started.body.uploadId, /^[0-9a-f-]{36}$/);
  const retry = await initiate(request, space, { clientId, size: maximumFileSize, name: 'maximum.bin' });
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.body, started.body);
  const state = await request(`/v1/spaces/${space.roomId}`, { token: space.token });
  assert.deepEqual(state.body.messages, []);
  const tooLarge = await initiate(request, space, { size: maximumFileSize + 1 });
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
  for (const fixture of [
    { clientId: '' }, { clientId: '1234' }, { clientId: '00000000-0000-1000-8000-000000000000' },
    { text: 'x'.repeat(10001) }, { text: null },
    { name: '' }, { name: 'x'.repeat(256) }, { name: 'folder/file.txt' }, { name: 'folder\\file.txt' },
    { name: 'bad\u0000file.txt' }, { name: 'bad\u0001file.txt' }, { name: 'bad\r\nfile.txt' },
    { type: 'application' }, { type: 'text/' }, { type: '/plain' }, { type: 'text/plain; charset=utf-8' },
    { type: `application/${'x'.repeat(244)}` }
  ]) {
    const result = await initiate(request, space, fixture);
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
  assert.deepEqual(frames.filter(frame => frame !== 'pong').map(frame => JSON.parse(frame)), [
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
  for (const declared of ['1', 'omit']) {
    const result = await putChunk(request, space, started.body.uploadId, 0, Buffer.alloc(chunkSize + 1), {
      'X-Test-Content-Length': declared
    });
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
  const shardNamespace = await instance.getDurableObjectNamespace('FILE_SHARDS');
  const lastShard = shardNamespace.getByName(`${fileId}:31`);
  await lastShard.storageBytes();
  const shardStorage = await instance.unsafeGetDurableObjectStorage('sync-files-test', 'FileShard', { name: `${fileId}:31` });
  const lastMiB = randomBytes(MiB);
  await shardStorage.exec('INSERT INTO chunks (chunk_index, data) VALUES (?, ?)', 63, lastMiB);
  const issued = await request(`/v1/spaces/${space.roomId}/files/${id}/download`, { method: 'POST', token: space.token });
  const path = `/v1/spaces/${space.roomId}/downloads/${issued.body.ticket}`;
  const ranged = await request(path, { headers: { Range: 'bytes=-23' } });
  assert.equal(ranged.status, 206);
  assert.deepEqual(ranged.body, lastMiB.subarray(MiB - 23));
  assert.equal(ranged.headers.get('Content-Range'), `bytes ${maximumFileSize - 23}-${maximumFileSize - 1}/${maximumFileSize}`);
  assert.deepEqual(await lastShard.testReadRequests(), [{ offset: 64 * MiB - 23, length: 23 }]);
  assert.equal((await instance.listDurableObjectIds('FILE_SHARDS')).length, 1);
  assert.equal((await request(path, { method: 'HEAD' })).headers.get('Content-Length'), String(maximumFileSize));
  assert.equal((await lastShard.testReadRequests()).length, 1);

  await storage.exec('UPDATE files SET created_at = ?', Date.now() - fiveDays - 1);
  for (const method of ['GET', 'HEAD']) {
    assert.equal((await request(path, { method, headers: { Range: 'bytes=-23' } })).status, 404);
  }
  assert.equal((await lastShard.testReadRequests()).length, 1);
});

test('ticket previews inline only safe media and PDF while retaining range and credential checks', async () => {
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
    const safe = !['text/html', 'image/svg+xml', 'application/octet-stream'].includes(type);
    assert.equal(preview.headers.get('Content-Type'), safe ? type : 'application/octet-stream');
    assert.ok(preview.headers.get('Content-Disposition').startsWith(safe ? 'inline;' : 'attachment;'));
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
  assert.equal((await request(path)).status, 401);
  assert.equal((await request(path, { method: 'HEAD' })).status, 401);
});

test('clearing history removes file manifests, upload rows and physical shard bytes from storage usage', async () => {
  const request = client();
  const space = await createSpace(request);
  const previous = await runtime.listDurableObjectIds('FILE_SHARDS');
  const sent = await upload(request, space, { bytes: randomBytes(2 * MiB + 97) });
  assert.equal(sent.status, 201);
  const shardIds = (await runtime.listDurableObjectIds('FILE_SHARDS')).filter(id => !previous.includes(id));
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
  const previous = await runtime.listDurableObjectIds('FILE_SHARDS');
  const expired = await upload(request, space, { bytes: randomBytes(MiB + 9), name: 'expired.bin' });
  assert.equal(expired.status, 201);
  const expiredShards = (await runtime.listDurableObjectIds('FILE_SHARDS')).filter(id => !previous.includes(id));
  const survivorBytes = Buffer.from('keep this attachment');
  const survivor = await upload(request, space, { bytes: survivorBytes, name: 'surviving.txt', type: 'text/plain' });
  assert.equal(survivor.status, 201);
  const storage = await roomStorage(space);
  await storage.exec('UPDATE messages SET created_at = ? WHERE id = ?', Date.now() - fiveDays - 1000, expired.body.id);
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
  const previous = await runtime.listDurableObjectIds('FILE_SHARDS');
  const expired = await upload(request, space, { bytes: randomBytes(MiB + 31) });
  assert.equal(expired.status, 201);
  const expiredShards = (await runtime.listDurableObjectIds('FILE_SHARDS')).filter(id => !previous.includes(id));
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
    const previous = await runtime.listDurableObjectIds('FILE_SHARDS');
    const started = await initiate(request, space, { size: chunkSize + 1 });
    assert.equal(started.status, 201);
    assert.equal((await putChunk(request, space, started.body.uploadId, 0, randomBytes(chunkSize))).status, 200);
    const shardIds = (await runtime.listDurableObjectIds('FILE_SHARDS')).filter(id => !previous.includes(id));
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

test('file support initializes around the old message schema without changing existing message shape or credentials', async t => {
  const instance = await createRuntime();
  t.after(() => instance.dispose());
  const request = client(instance);
  const space = await createSpace(request);
  const sent = await request(`/v1/spaces/${space.roomId}/messages`, {
    method: 'POST', token: space.token, json: { clientId: randomUUID(), text: 'legacy message' }
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
    const previous = await instance.listDurableObjectIds('FILE_SHARDS');
    const sent = await upload(request, space, { bytes: randomBytes(1000 + index), name: `old-${index}.bin` });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    const shardIds = (await instance.listDurableObjectIds('FILE_SHARDS')).filter(id => !previous.includes(id));
    files.push({ space, message: sent.body, shardIds });
  }
  const storage = await Promise.all(spaces.map(space => roomStorage(space, instance)));
  for (let index = 0; index < files.length; index += 1) {
    await storage[index % 2].exec('UPDATE messages SET created_at = ? WHERE id = ?', Date.now() - 60000 + index * 1000, files[index].message.id);
  }
  const registryNamespace = await instance.getDurableObjectNamespace('PAIRING_REGISTRY');
  const registry = registryNamespace.getByName('registry');
  for (const space of spaces) await registry.refreshRoom(space.roomId);
  const before = await registry.storageBytes();
  assert.ok(before >= 4_700_000_000);
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
    if (clearedHistory) {
      const cleared = await request(`/v1/spaces/${deletedSpace.roomId}/messages`, { method: 'DELETE', token: deletedSpace.token });
      assert.equal(cleared.status, 200);
    }
    const survivor = await request(`/v1/spaces/${survivorSpace.roomId}/messages`, {
      method: 'POST', token: survivorSpace.token, json: { clientId: randomUUID(), text: 'keep this history' }
    });
    assert.equal(survivor.status, 201);
    const survivorStorage = await roomStorage(survivorSpace, instance);
    if (separateRoom) {
      await survivorStorage.exec('UPDATE messages SET created_at = ? WHERE id = ?', timestamp - 10000, survivor.body.id);
    }
    const registryNamespace = await instance.getDurableObjectNamespace('PAIRING_REGISTRY');
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
      assert.deepEqual(await survivorStorage.exec('SELECT text FROM messages WHERE id = ?', survivor.body.id), [{ text: 'keep this history' }]);
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
  const freshClientId = randomUUID();
  const fresh = await initiate(request, space, { clientId: freshClientId, size: 1024 * MiB });
  assert.equal(fresh.status, 201);
  const [beforeFresh] = await storage.exec('SELECT status, reserved_bytes FROM files WHERE file_id = ?', fresh.body.uploadId);
  const blocked = await initiate(request, space, { size: maximumFileSize });
  assert.equal(blocked.status, 503);
  const registryStorage = await instance.unsafeGetDurableObjectStorage('sync-files-test', 'PairingRegistry', { name: 'registry' });
  const registryNamespace = await instance.getDurableObjectNamespace('PAIRING_REGISTRY');
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

test('capacity pruning cancels an older upload before removing newer messages', async () => {
  const request = client();
  const space = await createSpace(request);
  const started = await initiate(request, space, { size: MiB });
  const storage = await roomStorage(space);
  await storage.exec('UPDATE files SET created_at = ?', Date.now() - 10000);
  const sent = await request(`/v1/spaces/${space.roomId}/messages`, { method: 'POST', token: space.token, json: { clientId: randomUUID(), text: 'newer history survives' } });
  const room = await roomObject(space);
  await room.pruneOldest();
  assert.deepEqual(await storage.exec('SELECT text FROM messages'), [{ text: sent.body.text }]);
  assert.deepEqual(await storage.exec('SELECT file_id FROM files WHERE file_id = ?', started.body.uploadId), []);
});
