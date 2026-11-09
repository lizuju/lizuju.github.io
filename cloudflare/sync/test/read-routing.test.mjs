import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';

const source = (await readFile(new URL('../src/index.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '')
  .replace('export default {', 'globalThis.worker = {')
  .replaceAll('export class ', 'class ');

test('read routes share only positive existence results briefly and invalidate missing rooms', async () => {
  let now = Date.now();
  const context = { DurableObject: class {}, Response, URL, Date: { now: () => now } };
  vm.runInNewContext(source, context);
  let lookups = 0, reads = 0, exists = true, status = 200;
  const env = {
    E2EE_PAIRING_REGISTRY: { getByName: () => ({ hasRoom: async () => { lookups++; return exists; } }) },
    E2EE_SYNC_ROOMS: { getByName: () => ({ fetch: async () => { reads++; return Response.json({}, { status }); } }) }
  };
  const room = randomUUID();
  const request = (suffix = '/messages', method = 'GET', id = room) => context.worker.route(new Request(`https://sync.test/v1/spaces/${id}${suffix}`, { method }), env);
  for (let i = 0; i < 100; i++) assert.equal((await request()).status, 200);
  for (const suffix of ['/devices', '/key-grants', '/files/1']) assert.equal((await request(suffix)).status, 200);
  assert.equal((await request('/files/1/download', 'POST')).status, 200);
  assert.equal(lookups, 1);
  assert.equal(reads, 104);
  now += 60000;
  assert.equal((await request()).status, 200);
  assert.equal(lookups, 2);
  status = 404;
  assert.equal((await request()).status, 404);
  exists = false;
  assert.equal((await request()).status, 404);
  assert.equal((await request()).status, 404);
  assert.equal(lookups, 4);
  const previousReads = reads;
  assert.equal((await request('/devices', 'GET', randomUUID())).status, 404);
  assert.equal(reads, previousReads);
});
