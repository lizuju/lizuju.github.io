import assert from 'node:assert/strict';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Miniflare } from 'miniflare';

const chunkSize = 8 * 1024 ** 2;
const plainChunkSize = chunkSize - 16;
const fileSize = 2 * 1024 ** 3;
const origin = 'https://lizuju.github.io';
const startedAt = Date.now();
const directory = await mkdtemp(join(tmpdir(), 'portfolio-2gib-'));
const disk = await statfs(directory);
assert.ok(disk.bavail * disk.bsize > 7 * 1024 ** 3, 'This isolated acceptance needs at least 7 GiB of free temporary disk space');
const contents = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
const dailyUsageContents = await readFile(new URL('../src/daily-usage.js', import.meta.url), 'utf8');
let runtime;
let space;
let session;
const cryptoSource = (await readFile(new URL('../../../static/portfolio/js/apps/sync-crypto.js', import.meta.url), 'utf8')).replaceAll("'@serenity-kit/opaque'", JSON.stringify(import.meta.resolve('@serenity-kit/opaque')));
const c = await import(`data:text/javascript;base64,${Buffer.from(cryptoSource).toString('base64')}`);
let ip = 1;

async function startRuntime() {
  runtime = new Miniflare({
    unsafeInspectDurableObjects: true,
    resourcePersistencePath: directory,
    workers: [{ config: {
      name: 'sync-large-transfer', compatibilityDate: '2026-10-23',
      manifest: { mainModule: 'index.js', modules: { 'index.js': { type: 'esm', contents }, 'daily-usage.js': { type: 'esm', contents: dailyUsageContents } } },
      env: {
        ALLOWED_ORIGINS: { type: 'text', value: origin },
        E2EE_PAIRING_REGISTRY: { type: 'durable-object', worker: 'sync-large-transfer', exportName: 'E2eePairingRegistry' },
        E2EE_SYNC_ROOMS: { type: 'durable-object', worker: 'sync-large-transfer', exportName: 'E2eeSyncRoom' },
        E2EE_FILE_SHARDS: { type: 'durable-object', worker: 'sync-large-transfer', exportName: 'E2eeFileShard' }
      },
      exports: Object.fromEntries(['E2eePairingRegistry', 'E2eeSyncRoom', 'E2eeFileShard'].map(name => [name, { type: 'durable-object', storage: 'sqlite' }]))
    } }]
  });
  await runtime.ready;
}

async function request(path, { method = 'GET', token = space?.token, json, body, headers = {} } = {}) {
  const requestHeaders = { Origin: origin, 'CF-Connecting-IP': `198.51.100.${ip}`, ...headers };
  if (token) requestHeaders.Authorization = `Bearer ${token}`;
  if (session) requestHeaders['X-Sync-Key-Id'] = session.keyring.currentKeyId;
  if (json) { requestHeaders['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  return runtime.dispatchFetch(`https://sync.test${path}`, { method, headers: requestHeaders, body });
}

async function expectJson(response, status) {
  const value = await response.json();
  assert.equal(response.status, status, JSON.stringify(value));
  return value;
}

function part(index) {
  const bytes = Buffer.allocUnsafe(Math.min(plainChunkSize, fileSize - index * plainChunkSize));
  for (let offset = 0; offset < bytes.length; offset++) bytes[offset] = (index * 131 + offset) % 251;
  return bytes;
}

async function hashStream(response, metadata) {
  const digest = createHash('sha256');
  const reader = response.body.getReader();
  let bytes = 0, index = 0, pending = Buffer.alloc(0);
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      pending = Buffer.concat([pending, next.value]);
      while (index < Math.ceil(metadata.size / plainChunkSize) && pending.length >= Math.min(plainChunkSize, metadata.size - index * plainChunkSize) + 16) {
        const expected = Math.min(plainChunkSize, metadata.size - index * plainChunkSize) + 16;
        const clear = new Uint8Array(await c.decryptFileChunk(metadata, index, pending.subarray(0, expected)));
        digest.update(clear); bytes += clear.byteLength; index++;
        pending = pending.subarray(expected);
        await delay(25);
      }
    }
    assert.equal(pending.length, 0);
  } finally { reader.releaseLock(); }
  return { bytes, hash: digest.digest('hex') };
}

async function pairPeer() {
  const offerId = randomUUID();
  const secret = await c.createPairingSecret('0123', offerId);
  const encrypted = await c.encryptPayload(session.keyring, space.roomId, `offer:${offerId}`, { ...secret, ownerDeviceId: space.deviceId });
  await expectJson(await request(`/v1/spaces/${space.roomId}/pair-code`, { method: 'POST', json: { offerId, secret: encrypted } }), 200);
  const requestId = randomUUID(), requestToken = randomBytes(32).toString('hex');
  const client = await c.startPairingClient('0123', offerId);
  await expectJson(await request('/v1/pair', { method: 'POST', token: null, json: { requestId, requestToken, requests: [{ offerId, startLoginRequest: client.startLoginRequest }] } }), 202);
  const host = await c.startPairingHost(secret, offerId, requestId, client.startLoginRequest);
  await expectJson(await request(`/v1/spaces/${space.roomId}/pair-challenge`, { method: 'POST', json: { requestId, offerId, loginResponse: host.loginResponse } }), 200);
  const accepted = await c.finishPairingClient(client.clientState, offerId, requestId, host.loginResponse);
  const identity = await c.createDeviceIdentity();
  const nonce = randomBytes(32).toString('hex');
  const clientData = await c.encryptPairing(accepted.sessionKey, offerId, requestId, { nonce, publicKey: identity.publicKey });
  await expectJson(await request(`/v1/pair/${requestId}`, { method: 'POST', token: requestToken, json: { offerId, finishLoginRequest: accepted.finishLoginRequest, clientData } }), 200);
  const sessionKey = await c.finishPairingHost(host.serverState, accepted.finishLoginRequest);
  const deviceId = randomUUID(), token = randomBytes(32).toString('hex');
  const rotation = await c.createKeyRotation(session, [{ deviceId: space.deviceId, publicKey: session.identity.publicKey }, { deviceId, publicKey: identity.publicKey }]);
  const name = await c.encryptPayload(rotation.next.keyring, space.roomId, `device:${deviceId}`, { name: '', publicKey: identity.publicKey });
  const grant = await c.encryptPairing(sessionKey, offerId, requestId, { roomId: space.roomId, deviceId, token, ...rotation.next, nonce });
  await expectJson(await request(`/v1/spaces/${space.roomId}/pair-accept`, { method: 'POST', json: { requestId, offerId, deviceId, token, name, grant, rotationId: rotation.rotationId, newKeyId: rotation.newKeyId, grants: rotation.grants.filter(item => item.deviceId !== deviceId) } }), 200);
  Object.assign(session, rotation.next);
  return { deviceId, token };
}

