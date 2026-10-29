import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { MessageChannel } from 'node:worker_threads';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../../../static/portfolio/sync-e2ee-worker.js', import.meta.url), 'utf8');
const cryptoSource = await readFile(new URL('../../../static/portfolio/js/apps/sync-crypto.js', import.meta.url), 'utf8');
const fileCrypto = await import(`data:text/javascript;base64,${Buffer.from(cryptoSource).toString('base64')}`);
const chunkSize = 8 * 1024 * 1024 - 16;
const apiUrl = 'https://sync.test/v1/spaces/room/downloads/ticket';
const token = 'a'.repeat(48);
const owner = 'browser-one';

const encrypt = async (metadata, clear, index) => {
  const key = await webcrypto.subtle.importKey('raw', metadata.key, 'AES-GCM', false, ['encrypt']);
  const nonce = new Uint8Array(12);
  nonce.set(metadata.noncePrefix);
  new DataView(nonce.buffer).setUint32(8, index);
  return new Uint8Array(await webcrypto.subtle.encrypt({
    name: 'AES-GCM', iv: nonce,
    additionalData: new TextEncoder().encode(`gavin-sync-file-v1:${metadata.fileId}:${index}`)
  }, key, clear));
};
const fixture = async (size = chunkSize + 97) => {
  const metadata = {
    key: webcrypto.getRandomValues(new Uint8Array(32)), noncePrefix: webcrypto.getRandomValues(new Uint8Array(8)),
    fileId: '9c855a94-2b04-4c48-98c5-357f5c8de8c5', size, type: 'application/pdf', name: '加密论文.pdf'
  };
  const clear = Uint8Array.from({ length: size }, (_, index) => index % 251);
  const chunks = [];
  for (let offset = 0; offset < size; offset += chunkSize) chunks.push(await encrypt(metadata, clear.subarray(offset, offset + chunkSize), chunks.length));
  return { metadata, clear, wire: Buffer.concat(chunks), url: apiUrl };
};
const worker = (descriptor, getBytes, Stream = ReadableStream, refresh) => {
  descriptor = { ...descriptor, expiresAt: descriptor.download ? Date.now() + 60000 : null };
  const handlers = new Map();
  const requests = [];
  const notifications = [];
  const descriptors = new Map([[`${owner}:${token}`, descriptor]]);
  let resolutions = 0;
  const client = {
    id: owner, type: 'window', url: 'https://site.test/portfolio/',
    postMessage(message, ports) {
      notifications.push(message);
      if (message.type === 'released') { descriptors.delete(`${this.id}:${message.token}`); return; }
      if (message.type === 'download-progress') return;
      if (message.type === 'download-state') { descriptor.expiresAt = message.expiresAt; return; }
      if (message.type === 'refresh') { Promise.resolve(refresh()).then(url => ports[0].postMessage(url)); return; }
      assert.equal(message.type, 'resolve');
      resolutions++;
      ports[0].postMessage(descriptors.get(`${this.id}:${message.token}`) || null);
    }
  };
  const scope = 'https://site.test/portfolio/';
  vm.runInNewContext(source, {
    self: { registration: { scope }, location: new URL(scope), addEventListener: (name, callback) => handlers.set(name, callback), clients: { get: async id => id === owner || id === 'browser-two' ? { ...client, id } : null } },
    URL, crypto: webcrypto, atob, TextEncoder, Response, Headers, ReadableStream: Stream, AbortController, MessageChannel, setTimeout, clearTimeout,
    async fetch(url, options) {
      if (String(url) === `${scope}sync-config.json`) return Response.json({ apiBase: 'https://sync.test' });
      assert.equal(new URL(url).origin, new URL(apiUrl).origin);
      assert.equal(options.credentials, 'omit');
      const range = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);
      assert.ok(range);
      const start = Number(range[1]);
      const end = Number(range[2]);
      requests.push([start, end]);
      assert.ok(end - start + 1 <= 8 * 1024 * 1024);
      const plainSize = fileCrypto.fileChunkLayout(descriptor.metadata).plainSize;
      const total = descriptor.metadata.size + Math.ceil(descriptor.metadata.size / plainSize) * 16;
      const bytes = await getBytes(start, end, String(url));
      return bytes instanceof Response ? bytes : new Response(bytes, { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${total}` } });
    }
  });
  return {
    requests,
    notifications,
    get resolutions() { return resolutions; },
    close(capabilityToken = token, capabilityOwner = owner) { descriptors.delete(`${capabilityOwner}:${capabilityToken}`); handlers.get('message')({ data: { source: 'gavin-sync-e2ee', type: 'close', token: capabilityToken }, source: { ...client, id: capabilityOwner } }); },
    async open(value = descriptor, capabilityToken = token, capabilityOwner = owner) {
      descriptors.set(`${capabilityOwner}:${capabilityToken}`, value);
      let pending;
      let result;
      handlers.get('message')({
        data: { source: 'gavin-sync-e2ee', type: 'open', token: capabilityToken, descriptor: value }, source: { ...client, id: capabilityOwner },
        ports: [{ postMessage(value) { result = value; } }], waitUntil(value) { pending = value; }
      });
      await pending;
      return result;
    },
    async get({ method = 'GET', range, clientId = owner, signal, capabilityToken = token, capabilityOwner = owner } = {}) {
      let response;
      const url = `${scope}__sync-e2ee__/${capabilityOwner}/${capabilityToken}`;
      handlers.get('fetch')({ request: new Request(url, { method, headers: range ? { Range: range } : {}, signal }), clientId, respondWith(value) { response = value; } });
      return response;
    }
  };
};

test('encrypted file ranges authenticate full chunks before returning exact plaintext slices', async () => {
  const file = await fixture();
  const bridge = worker(file, (start, end) => file.wire.subarray(start, end + 1));
  const opened = await bridge.open();
  assert.ok(opened.url.includes(`/__sync-e2ee__/${owner}/${token}`));
  const head = await bridge.get({ method: 'HEAD' });
  assert.equal(head.headers.get('Content-Length'), String(file.clear.length));
  assert.equal(head.headers.get('Cache-Control'), 'no-store');
  assert.equal(bridge.requests.length, 0);
  const first = chunkSize - 11;
  const end = chunkSize + 13;
  const response = await bridge.get({ range: `bytes=${first}-${end}` });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('Content-Range'), `bytes ${first}-${end}/${file.clear.length}`);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(file.clear.subarray(first, end + 1)));
  assert.deepEqual(bridge.requests, [[0, 8 * 1024 * 1024 - 1], [8 * 1024 * 1024, file.wire.length - 1]]);
  const suffix = await bridge.get({ range: 'bytes=-19' });
  assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), Buffer.from(file.clear.subarray(-19)));
  assert.equal(bridge.requests.length, 2);
  for (const range of ['bytes=-0', `bytes=${file.clear.length}-`, 'bytes=0-1,4-5']) assert.equal((await bridge.get({ range })).status, 416);
});

test('a failed ticket refresh can recover on a later range request', async () => {
  const file = await fixture(100);
  let refreshes = 0;
  const freshUrl = apiUrl.replace('ticket', 'b'.repeat(64));
  const bridge = worker(file, (start, end, url) => url === freshUrl
    ? file.wire.subarray(start, end + 1) : new Response(null, { status: 401 }), ReadableStream,
  () => ++refreshes === 1 ? null : freshUrl);
  await bridge.open();
  await assert.rejects((await bridge.get({ range: 'bytes=0-9' })).arrayBuffer(), /encrypted_file_unavailable/);
  assert.deepEqual(Buffer.from(await (await bridge.get({ range: 'bytes=0-9' })).arrayBuffer()), Buffer.from(file.clear.subarray(0, 10)));
  assert.equal(refreshes, 2);
  bridge.close();
});

test('different chunks share an in-flight ticket refresh and allow the next expiry to refresh again', async () => {
  const file = await fixture(chunkSize * 2 + 97);
  let refreshes = 0;
  let completeRefresh;
  let acceptedUrl = '';
  const bridge = worker(file, (start, end, url) => url === acceptedUrl
    ? file.wire.subarray(start, end + 1) : new Response(null, { status: 401 }), ReadableStream,
  () => { refreshes++; return new Promise(resolve => { completeRefresh = () => { acceptedUrl = apiUrl.replace('ticket', String(refreshes).repeat(64)); resolve(acceptedUrl); }; }); });
  await bridge.open();
  const ranges = ['bytes=0-9', `bytes=${chunkSize}-${chunkSize + 9}`];
  const reading = ranges.map(async range => (await bridge.get({ range })).arrayBuffer());
  while (!completeRefresh || bridge.requests.length < 2) await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(refreshes, 1);
  completeRefresh();
  const results = await Promise.all(reading);
  assert.deepEqual(Buffer.from(results[0]), Buffer.from(file.clear.subarray(0, 10)));
  assert.deepEqual(Buffer.from(results[1]), Buffer.from(file.clear.subarray(chunkSize, chunkSize + 10)));
  assert.equal(refreshes, 1);
  acceptedUrl = '';
  completeRefresh = null;
  const later = (await bridge.get({ range: `bytes=${chunkSize * 2}-` })).arrayBuffer();
  while (!completeRefresh) await new Promise(resolve => setTimeout(resolve, 0));
  completeRefresh();
  assert.deepEqual(Buffer.from(await later), Buffer.from(file.clear.subarray(chunkSize * 2)));
  assert.equal(refreshes, 2);
  bridge.close();
});

test('a late rejection of an old ticket reuses the URL another chunk already refreshed', async () => {
  const file = await fixture();
  const freshUrl = apiUrl.replace('ticket', 'c'.repeat(64));
  let refreshes = 0;
  let rejectOldTicket;
  const bridge = worker(file, (start, end, url) => {
    if (url === freshUrl) return file.wire.subarray(start, end + 1);
    if (start) return new Promise(resolve => { rejectOldTicket = () => resolve(new Response(null, { status: 401 })); });
    return new Response(null, { status: 401 });
  }, ReadableStream, () => { refreshes++; return freshUrl; });
  await bridge.open();
  const late = (await bridge.get({ range: `bytes=${chunkSize}-${chunkSize + 9}` })).arrayBuffer();
  while (!rejectOldTicket) await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(Buffer.from(await (await bridge.get({ range: 'bytes=0-9' })).arrayBuffer()), Buffer.from(file.clear.subarray(0, 10)));
  rejectOldTicket();
  assert.deepEqual(Buffer.from(await late), Buffer.from(file.clear.subarray(chunkSize, chunkSize + 10)));
  assert.equal(refreshes, 1);
  bridge.close();
});

test('encrypted file stream rejects tampering, invalid origins and other browser clients', async () => {
  const file = await fixture(100);
  const corrupted = Buffer.from(file.wire);
  corrupted[0] ^= 1;
  const bridge = worker(file, () => corrupted);
  await bridge.open();
  assert.equal((await bridge.get({ clientId: 'browser-two' })).status, 404);
  const response = await bridge.get();
  await assert.rejects(response.arrayBuffer(), /encrypted_file_unavailable/);
  assert.equal((await bridge.open({ ...file, url: 'https://other.test/v1/spaces/room/downloads/ticket' })).error, 'encrypted_file_unavailable');
});

test('worker eviction recovers a file capability only from its owning live page and disposal revokes it', async () => {
  const file = await fixture(100);
  const fresh = worker(file, (start, end) => file.wire.subarray(start, end + 1));
  const response = await fresh.get();
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(file.clear));
  assert.equal(fresh.resolutions, 1);
  fresh.close();
  assert.equal((await fresh.get()).status, 404);
});

test('simultaneous ranges share recovery and a late recovery cannot resurrect a disposed capability', async () => {
  const file = await fixture(100);
  const fresh = worker(file, (start, end) => file.wire.subarray(start, end + 1));
  const responses = await Promise.all([fresh.get({ range: 'bytes=0-9' }), fresh.get({ range: 'bytes=10-19' })]);
  assert.deepEqual(Buffer.from(await responses[0].arrayBuffer()), Buffer.from(file.clear.subarray(0, 10)));
  assert.deepEqual(Buffer.from(await responses[1].arrayBuffer()), Buffer.from(file.clear.subarray(10, 20)));
  assert.equal(fresh.resolutions, 1);
  assert.equal(fresh.requests.length, 1);
  fresh.close();
  assert.equal((await fresh.get({ range: 'bytes=0-9' })).status, 404);
  assert.equal(fresh.requests.length, 1);
  const late = worker(file, (start, end) => file.wire.subarray(start, end + 1));
  const waiting = late.get();
  while (!late.resolutions) await Promise.resolve();
  late.close();
  assert.equal((await waiting).status, 404);
  assert.equal(late.requests.length, 0);
});

test('a range at the end of a 2 GiB file fetches and decrypts only its final bounded chunk', async () => {
  const size = 2 * 1024 ** 3;
  const metadata = (await fixture(1)).metadata;
  metadata.size = size;
  const index = Math.floor((size - 1) / chunkSize);
  const last = Uint8Array.from({ length: size - index * chunkSize }, (_, index) => index % 251);
  const encrypted = await encrypt(metadata, last, index);
  const bridge = worker({ url: apiUrl, metadata, download: true }, () => encrypted);
  await bridge.open();
  const response = await bridge.get({ range: `bytes=${size - 13}-` });
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(last.subarray(-13)));
  assert.equal(response.headers.get('Content-Length'), '13');
  assert.match(response.headers.get('Content-Disposition'), /^attachment;/);
  assert.deepEqual(bridge.requests, [[index * 8 * 1024 * 1024, index * 8 * 1024 * 1024 + encrypted.length - 1]]);
  bridge.close();
});

test('a completed native download releases its capability and plaintext chunk cache at EOF', async () => {
  const file = { ...await fixture(100), download: true };
  const bridge = worker(file, (start, end) => file.wire.subarray(start, end + 1));
  await bridge.open();
  assert.deepEqual(Buffer.from(await (await bridge.get()).arrayBuffer()), Buffer.from(file.clear));
  assert.equal((await bridge.get()).status, 404);
  assert.equal(bridge.requests.length, 1);
});

test('an empty native download releases its capability without fetching a chunk', async () => {
  const file = { ...await fixture(0), download: true };
  const bridge = worker(file, () => { throw new Error('empty files have no chunks'); });
  await bridge.open();
  assert.equal((await bridge.get({ method: 'HEAD' })).status, 200);
  assert.equal((await (await bridge.get()).arrayBuffer()).byteLength, 0);
  assert.equal((await bridge.get()).status, 404);
  assert.equal(bridge.requests.length, 0);
});

test('request cancellation while a native download chunk is pending reports cancellation', async () => {
  const file = { ...await fixture(100), download: true };
  let rejectChunk;
  const bridge = worker(file, () => new Promise((_resolve, reject) => { rejectChunk = reject; }));
  await bridge.open();
  const controller = new AbortController();
  const response = await bridge.get({ signal: controller.signal });
  const reading = response.arrayBuffer();
  while (!rejectChunk) await new Promise(resolve => setTimeout(resolve, 0));
  controller.abort();
  rejectChunk(new TypeError('Fetch was interrupted'));
  await assert.rejects(reading, /encrypted_file_unavailable/);
  assert.deepEqual(bridge.notifications.filter(message => message.status).map(message => message.status), ['cancelled']);
  bridge.close();
});

test('an upstream network TypeError without request cancellation still reports failure', async () => {
  const file = { ...await fixture(100), download: true };
  const bridge = worker(file, () => { throw new TypeError('Network connection failed'); });
  await bridge.open();
  await assert.rejects((await bridge.get()).arrayBuffer(), /encrypted_file_unavailable/);
  assert.deepEqual(bridge.notifications.filter(message => message.status).map(message => message.status), ['failed']);
  bridge.close();
});

test('a downstream close racing with plaintext enqueue reports cancellation without an abort signal', async () => {
  const file = { ...await fixture(100), download: true };
  class ClosedConsumerStream {
    constructor(underlying, strategy) {
      return new ReadableStream({
        pull(output) {
          return underlying.pull({
            enqueue(bytes) { output.close(); output.enqueue(bytes); },
            close() { output.close(); },
            error(error) { output.error(error); }
          });
        },
        cancel: underlying.cancel
      }, strategy);
    }
  }
  const bridge = worker(file, (start, end) => file.wire.subarray(start, end + 1), ClosedConsumerStream);
  await bridge.open();
  assert.equal((await (await bridge.get()).arrayBuffer()).byteLength, 0);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(bridge.notifications.filter(message => message.status).map(message => message.status), ['cancelled']);
  bridge.close();
});

const smallChunkFixture = async size => {
  const metadata = fileCrypto.createFileMetadata({ size, type: 'video/mp4', name: 'video.mp4' });
  const clear = Uint8Array.from({ length: size }, (_, index) => index % 251);
  const { uploadPlainSize } = fileCrypto.fileChunkLayout(metadata);
  const chunks = [];
  for (let offset = 0; offset < size; offset += uploadPlainSize) chunks.push(await fileCrypto.encryptUploadChunk(metadata, chunks.length, clear.slice(offset, offset + uploadPlainSize)));
  return { metadata, clear, wire: Buffer.concat(chunks), url: apiUrl };
};

test('new attachment previews authenticate only 512 KiB for a two-byte range and reuse that block', async () => {
  const file = await smallChunkFixture(2 * 1024 * 1024);
  const bridge = worker(file, (start, end) => file.wire.subarray(start, end + 1));
  await bridge.open();
  assert.deepEqual(Buffer.from(await (await bridge.get({ range: 'bytes=0-1' })).arrayBuffer()), Buffer.from(file.clear.subarray(0, 2)));
  assert.deepEqual(bridge.requests, [[0, 512 * 1024 - 1]]);
  assert.deepEqual(Buffer.from(await (await bridge.get({ range: 'bytes=2-3' })).arrayBuffer()), Buffer.from(file.clear.subarray(2, 4)));
  assert.equal(bridge.requests.length, 1);
  bridge.close();
});

test('new attachment ranges cross independent authentication blocks and handle a partial final block', async () => {
  const file = await smallChunkFixture(1024 * 1024 + 31);
  const plainSize = fileCrypto.fileChunkLayout(file.metadata).plainSize;
  const bridge = worker(file, (start, end) => file.wire.subarray(start, end + 1));
  await bridge.open();
  const start = plainSize - 11;
  const end = file.clear.length - 1;
  assert.deepEqual(Buffer.from(await (await bridge.get({ range: `bytes=${start}-${end}` })).arrayBuffer()), Buffer.from(file.clear.subarray(start)));
  assert.deepEqual(bridge.requests, [[0, file.wire.length - 1]]);
  bridge.close();
});

test('new sequential downloads keep 8 MiB network batches while returning the first authenticated block immediately', async () => {
  const file = { ...await smallChunkFixture(9 * 1024 * 1024), download: true };
  let release;
  const bridge = worker(file, (start, end) => {
    if (start) return file.wire.subarray(start, end + 1);
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(file.wire.subarray(0, 512 * 1024));
        release = () => { controller.enqueue(file.wire.subarray(512 * 1024, end + 1)); controller.close(); };
      }
    }), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${file.wire.length}` } });
  });
  await bridge.open();
  const reader = (await bridge.get()).body.getReader();
  const first = await reader.read();
  assert.equal(first.value.length, 512 * 1024 - 16);
  assert.deepEqual(Buffer.from(first.value), Buffer.from(file.clear.subarray(0, first.value.length)));
  assert.deepEqual(bridge.requests, [[0, 8 * 1024 * 1024 - 1]]);
  release();
  const chunks = [first.value];
  for (;;) { const { value, done } = await reader.read(); if (done) break; chunks.push(value); }
  assert.deepEqual(Buffer.concat(chunks), Buffer.from(file.clear));
  assert.deepEqual(bridge.requests, [[0, 8 * 1024 * 1024 - 1], [8 * 1024 * 1024, file.wire.length - 1]]);
});

