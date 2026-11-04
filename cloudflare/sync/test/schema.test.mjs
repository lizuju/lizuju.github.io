import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';

async function createRuntime() {
  const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  const roomStart = source.indexOf('export class E2eeSyncRoom');
  const roomEnd = source.indexOf('export class E2eeFileShard');
  const instrumented = source.slice(0, roomStart) + source.slice(roomStart, roomEnd)
    .replace('this.sql = ctx.storage.sql;', 'this.sql = ctx.storage.sql; this.queries = [];')
    .replaceAll('this.sql.exec(', 'this.testExec(')
    .replace('  initializeStorage() {', `  testExec(...args) {
      this.queries.push(args[0]);
      const result = this.sql.exec(...args);
      if (this.failMigration && args[0].includes("VALUES ('schemaVersion',")) throw new Error('injected migration failure');
      return result;
    }
    initializeStorage() {`) + source.slice(roomEnd);
  const runtime = new Miniflare({
    unsafeInspectDurableObjects: true,
    workers: [{ config: {
      name: 'schema-test', compatibilityDate: '2026-10-23',
      manifest: { mainModule: 'harness.js', modules: {
        'index.js': { type: 'esm', contents: instrumented },
        'daily-usage.js': { type: 'esm', contents: await readFile(new URL('../src/daily-usage.js', import.meta.url), 'utf8') },
        'api-version.js': { type: 'esm', contents: await readFile(new URL('../src/api-version.js', import.meta.url), 'utf8') },
        'harness.js': { type: 'esm', contents: `
          import { E2eeSyncRoom as ProductionRoom } from './index.js';
          export default { async fetch(request, env) {
            const { name, method, args } = await request.json();
            return Response.json({value: await env.E2EE_SYNC_ROOMS.getByName(name)[method](...args)});
          } };
          export class Room extends ProductionRoom {
            testQueries() { return this.queries.splice(0); }
            testInitialized() { return this.initialized; }
            async testReclaim() { await this.ctx.storage.deleteAll(); this.initialized = false; }
            testFailure() {
              this.failMigration = true;
              try { this.ctx.storage.transactionSync(() => this.initializeStorage()); }
              catch (error) { return error.message; }
              finally { this.failMigration = false; }
            }
          }
        ` }
      } },
      env: { E2EE_SYNC_ROOMS: { type: 'durable-object', worker: 'schema-test', exportName: 'Room' } },
      exports: { Room: { type: 'durable-object', storage: 'sqlite' } }
    } }]
  });
  await runtime.ready;
  const name = randomUUID();
  const room = new Proxy({}, { get: (_, method) => async (...args) => {
    const response = await runtime.dispatchFetch('https://schema.test/', { method: 'POST', body: JSON.stringify({name, method, args}) });
    assert.equal(response.status, 200);
    return (await response.json()).value;
  } });
  await room.testInitialized();
  const storage = await runtime.unsafeGetDurableObjectStorage('schema-test', 'Room', { name });
  const wake = async () => {
    await runtime.unsafeEvictDurableObject('schema-test', 'Room', { name });
    return room.testInitialized();
  };
  return { runtime, room, storage, wake };
}