try {
  await startRuntime();
  const keyring = await c.createKeyring();
  space = await expectJson(await request('/v1/spaces', { method: 'POST', json: { keyId: keyring.currentKeyId } }), 201);
  session = { ...space, keyring, identity: await c.createDeviceIdentity(), trustedDevices: {}, revokedDevices: [] };
  session.trustedDevices[space.deviceId] = session.identity.publicKey;
  ip += 1;
  const peer = await pairPeer();
  const encryption = c.createFileMetadata({ name: 'isolated-2GiB.bin', type: 'application/octet-stream', size: fileSize });
  const wireSize = fileSize + Math.ceil(fileSize / plainChunkSize) * 16;
  const clientId = randomUUID();
  const metadata = { clientId, name: encryption.fileId, type: 'application/octet-stream', size: wireSize, text: await c.encryptPayload(session.keyring, space.roomId, `message:${space.deviceId}:${clientId}`, { text: 'isolated local long transfer acceptance', attachment: encryption }), fingerprint: await c.keyedFingerprint(encryption, 'isolated-generated-file') };
  const upload = await expectJson(await request(`/v1/spaces/${space.roomId}/files/uploads`, { method: 'POST', json: metadata }), 201);
  assert.equal(upload.chunkSize, chunkSize);
  const expected = createHash('sha256');
  let peakRss = process.memoryUsage().rss;
  for (let index = 0; index < Math.ceil(fileSize / plainChunkSize); index += 1) {
    const plain = part(index); expected.update(plain);
    const bytes = new Uint8Array(await c.encryptFileChunk(encryption, index, plain));
    const stored = await expectJson(await request(`/v1/spaces/${space.roomId}/files/uploads/${upload.uploadId}/chunks/${index}`, { method: 'PUT', body: bytes }), 200);
    assert.equal(stored.receivedBytes, Math.min((index + 1) * chunkSize, wireSize));
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
  assert.equal(message.attachment.size, wireSize);
  const ticket = await expectJson(await request(`/v1/spaces/${space.roomId}/files/${message.id}/download`, { method: 'POST', token: peer.token }), 200);
  const downloadPath = `/v1/spaces/${space.roomId}/downloads/${ticket.ticket}`;
  const download = await request(downloadPath, { token: null });
  assert.equal(download.status, 200); assert.equal(Number(download.headers.get('Content-Length')), wireSize);
  const downloaded = await hashStream(download, encryption);
  assert.equal(downloaded.bytes, fileSize); assert.equal(downloaded.hash, expectedHash);
  console.log('PASS full slow streaming download SHA-256');
  const rangeStart = 64 * 1024 ** 2 - 23, rangeEnd = rangeStart + 81;
  const ranged = await request(downloadPath, { token: null, headers: { Range: `bytes=${rangeStart}-${rangeEnd}` } });
  assert.equal(ranged.status, 206);
  const rangeBytes = Buffer.from(await ranged.arrayBuffer());
  const previous = new Uint8Array(await c.encryptFileChunk(encryption, 7, part(7)));
  const next = new Uint8Array(await c.encryptFileChunk(encryption, 8, part(8)));
  const expectedRange = Buffer.concat([previous.subarray(chunkSize - 23), next.subarray(0, 59)]);
  assert.deepEqual(rangeBytes, expectedRange);
  const lastIndex = Math.floor((fileSize - 1) / plainChunkSize);
  const tail = await request(downloadPath, { token: null, headers: { Range: `bytes=${lastIndex * chunkSize}-` } });
  assert.equal(tail.status, 206); assert.deepEqual(Buffer.from(await c.decryptFileChunk(encryption, lastIndex, await tail.arrayBuffer())), part(lastIndex));
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
  const revoked = await request(downloadPath, { token: null }); await expectJson(revoked, 404);
  console.log('PASS active-download device revocation');
  console.log(JSON.stringify({ ok: true, scope: 'isolated-local', uploadedBytes: fileSize, chunks: Math.ceil(fileSize / plainChunkSize), downloadSha256: expectedHash, runtimeRestartAtBytes: 64 * chunkSize, slowReadPauseMsPer8MiB: 25, nodePeakRssBytes: peakRss, durationMs: Date.now() - startedAt }));
} finally {
  await runtime?.dispose();
  await rm(directory, { recursive: true, force: true });
}