test('a new-format range retries an interrupted batch without duplicating plaintext already delivered', async () => {
  const file = await smallChunkFixture(1024 * 1024 + 31);
  let fail;
  let calls = 0;
  const bridge = worker(file, (start, end) => {
    if (++calls > 1) return file.wire.subarray(start, end + 1);
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(file.wire.subarray(0, 512 * 1024));
        fail = () => controller.error(new TypeError('connection interrupted'));
      }
    }), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${file.wire.length}` } });
  });
  await bridge.open();
  const reader = (await bridge.get()).body.getReader();
  const chunks = [(await reader.read()).value];
  fail();
  for (;;) { const { value, done } = await reader.read(); if (done) break; chunks.push(value); }
  assert.deepEqual(Buffer.concat(chunks), Buffer.from(file.clear));
  assert.equal(calls, 2);
  bridge.close();
});

test('new-format batches never return a corrupted block after an earlier authenticated block', async () => {
  const file = await smallChunkFixture(1024 * 1024);
  const wire = Buffer.from(file.wire);
  wire[512 * 1024 + 17] ^= 1;
  const bridge = worker(file, (start, end) => wire.subarray(start, end + 1));
  await bridge.open();
  const reader = (await bridge.get()).body.getReader();
  assert.deepEqual(Buffer.from((await reader.read()).value), Buffer.from(file.clear.subarray(0, 512 * 1024 - 16)));
  await assert.rejects(reader.read(), /encrypted_file_unavailable/);
  bridge.close();
});

test('a new-format 2 GiB attachment can seek to the final partial block', async () => {
  const metadata = fileCrypto.createFileMetadata({ size: 2 * 1024 ** 3, type: 'application/pdf', name: 'large.pdf' });
  const { cipherSize, plainSize } = fileCrypto.fileChunkLayout(metadata);
  const index = Math.floor((metadata.size - 1) / plainSize);
  const clear = Uint8Array.from({ length: metadata.size - index * plainSize }, (_, offset) => offset % 251);
  const wire = await fileCrypto.encryptFileChunk(metadata, index, clear);
  const bridge = worker({ url: apiUrl, metadata }, () => wire);
  await bridge.open();
  assert.deepEqual(Buffer.from(await (await bridge.get({ range: `bytes=${metadata.size - 13}-` })).arrayBuffer()), Buffer.from(clear.subarray(-13)));
  assert.deepEqual(bridge.requests, [[index * cipherSize, index * cipherSize + wire.byteLength - 1]]);
  bridge.close();
});

test('unknown attachment layouts are rejected before any file request', async () => {
  const file = await smallChunkFixture(1);
  const bridge = worker({ ...file, metadata: { ...file.metadata, version: 3 } }, () => file.wire);
  assert.equal((await bridge.open()).error, 'encrypted_file_unavailable');
  assert.equal(bridge.requests.length, 0);
});

test('overlapping new-format ranges share pending blocks when one reader is cancelled', async () => {
  const file = await smallChunkFixture((512 * 1024 - 16) * 3);
  const plainSize = fileCrypto.fileChunkLayout(file.metadata).plainSize;
  let release;
  const bridge = worker(file, (start, end) => start === 0 ? file.wire.subarray(start, end + 1)
    : new Promise(resolve => { release = () => resolve(file.wire.subarray(start, end + 1)); }));
  await bridge.open();
  const abort = new AbortController();
  const firstReader = (await bridge.get({ range: `bytes=${plainSize}-`, signal: abort.signal })).body.getReader();
  const cancelled = firstReader.read().then(() => false, () => true);
  while (!release) await new Promise(resolve => setTimeout(resolve, 0));
  const secondReader = (await bridge.get()).body.getReader();
  const chunks = [(await secondReader.read()).value];
  const secondChunk = secondReader.read();
  await new Promise(resolve => setTimeout(resolve, 0));
  abort.abort();
  release();
  chunks.push((await secondChunk).value);
  for (;;) { const { value, done } = await secondReader.read(); if (done) break; chunks.push(value); }
  assert.equal(await cancelled, true);
  assert.deepEqual(Buffer.concat(chunks), Buffer.from(file.clear));
  assert.deepEqual(bridge.requests, [[512 * 1024, file.wire.length - 1], [0, 512 * 1024 - 1]]);
  bridge.close();
});

test('preview and download reuse authenticated chunks, and the final release discards the cache', async () => {
  const file = await smallChunkFixture(700000);
  const bridge = worker(file, (start, end) => file.wire.subarray(start, end + 1));
  const downloadToken = 'b'.repeat(48), reopenedToken = 'c'.repeat(48);
  await bridge.open();
  await (await bridge.get({ range: 'bytes=0-9' })).arrayBuffer();
  await bridge.open({ ...file, download: true }, downloadToken);
  const result = await (await bridge.get({ capabilityToken: downloadToken })).arrayBuffer();
  assert.deepEqual(Buffer.from(result), Buffer.from(file.clear));
  assert.deepEqual(bridge.requests, [[0, 524287], [524288, file.wire.length - 1]]);
  await (await bridge.get({ range: 'bytes=0-9' })).arrayBuffer();
  assert.equal(bridge.requests.length, 2);
  bridge.close();
  await bridge.open(file, reopenedToken);
  await (await bridge.get({ capabilityToken: reopenedToken, range: 'bytes=0-9' })).arrayBuffer();
  assert.equal(bridge.requests.length, 3);
  bridge.close(reopenedToken);
});

for (const cancel of ['preview', 'download']) test(`cancelling a ${cancel} leaves the other consumer's pending shared fetch running`, async () => {
  const file = await smallChunkFixture(1000);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const bridge = worker(file, async (start, end) => { await gate; return file.wire.subarray(start, end + 1); });
  const downloadToken = 'b'.repeat(48);
  await bridge.open();
  await bridge.open({ ...file, download: true }, downloadToken);
  const reading = (await bridge.get({ range: 'bytes=0-999' })).arrayBuffer().then(value => ({ value }), error => ({ error }));
  const downloading = (await bridge.get({ capabilityToken: downloadToken })).arrayBuffer().then(value => ({ value }), error => ({ error }));
  while (!bridge.requests.length) await new Promise(resolve => setTimeout(resolve, 0));
  bridge.close(cancel === 'preview' ? token : downloadToken);
  release();
  const [previewResult, downloadResult] = await Promise.all([reading, downloading]);
  assert.ok((cancel === 'preview' ? previewResult : downloadResult).error);
  assert.deepEqual(Buffer.from((cancel === 'preview' ? downloadResult : previewResult).value), Buffer.from(file.clear));
  assert.equal(bridge.requests.length, 1);
  bridge.close(); bridge.close(downloadToken);
});

