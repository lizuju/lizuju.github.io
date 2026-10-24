import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Miniflare } from 'miniflare';

const chunkSize = 8 * 1024 ** 2;
const fileSize = 2 * 1024 ** 3;
const origin = 'https://lizuju.github.io';
const startedAt = Date.now();
const directory = await mkdtemp(join(tmpdir(), 'portfolio-2gib-'));
const disk = await statfs(directory);
assert.ok(disk.bavail * disk.bsize > 7 * 1024 ** 3, 'This isolated acceptance needs at least 7 GiB of free temporary disk space');
const contents = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
let runtime;
let space;
let ip = 1;

async function startRuntime() {
  runtime = new Miniflare({
    unsafeInspectDurableObjects: true,
    resourcePersistencePath: directory,
    workers: [{ config: {
      name: 'sync-large-transfer', compatibilityDate: '2026-10-23',
      manifest: { mainModule: 'index.js', modules: { 'index.js': { type: 'esm', contents } } },
      env: {
        ALLOWED_ORIGINS: { type: 'text', value: origin },
        PAIRING_REGISTRY: { type: 'durable-object', worker: 'sync-large-transfer', exportName: 'PairingRegistry' },
        SYNC_ROOMS: { type: 'durable-object', worker: 'sync-large-transfer', exportName: 'SyncRoom' },
        FILE_SHARDS: { type: 'durable-object', worker: 'sync-large-transfer', exportName: 'FileShard' }
      },
      exports: Object.fromEntries(['PairingRegistry', 'SyncRoom', 'FileShard'].map(name => [name, { type: 'durable-object', storage: 'sqlite' }]))
    } }]
  });
  await runtime.ready;
}

async function request(path, { method = 'GET', token = space?.token, json, body, headers = {} } = {}) {
  const requestHeaders = { Origin: origin, 'CF-Connecting-IP': `198.51.100.${ip}`, ...headers };
  if (token) requestHeaders.Authorization = `Bearer ${token}`;
  if (json) { requestHeaders['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  return runtime.dispatchFetch(`https://sync.test${path}`, { method, headers: requestHeaders, body });
}

async function expectJson(response, status) {
  const value = await response.json();
  assert.equal(response.status, status, JSON.stringify(value));
  return value;
}

function part(index) {
  const bytes = Buffer.allocUnsafe(chunkSize);
  for (let offset = 0; offset < bytes.length; offset += 4) bytes.writeUInt32LE((index * 2654435761 + offset / 4) >>> 0, offset);
  return bytes;
}

async function hashStream(response, { slow = false } = {}) {
  const digest = createHash('sha256');
  const reader = response.body.getReader();
  let bytes = 0, lastPause = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      digest.update(next.value); bytes += next.value.byteLength;
      if (slow && bytes - lastPause >= 8 * 1024 ** 2) { lastPause = bytes; await delay(25); }
    }
  } finally { reader.releaseLock(); }
  return { bytes, hash: digest.digest('hex') };
}