test('versioned rooms recover with read-only schema checks and preserve credentials, history and file metadata', async t => {
  const { runtime, room, storage, wake } = await createRuntime(); t.after(() => runtime.dispose());
  const keyId = randomUUID();
  const device = await room.initialize(keyId);
  const createdAt = Date.now();
  await storage.exec('INSERT INTO messages (client_id, device_id, text, created_at) VALUES (?, ?, ?, ?)', 'test-message', device.deviceId, 'encrypted-envelope', createdAt);
  await storage.exec('INSERT INTO files (file_id, device_id, client_id, name, type, size, text, status, created_at, updated_at, reserved_bytes, received_bytes, received_chunks, fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    'test-file', device.deviceId, 'test-upload', 'encrypted-file', 'application/octet-stream', 100, 'encrypted-metadata', 'uploading', createdAt, createdAt, 100, 50, 1, 'fingerprint');
  const before = await Promise.all(['devices', 'messages', 'files', 'metadata'].map(table => storage.exec(`SELECT * FROM ${table}`)));
  assert.equal(await wake(), true);
  const queries = await room.testQueries();
  assert.equal(queries.length, 3);
  assert.ok(queries.every(query => query.startsWith('SELECT')));
  assert.deepEqual(await Promise.all(['devices', 'messages', 'files', 'metadata'].map(table => storage.exec(`SELECT * FROM ${table}`))), before);
  assert.deepEqual(await room.keyState(), { currentKeyId: keyId, rekeyRequired: false });
  assert.equal((await room.storageUsage()).reservedBytes, 100);
});

test('legacy schemas migrate once without losing existing encrypted rows or resetting activity', async t => {
  const { runtime, room, storage, wake } = await createRuntime(); t.after(() => runtime.dispose());
  const device = await room.initialize(randomUUID());
  const activeAt = Date.now() - 1000;
  await storage.exec("DELETE FROM metadata WHERE key = 'schemaVersion'");
  await storage.exec("UPDATE metadata SET value = ? WHERE key = 'lastActiveAt'", String(activeAt));
  await storage.exec('ALTER TABLE files DROP COLUMN fingerprint');
  await storage.exec('ALTER TABLE gomoku_games DROP COLUMN base_score');
  await storage.exec('INSERT INTO messages (client_id, device_id, text, created_at) VALUES (?, ?, ?, ?)', 'legacy-message', device.deviceId, 'legacy-encrypted-envelope', activeAt);
  assert.equal(await wake(), true);
  assert.ok((await room.testQueries()).some(query => query.startsWith('ALTER TABLE')));
  assert.equal((await storage.exec("SELECT value FROM metadata WHERE key = 'lastActiveAt'"))[0].value, String(activeAt));
  assert.equal((await storage.exec('SELECT text FROM messages'))[0].text, 'legacy-encrypted-envelope');
  assert.ok((await storage.exec('PRAGMA table_info(files)')).some(column => column.name === 'fingerprint'));
  assert.ok((await storage.exec('PRAGMA table_info(gomoku_games)')).some(column => column.name === 'base_score'));
  assert.equal((await storage.exec("SELECT value FROM metadata WHERE key = 'schemaVersion'")).length, 1);
  await wake();
  assert.ok((await room.testQueries()).every(query => query.startsWith('SELECT')));
});

test('failed migrations roll back the version marker and schema changes so the next wake retries', async t => {
  const { runtime, room, storage, wake } = await createRuntime(); t.after(() => runtime.dispose());
  await room.initialize(randomUUID());
  await storage.exec("DELETE FROM metadata WHERE key = 'schemaVersion'");
  await storage.exec('ALTER TABLE files DROP COLUMN fingerprint');
  assert.equal(await room.testFailure(), 'injected migration failure');
  assert.deepEqual(await storage.exec("SELECT value FROM metadata WHERE key = 'schemaVersion'"), []);
  assert.equal((await storage.exec('PRAGMA table_info(files)')).some(column => column.name === 'fingerprint'), false);
  assert.equal(await wake(), true);
  assert.ok((await storage.exec('PRAGMA table_info(files)')).some(column => column.name === 'fingerprint'));
});

test('stale requests cannot recreate tables after a room is reclaimed', async t => {
  const { runtime, room, storage, wake } = await createRuntime(); t.after(() => runtime.dispose());
  await room.initialize(randomUUID());
  await room.testReclaim();
  assert.equal(await wake(), false);
  assert.deepEqual(await room.addDevice(), { error: 'not_found', status: 404 });
  assert.deepEqual(await room.storageUsage(), { bytes: 0, reservedBytes: 0, oldestAt: null, deletingFiles: 0 });
  assert.deepEqual(await storage.exec("SELECT name FROM sqlite_master WHERE name IN ('devices', 'metadata', 'messages', 'files')"), []);
});
