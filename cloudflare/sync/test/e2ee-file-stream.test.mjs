import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { MessageChannel } from 'node:worker_threads';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../../../static/portfolio/sync-e2ee-worker.js', import.meta.url), 'utf8');
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
const worker = (descriptor, getBytes) => {
  descriptor = { ...descriptor, expiresAt: descriptor.download ? Date.now() + 60000 : null };
  const handlers = new Map();
  const requests = [];
  let alive = true;
  let resolutions = 0;
  const client = {
    id: owner, type: 'window', url: 'https://site.test/portfolio/',
    postMessage(message, ports) {
      if (message.type === 'released') { alive = false; return; }
      if (message.type === 'download-state') { descriptor.expiresAt = message.expiresAt; return; }
      assert.equal(message.type, 'resolve');
      resolutions++;
      ports[0].postMessage(alive && message.token === token ? descriptor : null);
    }
  };
  const scope = 'https://site.test/portfolio/';
  vm.runInNewContext(source, {
    self: { registration: { scope }, location: new URL(scope), addEventListener: (name, callback) => handlers.set(name, callback), clients: { get: async id => id === owner ? client : null } },
    URL, crypto: webcrypto, atob, TextEncoder, Response, Headers, ReadableStream, AbortController, MessageChannel, setTimeout, clearTimeout,
    async fetch(url, options) {
      if (String(url) === `${scope}sync-config.json`) return Response.json({ apiBase: 'https://sync.test' });
      assert.equal(String(url), apiUrl);
      assert.equal(options.credentials, 'omit');
      const range = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);
      assert.ok(range);
      const start = Number(range[1]);
      const end = Number(range[2]);
      requests.push([start, end]);
      assert.ok(end - start + 1 <= 8 * 1024 * 1024);
      const total = descriptor.metadata.size + Math.ceil(descriptor.metadata.size / chunkSize) * 16;
      return new Response(await getBytes(start, end), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${total}` } });
    }
  });
  return {
    requests,
    get resolutions() { return resolutions; },
    close() { alive = false; handlers.get('message')({ data: { source: 'gavin-sync-e2ee', type: 'close', token }, source: client }); },
    async open(value = descriptor) {
      let pending;
      let result;
      handlers.get('message')({
        data: { source: 'gavin-sync-e2ee', type: 'open', token, descriptor: value }, source: client,
        ports: [{ postMessage(value) { result = value; } }], waitUntil(value) { pending = value; }
      });
      await pending;
      return result;
    },
    async get({ method = 'GET', range, clientId = owner } = {}) {
      let response;
      const url = `${scope}__sync-e2ee__/${owner}/${token}`;
      handlers.get('fetch')({ request: new Request(url, { method, headers: range ? { Range: range } : {} }), clientId, respondWith(value) { response = value; } });
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