for (const isolation of ['owner', 'session', 'room', 'key']) test(`chunk reuse is isolated by ${isolation}`, async () => {
  const file = await smallChunkFixture(1000), nextFile = await smallChunkFixture(1000);
  const next = isolation === 'key' ? { ...nextFile, url: apiUrl + '2' }
    : isolation === 'room' ? { ...file, url: apiUrl.replace('/room/', '/other-room/') }
    : isolation === 'session' ? { ...file, cacheScope: 'new-device-or-room-key' } : file;
  const bridge = worker(file, (start, end, url) => (isolation === 'key' && url === next.url ? nextFile : file).wire.subarray(start, end + 1));
  await bridge.open();
  await (await bridge.get({ range: 'bytes=0-9' })).arrayBuffer();
  const nextToken = 'b'.repeat(48), nextOwner = isolation === 'owner' ? 'browser-two' : owner;
  await bridge.open(next, nextToken, nextOwner);
  assert.deepEqual(Buffer.from(await (await bridge.get({ range: 'bytes=0-9', capabilityToken: nextToken, capabilityOwner: nextOwner, clientId: nextOwner })).arrayBuffer()), Buffer.from(next.clear.subarray(0, 10)));
  assert.equal(bridge.requests.length, 2);
  bridge.close(); bridge.close(nextToken, nextOwner);
});