try {
  await startRuntime();
  space = await expectJson(await request('/v1/spaces', { method: 'POST' }), 201);
  ip += 1;
  const peer = await expectJson(await request('/v1/pair', { method: 'POST', json: { code: space.code } }), 200);
  const metadata = { clientId: randomUUID(), name: 'isolated-2GiB.bin', type: 'application/octet-stream', size: fileSize, text: 'isolated local long transfer acceptance' };
  const upload = await expectJson(await request(`/v1/spaces/${space.roomId}/files/uploads`, { method: 'POST', json: metadata }), 201);
  assert.equal(upload.chunkSize, chunkSize);
  const expected = createHash('sha256');
  let peakRss = process.memoryUsage().rss;
  for (let index = 0; index < 256; index += 1) {
    const bytes = part(index); expected.update(bytes);
    const stored = await expectJson(await request(`/v1/spaces/${space.roomId}/files/uploads/${upload.uploadId}/chunks/${index}`, { method: 'PUT', body: bytes }), 200);
    assert.equal(stored.receivedBytes, (index + 1) * chunkSize);
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    if (index === 63) {
      const duplicate = await expectJson(await request(`/v1/spaces/${space.roomId}/files/uploads/${upload.uploadId}/chunks/${index}`, { method: 'PUT', body: bytes }), 200);
      assert.equal(duplicate.receivedBytes, stored.receivedBytes);
      await runtime.dispose(); runtime = null;
      await startRuntime();
      const resumed = await expectJson(await request(`/v1/spaces/${space.roomId}/files/uploads`, { method: 'POST', json: metadata }), 200);
      assert.equal(resumed.uploadId, upload.uploadId); assert.equal(resumed.receivedBytes, 64 * chunkSize);
      console.log('PASS restart and idempotent retry at 512 MiB');
    }
    if ((index + 1) % 32 === 0) console.log(`Uploaded ${(index + 1) * chunkSize / 1024 ** 2} / 2048 MiB`);
  }
  const expectedHash = expected.digest('hex');
  const message = await expectJson(await request(`/v1/spaces/${space.roomId}/files/uploads/${upload.uploadId}/complete`, { method: 'POST' }), 201);
  assert.equal(message.attachment.size, fileSize);
  const ticket = await expectJson(await request(`/v1/spaces/${space.roomId}/files/${message.id}/download`, { method: 'POST', token: peer.token }), 200);
  const downloadPath = `/v1/spaces/${space.roomId}/downloads/${ticket.ticket}`;
  const download = await request(downloadPath, { token: null });
  assert.equal(download.status, 200); assert.equal(Number(download.headers.get('Content-Length')), fileSize);
  const downloaded = await hashStream(download, { slow: true });
  assert.equal(downloaded.bytes, fileSize); assert.equal(downloaded.hash, expectedHash);
  console.log('PASS full slow streaming download SHA-256');
  const rangeStart = 64 * 1024 ** 2 - 23, rangeEnd = rangeStart + 81;
  const ranged = await request(downloadPath, { token: null, headers: { Range: `bytes=${rangeStart}-${rangeEnd}` } });
  assert.equal(ranged.status, 206);
  const rangeBytes = Buffer.from(await ranged.arrayBuffer());
  const expectedRange = Buffer.concat([part(7).subarray(chunkSize - 23), part(8).subarray(0, 59)]);
  assert.deepEqual(rangeBytes, expectedRange);
  const tail = await request(downloadPath, { token: null, headers: { Range: `bytes=${fileSize - chunkSize}-` } });
  assert.equal(tail.status, 206); assert.deepEqual(Buffer.from(await tail.arrayBuffer()), part(255));
  console.log('PASS cross-shard range and final-chunk resume');
  const ongoing = await request(downloadPath, { token: null });
  assert.equal(ongoing.status, 200);
  const reader = ongoing.body.getReader();
  assert.ok((await reader.read()).value.byteLength > 0);
  await expectJson(await request(`/v1/spaces/${space.roomId}/devices/${peer.deviceId}`, { method: 'DELETE' }), 200);
  let receivedAfterRevocation = 0, closed = false;
  try {
    while (receivedAfterRevocation < 16 * 1024 ** 2) {
      const next = await reader.read(); if (next.done) { closed = true; break; }
      receivedAfterRevocation += next.value.byteLength;
    }
  } catch { closed = true; }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  assert.equal(closed, true, 'Revocation must stop the active stream within its bounded buffers');
  const revoked = await request(downloadPath, { token: null }); assert.equal(revoked.status, 401); await revoked.body.cancel();
  console.log('PASS active-download device revocation');
  console.log(JSON.stringify({ ok: true, scope: 'isolated-local', uploadedBytes: fileSize, chunks: 256, downloadSha256: expectedHash, runtimeRestartAtBytes: 64 * chunkSize, slowReadPauseMsPer8MiB: 25, nodePeakRssBytes: peakRss, durationMs: Date.now() - startedAt }));
} finally {
  await runtime?.dispose();
  await rm(directory, { recursive: true, force: true });
}