test('the global chunk budget evicts old file data across active previews', async () => {
  const file = await fixture(chunkSize);
  const bridge = worker(file, (start, end) => file.wire.subarray(start, end + 1));
  const tokens = ['a', 'b', 'c', 'd', 'e'].map(value => value.repeat(48));
  for (let index = 0; index < tokens.length; index++) {
    await bridge.open({ ...file, cacheScope: `space-${index}` }, tokens[index]);
    await (await bridge.get({ range: 'bytes=0-9', capabilityToken: tokens[index] })).arrayBuffer();
  }
  assert.equal(bridge.requests.length, 5);
  await (await bridge.get({ range: 'bytes=0-9' })).arrayBuffer();
  assert.equal(bridge.requests.length, 6, 'the oldest 8 MiB block must no longer occupy memory');
  for (const capabilityToken of tokens) bridge.close(capabilityToken);
});

test('download progress reports retry waiting and counts overlapping plaintext ranges only once', async () => {
  const file = await smallChunkFixture(1000);
  let attempts = 0;
  const bridge = worker({ ...file, download: true }, (start, end) => ++attempts === 1
    ? new Response(null, { status: 503, headers: { 'Retry-After': '1' } }) : file.wire.subarray(start, end + 1));
  await bridge.open();
  await (await bridge.get({ range: 'bytes=0-9' })).arrayBuffer();
  await (await bridge.get({ range: 'bytes=0-99' })).arrayBuffer();
  const updates = bridge.notifications.filter(message => message.type === 'download-progress');
  assert.ok(updates.some(message => message.retryAt > 0 && message.receivedBytes === 0));
  assert.equal(updates.at(-1).receivedBytes, 100);
  assert.equal(updates.at(-1).totalBytes, 1000);
  assert.ok(updates.at(-1).bytesPerSecond > 0);
  assert.equal(updates.at(-1).retryAt, null);
  assert.equal(bridge.notifications.some(message => message.status === 'delivered'), false, 'range progress must not resolve a download early');
  bridge.close();
});

test('shared ticket refresh uses the surviving capability when the original preview closes', async () => {
  const file = await smallChunkFixture(1000);
  let release, refreshes = 0;
  const freshUrl = apiUrl.replace('ticket', 'b'.repeat(64));
  const bridge = worker(file, (start, end, url) => url === freshUrl
    ? file.wire.subarray(start, end + 1) : new Response(null, { status: 401 }), ReadableStream,
  () => ++refreshes === 1 ? new Promise(resolve => { release = () => resolve(freshUrl); }) : freshUrl);
  await bridge.open();
  const downloadToken = 'b'.repeat(48);
  await bridge.open({ ...file, download: true }, downloadToken);
  const reading = (await bridge.get({ capabilityToken: downloadToken })).arrayBuffer();
  while (!release) await new Promise(resolve => setTimeout(resolve, 0));
  bridge.close();
  release();
  assert.deepEqual(Buffer.from(await reading), Buffer.from(file.clear));
  assert.equal(refreshes, 2);
});
