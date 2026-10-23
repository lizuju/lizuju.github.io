import { DurableObject } from 'cloudflare:workers';

const INVITE_LIFETIME = 10 * 60 * 1000;
const MESSAGE_LIFETIME = 5 * 24 * 60 * 60 * 1000;
const STORAGE_HIGH_WATER = 4_700_000_000;
const STORAGE_CLEANUP_BYTES = 3_000_000_000;
const MESSAGE_WRITE_HEADROOM = 128 * 1024;
const FILE_SIZE_LIMIT = 2 * 1024 * 1024 * 1024;
const FILE_CHUNK_SIZE = 8 * 1024 * 1024;
const FILE_SHARD_SIZE = 64 * 1024 * 1024;
const BLOB_CHUNK_SIZE = 1024 * 1024;
const UPLOAD_LIFETIME = 24 * 60 * 60 * 1000;
const DOWNLOAD_LIFETIME = 24 * 60 * 60 * 1000;
const ROOM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function json(data, status = 200, headers = {}) {
  return Response.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store', ...headers }
  });
}

async function hash(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

function credential() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function readBytes(request, maximum) {
  if (!request.body || Number(request.headers.get('Content-Length')) > maximum) return { error: 'request_too_large', status: 413 };
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximum) {
      await reader.cancel();
      return { error: 'request_too_large', status: 413 };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return { bytes: bytes.buffer };
}

function fileReserve(size) {
  return size + Math.ceil(size / FILE_CHUNK_SIZE) * 65536 + 65536;
}

function publicMessage({ attachment, ...message }) {
  return attachment ? { ...message, attachment: JSON.parse(attachment) } : message;
}

async function readJson(request, maximum = 1024) {
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    return { error: 'invalid_json', status: 400 };
  }
  const reader = request.body?.getReader();
  if (!reader) return { error: 'invalid_json', status: 400 };
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximum) {
      await reader.cancel();
      return { error: 'request_too_large', status: 413 };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { error: 'invalid_json', status: 400 };
    }
    return { value };
  } catch {
    return { error: 'invalid_json', status: 400 };
  }
}

function resultResponse(result, status = 200) {
  if (!result.error) return json(result, status);
  const headers = result.retryAfter ? { 'Retry-After': String(result.retryAfter) } : {};
  return json({ error: result.error }, result.status, headers);
}

export default {
  async scheduled(event, env) {
    await env.PAIRING_REGISTRY.getByName('registry').maintainRooms();
  },

  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const allowedOrigins = env.ALLOWED_ORIGINS.split(',').map(value => value.trim());
    if (origin && !allowedOrigins.includes(origin)) return json({ error: 'origin_not_allowed' }, 403);

    const corsHeaders = {
      'Vary': 'Origin',
      'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, Range, If-Range',
      'Access-Control-Expose-Headers': 'Retry-After, Content-Disposition, Accept-Ranges, Content-Range, Content-Length, ETag, Last-Modified',
      'Access-Control-Max-Age': '86400'
    };
    if (origin) corsHeaders['Access-Control-Allow-Origin'] = origin;

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });

    let response = await this.route(request, env);
    if (response.status === 101) return response;
    response = new Response(response.body, response);
    for (const [key, value] of Object.entries(corsHeaders)) response.headers.set(key, value);
    return response;
  },

  async route(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') return json({ ok: true });

    const registry = env.PAIRING_REGISTRY.getByName('registry');
    if (request.method === 'POST' && url.pathname === '/v1/spaces') {
      const ipHash = await hash(request.headers.get('CF-Connecting-IP') || 'local');
      const limit = await registry.takeLimit(`create:${ipHash}`, 5, 60 * 60 * 1000);
      if (limit.error) return resultResponse(limit);
      return resultResponse(await registry.createSpace(), 201);
    }

    if (request.method === 'POST' && url.pathname === '/v1/pair') {
      const ipHash = await hash(request.headers.get('CF-Connecting-IP') || 'local');
      const limit = await registry.takeLimit(`pair:${ipHash}`, 5, INVITE_LIFETIME);
      if (limit.error) return resultResponse(limit);
      const body = await readJson(request);
      if (body.error) return resultResponse(body);
      if (typeof body.value.code !== 'string' || !/^\d{4}$/.test(body.value.code)) {
        return json({ error: 'invalid_code' }, 400);
      }
      return resultResponse(await registry.joinSpace(body.value.code));
    }

    const match = url.pathname.match(/^\/v1\/spaces\/([^/]+)(\/pair-code|\/messages|\/socket|\/device|\/devices(?:\/([^/]+))?|\/files(?:\/.*)?|\/downloads\/[0-9a-f]{64})?$/);
    if (!match || !ROOM_ID.test(match[1]) || (match[3] && !ROOM_ID.test(match[3]))) return json({ error: 'not_found' }, 404);
    const roomId = match[1];
    if (!await registry.hasRoom(roomId)) return json({ error: 'not_found' }, 404);
    const room = env.SYNC_ROOMS.getByName(roomId);
    if (request.method === 'GET' && match[2] === '/socket') {
      const ipHash = await hash(request.headers.get('CF-Connecting-IP') || 'local');
      const limit = await registry.takeLimit(`socket:${ipHash}`, 30, INVITE_LIFETIME);
      if (limit.error) return resultResponse(limit);
      return room.fetch(request);
    }
    if (['GET', 'HEAD'].includes(request.method) && match[2]?.startsWith('/downloads/')) return room.fetch(request);
    const token = request.headers.get('Authorization')?.match(/^Bearer ([0-9a-f]{64})$/)?.[1];
    const deviceId = token ? await room.authorize(token) : null;
    if (!deviceId) return json({ error: 'unauthorized' }, 401);

    if (request.method === 'POST' && match[2] === '/files/uploads') {
      const body = await readJson(request, 65536);
      if (body.error) return resultResponse(body);
      const file = body.value;
      if (typeof file.clientId !== 'string' || !ROOM_ID.test(file.clientId)) return json({ error: 'invalid_client_id' }, 400);
      if (typeof file.name !== 'string' || !file.name || file.name.length > 255 || /[\x00-\x1f\x7f/\\]/.test(file.name)) return json({ error: 'invalid_file_name' }, 400);
      if (typeof file.type !== 'string' || file.type.length > 255 || (file.type && !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(file.type))) return json({ error: 'invalid_file_type' }, 400);
      if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > FILE_SIZE_LIMIT) return json({ error: 'file_too_large' }, 413);
      if (file.text === undefined) file.text = '';
      if (typeof file.text !== 'string' || file.text.length > 10000) return json({ error: 'invalid_text' }, 400);
      file.type ||= 'application/octet-stream';
      const result = await registry.prepareUpload(roomId, deviceId, file);
      const { created, ...response } = result;
      return resultResponse(response, created ? 201 : 200);
    }
    const upload = match[2]?.match(/^\/files\/uploads\/([^/]+)(?:\/chunks\/(0|[1-9][0-9]*)|\/(complete))?$/);
    if (upload && ROOM_ID.test(upload[1])) {
      let result;
      if (request.method === 'PUT' && upload[2] !== undefined) {
        const body = await readBytes(request, FILE_CHUNK_SIZE);
        if (body.error) return resultResponse(body);
        result = await room.writeFileChunk(deviceId, upload[1], Number(upload[2]), body.bytes);
      } else if (request.method === 'POST' && upload[3]) {
        result = await room.completeUpload(deviceId, upload[1]);
      } else if (request.method === 'DELETE' && !upload[2] && !upload[3]) {
        result = await room.cancelUpload(deviceId, upload[1]);
      } else return json({ error: 'not_found' }, 404);
      await registry.refreshRoom(roomId);
      if (result.message) return json(result.message, result.created ? 201 : 200);
      return resultResponse(result);
    }
    const file = match[2]?.match(/^\/files\/([1-9][0-9]*)(\/download)?$/);
    if (file) {
      await registry.refreshRoom(roomId);
      if (request.method === 'POST' && file[2]) return resultResponse(await room.issueDownload(deviceId, file[1]));
      if (['GET', 'HEAD'].includes(request.method) && !file[2]) return room.fetch(request);
    }
    if (request.method === 'GET' && match[2] === '/devices') {
      return resultResponse(await room.listDevices(deviceId));
    }
    if (request.method === 'PATCH' && match[3]) {
      const body = await readJson(request);
      if (body.error) return resultResponse(body);
      if (typeof body.value.name !== 'string' || Array.from(body.value.name.trim()).length > 24) return json({ error: 'invalid_name' }, 400);
      const result = await room.renameDevice(deviceId, match[3], body.value.name.trim());
      await registry.refreshRoom(roomId);
      return resultResponse(result);
    }
    if (request.method === 'DELETE' && match[3]) {
      const result = await room.removeDevice(match[3], deviceId);
      await registry.refreshRoom(roomId);
      return resultResponse(result);
    }
    if (request.method === 'GET' && !match[2]) {
      await registry.refreshRoom(roomId);
      const info = await room.info();
      if (!info) return json({ error: 'not_found' }, 404);
      return json({ roomId, deviceId, ...info, pairing: await registry.currentInvite(roomId) });
    }
    if (request.method === 'POST' && match[2] === '/pair-code') {
      const invite = await registry.createInvite(roomId);
      if (invite.error) return resultResponse(invite);
      await room.publishPairing(roomId);
      return resultResponse(invite);
    }
    if (request.method === 'POST' && match[2] === '/messages') {
      const body = await readJson(request, 65536);
      if (body.error) return resultResponse(body);
      const { clientId, text } = body.value;
      if (typeof clientId !== 'string' || !ROOM_ID.test(clientId)) return json({ error: 'invalid_client_id' }, 400);
      if (typeof text !== 'string' || !text.trim() || text.length > 10000) return json({ error: 'invalid_text' }, 400);
      const result = await registry.storeMessage(roomId, deviceId, clientId, text);
      if (result.error) return resultResponse(result);
      return json(result.message, result.created ? 201 : 200);
    }
    if (request.method === 'DELETE' && match[2] === '/messages') {
      const result = await room.clearMessages(deviceId);
      await registry.refreshRoom(roomId);
      return resultResponse(result);
    }
    if (request.method === 'DELETE' && match[2] === '/device') {
      const result = await room.removeDevice(deviceId);
      await registry.refreshRoom(roomId);
      return resultResponse(result);
    }
    return json({ error: 'not_found' }, 404);
  }
};

export class PairingRegistry extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS invites (code TEXT PRIMARY KEY, room_id TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS invites_expiry ON invites(expires_at)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS attempts_expiry ON attempts(expires_at)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS room_usage (room_id TEXT PRIMARY KEY, bytes INTEGER NOT NULL, oldest_at INTEGER, deleting_files INTEGER)');
    if (!this.sql.exec('PRAGMA table_info(room_usage)').toArray().some(column => column.name === 'deleting_files')) {
      this.sql.exec('ALTER TABLE room_usage ADD COLUMN deleting_files INTEGER');
    }
    this.sql.exec('CREATE TABLE IF NOT EXISTS cleanup (id INTEGER PRIMARY KEY CHECK(id = 1), phase TEXT NOT NULL, cursor TEXT NOT NULL, target_bytes INTEGER)');
  }

  rememberUsage(roomId, usage) {
    this.sql.exec(
      'INSERT INTO room_usage (room_id, bytes, oldest_at, deleting_files) VALUES (?, ?, ?, ?) ON CONFLICT(room_id) DO UPDATE SET bytes = excluded.bytes, oldest_at = excluded.oldest_at, deleting_files = excluded.deleting_files',
      roomId, usage.bytes, usage.oldestAt, usage.deletingFiles
    );
  }

  hasRoom(roomId) {
    return this.sql.exec('SELECT 1 FROM room_usage WHERE room_id = ?', roomId).toArray().length !== 0;
  }

  storageBytes() {
    return this.sql.databaseSize + this.sql.exec('SELECT coalesce(sum(bytes), 0) AS bytes FROM room_usage').one().bytes;
  }

  async resumeCleanup() {
    if (this.sql.exec('SELECT 1 FROM cleanup WHERE id = 1').toArray().length && await this.ctx.storage.getAlarm() === null) {
      await this.ctx.storage.setAlarm(Date.now() + 1000);
    }
  }

  async maintainRooms() {
    return this.ctx.blockConcurrencyWhile(async () => {
      this.sql.exec("INSERT OR IGNORE INTO cleanup (id, phase, cursor) VALUES (1, 'refresh', '')");
      await this.resumeCleanup();
    });
  }

  async refreshRoom(roomId) {
    return this.ctx.blockConcurrencyWhile(async () => { await this.refreshUsage(roomId); });
  }

  async refreshUsage(roomId) {
    if (!this.hasRoom(roomId)) return null;
    const room = this.env.SYNC_ROOMS.getByName(roomId);
    const usage = await room.maintain(roomId);
    if (usage.oldestAt === null && !this.currentInvite(roomId) && await room.reclaimIfEmpty()) {
      this.sql.exec('DELETE FROM invites WHERE room_id = ?', roomId);
      this.sql.exec('DELETE FROM room_usage WHERE room_id = ?', roomId);
      return null;
    }
    this.rememberUsage(roomId, usage);
    return usage;
  }

  async joinSpace(code) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const invite = this.findInvite(code);
      if (invite.error) return invite;
      if (!this.hasRoom(invite.roomId)) return { error: 'code_expired', status: 404 };
      const device = await this.env.SYNC_ROOMS.getByName(invite.roomId).addDevice();
      if (device.error) return device;
      await this.refreshUsage(invite.roomId);
      return { roomId: invite.roomId, ...device, pairing: this.currentInvite(invite.roomId) };
    });
  }

  async createSpace() {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (this.storageBytes() + MESSAGE_WRITE_HEADROOM >= STORAGE_HIGH_WATER) {
        if (!this.sql.exec('SELECT 1 FROM room_usage WHERE oldest_at IS NOT NULL LIMIT 1').toArray().length) {
          return { error: 'storage_full', status: 507 };
        }
        this.sql.exec("INSERT OR IGNORE INTO cleanup (id, phase, cursor) VALUES (1, 'refresh', '')");
        await this.resumeCleanup();
        return { error: 'storage_cleaning', status: 503, retryAfter: 1 };
      }
      const roomId = crypto.randomUUID();
      this.rememberUsage(roomId, { bytes: MESSAGE_WRITE_HEADROOM, oldestAt: null, deletingFiles: 0 });
      const room = this.env.SYNC_ROOMS.getByName(roomId);
      const device = await room.initialize();
      this.rememberUsage(roomId, await room.maintain(roomId));
      const invite = this.createInvite(roomId);
      if (invite.error) return invite;
      return { roomId, ...device, ...invite, pairing: invite };
    });
  }

  async storeMessage(roomId, deviceId, clientId, text) {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (!this.hasRoom(roomId)) return { error: 'not_found', status: 404 };
      const room = this.env.SYNC_ROOMS.getByName(roomId);
      this.rememberUsage(roomId, await room.maintain(roomId));
      const existing = await room.findMessage(deviceId, clientId);
      if (existing) return existing;
      if (this.storageBytes() + MESSAGE_WRITE_HEADROOM >= STORAGE_HIGH_WATER) {
        if (!this.sql.exec('SELECT 1 FROM room_usage WHERE oldest_at IS NOT NULL LIMIT 1').toArray().length) {
          return { error: 'storage_full', status: 507 };
        }
        this.sql.exec("INSERT OR IGNORE INTO cleanup (id, phase, cursor) VALUES (1, 'refresh', '')");
        await this.resumeCleanup();
        return { error: 'storage_cleaning', status: 503, retryAfter: 1 };
      }
      const result = await room.addMessage(deviceId, clientId, text);
      this.rememberUsage(roomId, await room.storageUsage());
      return result;
    });
  }

  async prepareUpload(roomId, deviceId, file) {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (!this.hasRoom(roomId)) return { error: 'not_found', status: 404 };
      const room = this.env.SYNC_ROOMS.getByName(roomId);
      const usage = await room.maintain(roomId);
      this.rememberUsage(roomId, usage);
      const existing = await room.findMessage(deviceId, file.clientId);
      if (existing) return existing;
      const upload = await room.uploadInfo(deviceId, file.clientId);
      if (upload) return upload;
      const reserve = fileReserve(file.size);
      if (this.storageBytes() + reserve >= STORAGE_HIGH_WATER) {
        if (!this.sql.exec('SELECT 1 FROM room_usage WHERE oldest_at IS NOT NULL LIMIT 1').toArray().length) return { error: 'storage_full', status: 507 };
        this.sql.exec("INSERT OR IGNORE INTO cleanup (id, phase, cursor) VALUES (1, 'refresh', '')");
        // A refresh remembers the pending reservation until actual usage is checked.
        this.sql.exec("UPDATE cleanup SET target_bytes = max(coalesce(target_bytes, 0), ?) WHERE id = 1 AND phase = 'refresh'", reserve);
        await this.resumeCleanup();
        return { error: 'storage_cleaning', status: 503, retryAfter: 1 };
      }
      this.rememberUsage(roomId, { ...usage, bytes: usage.bytes + reserve });
      const result = await room.beginUpload(deviceId, file);
      this.rememberUsage(roomId, await room.storageUsage());
      return result;
    });
  }

  async alarm() {
    await this.ctx.blockConcurrencyWhile(async () => {
      let state = this.sql.exec('SELECT phase, cursor, target_bytes FROM cleanup WHERE id = 1').toArray()[0];
      if (!state) return;
      if (state.phase === 'refresh') {
        const rooms = this.sql.exec('SELECT room_id FROM room_usage WHERE room_id > ? ORDER BY room_id LIMIT 10', state.cursor).toArray();
        for (const { room_id: roomId } of rooms) {
          await this.refreshUsage(roomId);
        }
        if (rooms.length === 10) {
          this.sql.exec('UPDATE cleanup SET cursor = ? WHERE id = 1', rooms[9].room_id);
          await this.ctx.storage.setAlarm(Date.now() + 1000);
          return;
        }
        const total = this.storageBytes();
        if (total + Math.max(MESSAGE_WRITE_HEADROOM, state.target_bytes || 0) < STORAGE_HIGH_WATER) {
          this.sql.exec('DELETE FROM cleanup');
          return;
        }
        state = { phase: 'prune', target_bytes: Math.max(0, total - STORAGE_CLEANUP_BYTES) };
        this.sql.exec("UPDATE cleanup SET phase = 'prune', target_bytes = ? WHERE id = 1", state.target_bytes);
        await this.ctx.storage.setAlarm(Date.now() + 1000);
        return;
      }
      for (let batch = 0; batch < 10 && this.storageBytes() > state.target_bytes; batch += 1) {
        // Older room snapshots must be refreshed before deciding which history to prune.
        const pending = this.sql.exec('SELECT room_id FROM room_usage WHERE deleting_files IS NULL OR deleting_files > 0 ORDER BY oldest_at, room_id LIMIT 1').toArray()[0];
        if (pending) {
          await this.refreshUsage(pending.room_id);
          continue;
        }
        const oldest = this.sql.exec('SELECT room_id, oldest_at FROM room_usage WHERE oldest_at IS NOT NULL ORDER BY oldest_at, room_id LIMIT 1').toArray()[0];
        if (!oldest) break;
        const room = this.env.SYNC_ROOMS.getByName(oldest.room_id);
        const usage = await this.refreshUsage(oldest.room_id);
        if (!usage) continue;
        if (this.storageBytes() <= state.target_bytes) break;
        if (usage.deletingFiles) continue;
        const first = this.sql.exec('SELECT room_id, oldest_at FROM room_usage WHERE oldest_at IS NOT NULL ORDER BY oldest_at, room_id LIMIT 2').toArray();
        if (first[0]?.room_id !== oldest.room_id) continue;
        this.rememberUsage(oldest.room_id, await room.pruneOldest(first[1]?.oldest_at ?? Number.MAX_SAFE_INTEGER));
      }
      if (this.storageBytes() <= state.target_bytes || !this.sql.exec('SELECT 1 FROM room_usage WHERE oldest_at IS NOT NULL LIMIT 1').toArray().length) {
        this.sql.exec('DELETE FROM cleanup');
      } else {
        await this.ctx.storage.setAlarm(Date.now() + 1000);
      }
    });
  }

  takeLimit(key, maximum, lifetime) {
    const now = Date.now();
    this.sql.exec('DELETE FROM attempts WHERE expires_at <= ?', now);
    const existing = this.sql.exec('SELECT count, expires_at FROM attempts WHERE key = ?', key).toArray()[0];
    if (existing && existing.count >= maximum) {
      return { error: 'rate_limited', status: 429, retryAfter: Math.max(1, Math.ceil((existing.expires_at - now) / 1000)) };
    }
    this.sql.exec(
      'INSERT INTO attempts (key, count, expires_at) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = count + 1',
      key, now + lifetime
    );
    return { ok: true };
  }

  createInvite(roomId) {
    if (!this.hasRoom(roomId)) return { error: 'not_found', status: 404 };
    const existing = this.currentInvite(roomId);
    if (existing) return existing;
    const now = Date.now();
    this.sql.exec('DELETE FROM invites WHERE expires_at <= ?', now);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 10000).padStart(4, '0');
      if (this.sql.exec('SELECT 1 FROM invites WHERE code = ?', code).toArray().length) continue;
      this.sql.exec('DELETE FROM invites WHERE room_id = ?', roomId);
      const expiresAt = now + INVITE_LIFETIME;
      this.sql.exec('INSERT INTO invites (code, room_id, expires_at) VALUES (?, ?, ?)', code, roomId, expiresAt);
      return { code, expiresAt };
    }
    return { error: 'codes_busy', status: 503, retryAfter: 60 };
  }

  currentInvite(roomId) {
    return this.sql.exec('SELECT code, expires_at AS expiresAt FROM invites WHERE room_id = ? AND expires_at > ?', roomId, Date.now()).toArray()[0] || null;
  }

  findInvite(code) {
    const invite = this.sql.exec('SELECT room_id, expires_at FROM invites WHERE code = ?', code).toArray()[0];
    if (!invite || invite.expires_at <= Date.now()) return { error: 'code_expired', status: 404 };
    return { roomId: invite.room_id };
  }
}

export class SyncRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.pairingQueue = Promise.resolve();
    // Stale requests can wake reclaimed objects; only initialize may create their tables.
    this.initialized = this.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'devices'").toArray().length !== 0;
    if (this.initialized) this.initializeStorage();
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  initializeStorage() {
    this.sql.exec("CREATE TABLE IF NOT EXISTS devices (token_hash TEXT PRIMARY KEY, device_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, name TEXT NOT NULL DEFAULT '')");
    if (!this.sql.exec('PRAGMA table_info(devices)').toArray().some(column => column.name === 'name')) {
      this.sql.exec("ALTER TABLE devices ADD COLUMN name TEXT NOT NULL DEFAULT ''");
    }
    this.sql.exec('CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id TEXT NOT NULL, device_id TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL, attachment TEXT, UNIQUE(device_id, client_id))');
    if (!this.sql.exec('PRAGMA table_info(messages)').toArray().some(column => column.name === 'attachment')) this.sql.exec('ALTER TABLE messages ADD COLUMN attachment TEXT');
    this.sql.exec('CREATE INDEX IF NOT EXISTS messages_expiry ON messages(created_at)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS files (file_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, client_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, message_id INTEGER, reserved_bytes INTEGER NOT NULL, UNIQUE(device_id, client_id))');
    this.sql.exec('CREATE TABLE IF NOT EXISTS file_shards (file_id TEXT NOT NULL, shard_index INTEGER NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY(file_id, shard_index))');
    this.sql.exec('CREATE TABLE IF NOT EXISTS file_upload_chunks (file_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, size INTEGER NOT NULL, received INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(file_id, chunk_index))');
    this.sql.exec('CREATE TABLE IF NOT EXISTS download_tickets (ticket TEXT PRIMARY KEY, file_id TEXT NOT NULL, device_id TEXT NOT NULL, expires_at INTEGER NOT NULL)');
    this.sql.exec("CREATE TRIGGER IF NOT EXISTS delete_message_files AFTER DELETE ON messages BEGIN UPDATE files SET status = 'deleting', reserved_bytes = 0 WHERE message_id = OLD.id; END");
    this.initialized = true;
  }

  async initialize() {
    this.initializeStorage();
    this.sql.exec('INSERT INTO metadata (key, value) VALUES (?, ?)', 'createdAt', String(Date.now()));
    return this.addDevice();
  }

  async addDevice() {
    if (!this.initialized) return { error: 'not_found', status: 404 };
    const token = credential();
    const deviceId = crypto.randomUUID();
    this.sql.exec('INSERT INTO devices (token_hash, device_id, created_at) VALUES (?, ?, ?)', await hash(token), deviceId, Date.now());
    this.broadcast({ type: 'devices' });
    return { token, deviceId };
  }

  async authorize(token) {
    const tokenHash = await hash(token);
    if (!this.initialized) return null;
    return this.sql.exec('SELECT device_id FROM devices WHERE token_hash = ?', tokenHash).toArray()[0]?.device_id || null;
  }

  listDevices(deviceId) {
    if (!this.initialized || !this.sql.exec('SELECT 1 FROM devices WHERE device_id = ?', deviceId).toArray().length) {
      return { error: 'unauthorized', status: 401 };
    }
    return {
      deviceId,
      devices: this.sql.exec('SELECT device_id AS deviceId, name, created_at AS createdAt FROM devices ORDER BY created_at, device_id').toArray()
    };
  }

  renameDevice(deviceId, targetDeviceId, name) {
    if (!this.initialized || !this.sql.exec('SELECT 1 FROM devices WHERE device_id = ?', deviceId).toArray().length) {
      return { error: 'unauthorized', status: 401 };
    }
    if (!this.sql.exec('UPDATE devices SET name = ? WHERE device_id = ? RETURNING device_id', name, targetDeviceId).toArray().length) {
      return { error: 'device_not_found', status: 404 };
    }
    this.broadcast({ type: 'devices' });
    return { ok: true };
  }

  info() {
    if (!this.initialized) return null;
    return {
      createdAt: Number(this.sql.exec('SELECT value FROM metadata WHERE key = ?', 'createdAt').one().value),
      messages: this.messages()
    };
  }

  messages() {
    if (!this.initialized) return [];
    return this.sql.exec('SELECT id, client_id AS clientId, device_id AS deviceId, text, created_at AS createdAt, attachment FROM messages ORDER BY id').toArray().map(publicMessage);
  }

  storageUsage() {
    if (!this.initialized) return { bytes: 0, oldestAt: null, deletingFiles: 0 };
    return {
      bytes: this.sql.databaseSize + this.sql.exec('SELECT coalesce(sum(bytes), 0) AS bytes FROM file_shards').one().bytes + this.sql.exec('SELECT coalesce(sum(reserved_bytes), 0) AS bytes FROM files').one().bytes,
      oldestAt: this.sql.exec("SELECT min(created_at) AS oldest_at FROM (SELECT created_at FROM messages UNION ALL SELECT created_at FROM files WHERE status IN ('uploading', 'deleting'))").one().oldest_at,
      deletingFiles: this.sql.exec("SELECT count(*) AS count FROM files WHERE status = 'deleting'").one().count
    };
  }

  pruneExpired() {
    if (!this.initialized) return 0;
    const deleted = this.sql.exec('DELETE FROM messages WHERE created_at <= ? RETURNING id', Date.now() - MESSAGE_LIFETIME).toArray();
    if (deleted.length) this.broadcast({ type: 'history', messages: this.messages() });
    this.sql.exec("UPDATE files SET status = 'deleting', reserved_bytes = 0 WHERE status = 'uploading' AND updated_at <= ?", Date.now() - UPLOAD_LIFETIME);
    this.sql.exec('DELETE FROM download_tickets WHERE expires_at <= ?', Date.now());
    return deleted.length;
  }

  async maintain(roomId) {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (!this.initialized) return this.storageUsage();
      if (roomId) this.sql.exec('INSERT OR IGNORE INTO metadata (key, value) VALUES (?, ?)', 'roomId', roomId);
      this.pruneExpired();
      await this.cleanupFiles();
      await this.scheduleAlarm();
      return this.storageUsage();
    });
  }

  async reclaimIfEmpty() {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (this.initialized && this.sql.exec('SELECT 1 FROM devices UNION ALL SELECT 1 FROM messages UNION ALL SELECT 1 FROM files UNION ALL SELECT 1 FROM file_shards UNION ALL SELECT 1 FROM file_upload_chunks LIMIT 1').toArray().length) return false;
      for (const socket of this.ctx.getWebSockets()) {
        if (socket.readyState !== WebSocket.OPEN) continue;
        socket.serializeAttachment({ closing: true });
        socket.close(4001, 'Space expired');
      }
      this.initialized = false;
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      return true;
    });
  }

  async pruneOldest(before = Number.MAX_SAFE_INTEGER) {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (!this.initialized) return this.storageUsage();
      const items = this.sql.exec("SELECT id AS messageId, NULL AS uploadId, created_at AS createdAt, attachment IS NOT NULL AS attachment FROM messages WHERE created_at <= ? UNION ALL SELECT NULL, file_id, created_at, 1 FROM files WHERE status = 'uploading' AND created_at <= ? ORDER BY createdAt, messageId, uploadId LIMIT 100", before, before).toArray();
      // Reclaim one file or upload before considering any newer history.
      const attachmentIndex = items.findIndex(item => item.attachment);
      const selected = items.slice(0, attachmentIndex < 0 ? items.length : attachmentIndex + 1);
      const ids = selected.filter(item => item.messageId !== null).map(item => item.messageId);
      if (ids.length) this.sql.exec(`DELETE FROM messages WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids);
      const upload = selected.find(item => item.uploadId !== null);
      if (upload) this.sql.exec("UPDATE files SET status = 'deleting', reserved_bytes = 0 WHERE file_id = ?", upload.uploadId);
      if (ids.length) this.broadcast({ type: 'history', messages: this.messages() });
      await this.cleanupFiles();
      await this.scheduleAlarm();
      return this.storageUsage();
    });
  }

  findMessage(deviceId, clientId) {
    if (!this.initialized || !this.sql.exec('SELECT 1 FROM devices WHERE device_id = ?', deviceId).toArray().length) {
      return { error: 'unauthorized', status: 401 };
    }
    const existing = this.sql.exec('SELECT id, client_id AS clientId, device_id AS deviceId, text, created_at AS createdAt, attachment FROM messages WHERE device_id = ? AND client_id = ?', deviceId, clientId).toArray()[0];
    if (existing) return { message: publicMessage(existing), created: false };
    return null;
  }

  uploadInfo(deviceId, clientId) {
    if (!this.initialized || !this.sql.exec('SELECT 1 FROM devices WHERE device_id = ?', deviceId).toArray().length) return { error: 'unauthorized', status: 401 };
    const file = this.sql.exec('SELECT file_id, status FROM files WHERE device_id = ? AND client_id = ?', deviceId, clientId).toArray()[0];
    if (!file) return null;
    if (file.status !== 'uploading') return { error: 'upload_unavailable', status: 409 };
    return { uploadId: file.file_id, chunkSize: FILE_CHUNK_SIZE, receivedBytes: this.sql.exec('SELECT coalesce(sum(size), 0) AS bytes FROM file_upload_chunks WHERE file_id = ? AND received = 1', file.file_id).one().bytes };
  }

  async beginUpload(deviceId, file) {
    const existing = this.findMessage(deviceId, file.clientId) || this.uploadInfo(deviceId, file.clientId);
    if (existing) return existing;
    const uploadId = crypto.randomUUID();
    this.sql.exec('INSERT INTO files (file_id, device_id, client_id, name, type, size, text, status, created_at, updated_at, reserved_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', uploadId, deviceId, file.clientId, file.name, file.type, file.size, file.text, 'uploading', Date.now(), Date.now(), fileReserve(file.size));
    await this.scheduleAlarm();
    return { uploadId, chunkSize: FILE_CHUNK_SIZE, receivedBytes: 0, created: true };
  }

  async writeFileChunk(deviceId, uploadId, index, bytes) {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (!this.initialized || !this.sql.exec('SELECT 1 FROM devices WHERE device_id = ?', deviceId).toArray().length) return { error: 'unauthorized', status: 401 };
      const file = this.sql.exec("SELECT * FROM files WHERE file_id = ? AND device_id = ? AND status = 'uploading'", uploadId, deviceId).toArray()[0];
      if (!file || file.updated_at + UPLOAD_LIFETIME <= Date.now()) return { error: 'not_found', status: 404 };
      const count = Math.ceil(file.size / FILE_CHUNK_SIZE);
      const expected = Math.min(FILE_CHUNK_SIZE, file.size - index * FILE_CHUNK_SIZE);
      if (!Number.isSafeInteger(index) || index >= count || bytes.byteLength !== expected) return { error: 'invalid_chunk', status: 400 };
      const shardIndex = Math.floor(index * FILE_CHUNK_SIZE / FILE_SHARD_SIZE);
      const shard = this.env.FILE_SHARDS.getByName(`${uploadId}:${shardIndex}`);
      const tracked = this.sql.exec('SELECT bytes FROM file_shards WHERE file_id = ? AND shard_index = ?', uploadId, shardIndex).toArray()[0];
      const previous = this.sql.exec('SELECT size FROM file_upload_chunks WHERE file_id = ? AND chunk_index = ?', uploadId, index).toArray()[0];
      const received = this.sql.exec('SELECT count(*) AS count FROM file_upload_chunks WHERE file_id = ? AND received = 1', uploadId).one().count;
      if (!previous && index !== received) return { error: 'invalid_chunk', status: 400 };
      const allocation = bytes.byteLength + 65536;
      if (!previous) {
        this.ctx.storage.transactionSync(() => {
          this.sql.exec('INSERT INTO file_upload_chunks (file_id, chunk_index, size) VALUES (?, ?, ?)', uploadId, index, bytes.byteLength);
          this.sql.exec('INSERT INTO file_shards (file_id, shard_index, bytes) VALUES (?, ?, ?) ON CONFLICT(file_id, shard_index) DO UPDATE SET bytes = bytes + excluded.bytes', uploadId, shardIndex, allocation);
          this.sql.exec('UPDATE files SET reserved_bytes = max(0, reserved_bytes - ?) WHERE file_id = ?', allocation, uploadId);
        });
      }
      const result = await shard.writePart(index, bytes);
      if (result.error) return result;
      this.ctx.storage.transactionSync(() => {
        this.sql.exec('UPDATE file_upload_chunks SET received = 1 WHERE file_id = ? AND chunk_index = ?', uploadId, index);
        this.sql.exec('UPDATE files SET updated_at = ? WHERE file_id = ?', Date.now(), uploadId);
        const accounted = (tracked?.bytes || 0) + (previous ? 0 : allocation);
        this.sql.exec('UPDATE file_shards SET bytes = ? WHERE file_id = ? AND shard_index = ?', Math.max(result.bytes, accounted), uploadId, shardIndex);
      });
      await this.scheduleAlarm();
      return { receivedBytes: this.sql.exec('SELECT coalesce(sum(size), 0) AS bytes FROM file_upload_chunks WHERE file_id = ? AND received = 1', uploadId).one().bytes };
    });
  }

  async completeUpload(deviceId, uploadId) {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (!this.initialized || !this.sql.exec('SELECT 1 FROM devices WHERE device_id = ?', deviceId).toArray().length) return { error: 'unauthorized', status: 401 };
      const file = this.sql.exec('SELECT * FROM files WHERE file_id = ? AND device_id = ?', uploadId, deviceId).toArray()[0];
      if (!file || file.status === 'deleting' || (file.status === 'uploading' && file.updated_at + UPLOAD_LIFETIME <= Date.now())) return { error: 'not_found', status: 404 };
      const existing = this.findMessage(deviceId, file.client_id);
      if (existing) return existing;
      if (this.sql.exec('SELECT coalesce(sum(size), 0) AS bytes FROM file_upload_chunks WHERE file_id = ? AND received = 1', uploadId).one().bytes !== file.size) return { error: 'upload_incomplete', status: 409 };
      for (const shard of this.sql.exec('SELECT shard_index FROM file_shards WHERE file_id = ?', uploadId).toArray()) {
        const bytes = await this.env.FILE_SHARDS.getByName(`${uploadId}:${shard.shard_index}`).storageBytes();
        this.sql.exec('UPDATE file_shards SET bytes = ? WHERE file_id = ? AND shard_index = ?', bytes, uploadId, shard.shard_index);
      }
      const attachment = { name: file.name, type: file.type, size: file.size };
      const message = this.ctx.storage.transactionSync(() => {
        const created = this.sql.exec('INSERT INTO messages (client_id, device_id, text, created_at, attachment) VALUES (?, ?, ?, ?, ?) RETURNING id, client_id AS clientId, device_id AS deviceId, text, created_at AS createdAt, attachment', file.client_id, deviceId, file.text, Date.now(), JSON.stringify(attachment)).one();
        this.sql.exec("UPDATE files SET status = 'complete', message_id = ?, created_at = ?, reserved_bytes = 0 WHERE file_id = ?", created.id, created.createdAt, uploadId);
        this.sql.exec('DELETE FROM messages WHERE id <= (SELECT id FROM messages ORDER BY id DESC LIMIT 1 OFFSET 500)');
        return publicMessage(created);
      });
      this.broadcast({ type: 'message', message });
      await this.cleanupFiles();
      await this.scheduleAlarm();
      return { message, created: true };
    });
  }

  async cancelUpload(deviceId, uploadId) {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (!this.initialized || !this.sql.exec('SELECT 1 FROM devices WHERE device_id = ?', deviceId).toArray().length) return { error: 'unauthorized', status: 401 };
      if (!this.sql.exec("UPDATE files SET status = 'deleting', reserved_bytes = 0 WHERE file_id = ? AND device_id = ? AND status = 'uploading' RETURNING file_id", uploadId, deviceId).toArray().length) return { error: 'not_found', status: 404 };
      await this.cleanupFiles();
      await this.scheduleAlarm();
      return { ok: true };
    });
  }

  async cleanupFiles() {
    if (!this.initialized) return;
    const shards = this.sql.exec("SELECT s.file_id, s.shard_index FROM file_shards s JOIN files f ON f.file_id = s.file_id WHERE f.status = 'deleting' ORDER BY f.created_at, s.shard_index LIMIT 4").toArray();
    for (const shard of shards) {
      await this.env.FILE_SHARDS.getByName(`${shard.file_id}:${shard.shard_index}`).erase();
      this.sql.exec('DELETE FROM file_shards WHERE file_id = ? AND shard_index = ?', shard.file_id, shard.shard_index);
    }
    const finished = this.sql.exec("SELECT file_id FROM files WHERE status = 'deleting' AND NOT EXISTS (SELECT 1 FROM file_shards WHERE file_shards.file_id = files.file_id)").toArray();
    for (const file of finished) {
      this.sql.exec('DELETE FROM file_upload_chunks WHERE file_id = ?', file.file_id);
      this.sql.exec('DELETE FROM download_tickets WHERE file_id = ?', file.file_id);
      this.sql.exec('DELETE FROM files WHERE file_id = ?', file.file_id);
    }
  }

  async issueDownload(deviceId, messageId) {
    if (!this.initialized || !this.sql.exec('SELECT 1 FROM devices WHERE device_id = ?', deviceId).toArray().length) return { error: 'unauthorized', status: 401 };
    const file = this.sql.exec("SELECT file_id FROM files WHERE message_id = ? AND status = 'complete'", messageId).toArray()[0];
    if (!file) return { error: 'not_found', status: 404 };
    const ticket = credential();
    const expiresAt = Date.now() + DOWNLOAD_LIFETIME;
    this.sql.exec('INSERT INTO download_tickets (ticket, file_id, device_id, expires_at) VALUES (?, ?, ?, ?)', ticket, file.file_id, deviceId, expiresAt);
    return { ticket, expiresAt };
  }

  async addMessage(deviceId, clientId, text) {
    const existing = this.findMessage(deviceId, clientId);
    if (existing) return existing;
    const message = this.sql.exec(
      'INSERT INTO messages (client_id, device_id, text, created_at) VALUES (?, ?, ?, ?) RETURNING id, client_id AS clientId, device_id AS deviceId, text, created_at AS createdAt',
      clientId, deviceId, text, Date.now()
    ).one();
    this.sql.exec('DELETE FROM messages WHERE id <= (SELECT id FROM messages ORDER BY id DESC LIMIT 1 OFFSET 500)');
    this.broadcast({ type: 'message', message });
    await this.scheduleAlarm();
    return { message, created: true };
  }

  async clearMessages(deviceId) {
    if (!this.initialized || !this.sql.exec('SELECT 1 FROM devices WHERE device_id = ?', deviceId).toArray().length) {
      return { error: 'unauthorized', status: 401 };
    }
    this.sql.exec('DELETE FROM messages');
    this.sql.exec("UPDATE files SET status = 'deleting', reserved_bytes = 0 WHERE status = 'uploading'");
    this.broadcast({ type: 'cleared' });
    await this.scheduleAlarm();
    return { ok: true };
  }

  removeDevice(deviceId, requesterId = deviceId) {
    if (!this.initialized || !this.sql.exec('SELECT 1 FROM devices WHERE device_id = ?', requesterId).toArray().length) {
      return { error: 'unauthorized', status: 401 };
    }
    if (!this.sql.exec('DELETE FROM devices WHERE device_id = ? RETURNING device_id', deviceId).toArray().length) {
      return { error: 'device_not_found', status: 404 };
    }
    this.sql.exec("UPDATE files SET status = 'deleting', reserved_bytes = 0 WHERE device_id = ? AND status = 'uploading'", deviceId);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.deserializeAttachment()?.deviceId !== deviceId) continue;
      socket.serializeAttachment({ closing: true });
      socket.close(4001, 'Device disconnected');
    }
    this.broadcast({ type: 'devices' });
    return { ok: true };
  }

  broadcast(event) {
    const payload = JSON.stringify(event);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.deserializeAttachment()?.deviceId && socket.readyState === WebSocket.OPEN) socket.send(payload);
    }
  }

  pairingSnapshot(roomId, receive) {
    // Send ready before a newer pairing broadcast can overtake its registry read.
    const work = this.pairingQueue.then(async () => {
      const pairing = await this.env.PAIRING_REGISTRY.getByName('registry').currentInvite(roomId);
      return receive(pairing?.expiresAt > Date.now() ? pairing : null);
    });
    this.pairingQueue = work.catch(() => {});
    return work;
  }

  publishPairing(roomId) {
    return this.pairingSnapshot(roomId, pairing => this.broadcast({ type: 'pairing', pairing }));
  }

  async fetch(request) {
    if (!this.initialized) return json({ error: 'not_found' }, 404);
    const url = new URL(request.url);
    const path = url.pathname;
    const download = path.match(/^\/v1\/spaces\/[^/]+\/files\/([1-9][0-9]*)$/);
    const ticketMatch = path.match(/^\/v1\/spaces\/[^/]+\/downloads\/([0-9a-f]{64})$/);
    if (['GET', 'HEAD'].includes(request.method) && (download || ticketMatch)) {
      let deviceId;
      let file;
      if (ticketMatch) {
        const ticket = this.sql.exec('SELECT file_id, device_id, expires_at FROM download_tickets WHERE ticket = ?', ticketMatch[1]).toArray()[0];
        if (!ticket || ticket.expires_at <= Date.now()) return json({ error: 'not_found' }, 404);
        deviceId = ticket.device_id;
        file = this.sql.exec("SELECT * FROM files WHERE file_id = ? AND status = 'complete'", ticket.file_id).toArray()[0];
      } else {
        const token = request.headers.get('Authorization')?.match(/^Bearer ([0-9a-f]{64})$/)?.[1];
        deviceId = token ? await this.authorize(token) : null;
        file = this.sql.exec("SELECT * FROM files WHERE message_id = ? AND status = 'complete'", download[1]).toArray()[0];
      }
      if (!deviceId || !this.sql.exec('SELECT 1 FROM devices WHERE device_id = ?', deviceId).toArray().length) return json({ error: 'unauthorized' }, 401);
      if (!file || !this.sql.exec('SELECT 1 FROM messages WHERE id = ?', file.message_id).toArray().length || file.created_at + MESSAGE_LIFETIME <= Date.now()) return json({ error: 'not_found' }, 404);
      const filename = encodeURIComponent(file.name).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
      const inline = ticketMatch && url.searchParams.get('preview') === '1' && ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'video/mp4', 'video/webm', 'video/ogg', 'application/pdf'].includes(file.type.toLowerCase());
      const headers = {
        'Content-Type': inline ? file.type.toLowerCase() : 'application/octet-stream', 'Content-Length': String(file.size),
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="download"; filename*=UTF-8''${filename}`,
        'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes',
        'ETag': `"${file.file_id}"`, 'Last-Modified': new Date(file.created_at).toUTCString()
      };
      if (request.method === 'HEAD') return new Response(null, { headers });
      let start = 0;
      let end = file.size - 1;
      const ifRange = request.headers.get('If-Range');
      const range = ifRange && ifRange !== headers.ETag && Date.parse(ifRange) !== Math.floor(file.created_at / 1000) * 1000 ? null : request.headers.get('Range');
      if (range !== null) {
        const match = range.trim().match(/^bytes=(\d*)-(\d*)$/i);
        if (match && (match[1] || match[2])) {
          if (match[1]) {
            start = Number(match[1]);
            end = match[2] ? Math.min(Number(match[2]), end) : end;
          } else {
            start = Math.max(0, file.size - Number(match[2]));
          }
        }
        if (!match || (!match[1] && !match[2]) || start > end || (!match[1] && Number(match[2]) === 0)) {
          return new Response(null, { status: 416, headers: { ...headers, 'Content-Length': '0', 'Content-Range': `bytes */${file.size}` } });
        }
        headers['Content-Range'] = `bytes ${start}-${end}/${file.size}`;
        headers['Content-Length'] = String(end - start + 1);
      }
      let offset = start;
      let shardReader = null;
      let shardIndex = -1;
      const body = new ReadableStream({
        type: 'bytes',
        pull: async (controller) => {
          if (!this.initialized || !this.sql.exec('SELECT 1 FROM devices WHERE device_id = ?', deviceId).toArray().length || !this.sql.exec("SELECT 1 FROM files WHERE file_id = ? AND status = 'complete'", file.file_id).toArray().length || file.created_at + MESSAGE_LIFETIME <= Date.now()) {
            await shardReader?.cancel();
            shardReader?.releaseLock();
            shardReader = null;
            controller.error(new Error('download_unavailable'));
            return;
          }
          if (offset > end) {
            await shardReader?.cancel();
            shardReader?.releaseLock();
            shardReader = null;
            controller.close();
            return;
          }
          try {
            const nextShard = Math.floor(offset / FILE_SHARD_SIZE);
            if (nextShard !== shardIndex) {
              await shardReader?.cancel();
              shardReader?.releaseLock();
              const shardOffset = offset % FILE_SHARD_SIZE;
              const stream = await this.env.FILE_SHARDS.getByName(`${file.file_id}:${nextShard}`).readStream(shardOffset, Math.min(FILE_SHARD_SIZE - shardOffset, end - offset + 1));
              shardReader = stream.getReader();
              shardIndex = nextShard;
            }
            const { done, value } = await shardReader.read();
            if (done || !value?.byteLength) throw new Error('not_found');
            offset += value.byteLength;
            controller.enqueue(value);
          } catch (error) {
            await shardReader?.cancel(error).catch(() => {});
            shardReader?.releaseLock();
            shardReader = null;
            controller.error(error);
          }
        },
        async cancel(reason) {
          await shardReader?.cancel(reason);
          shardReader?.releaseLock();
          shardReader = null;
        }
      });
      return new Response(body.pipeThrough(new FixedLengthStream(end - start + 1)), { status: range === null ? 200 : 206, headers });
    }
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'websocket_required' }, 426);
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ authDeadline: Date.now() + 10000, roomId: new URL(request.url).pathname.split('/')[3] });
    await this.scheduleAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket, payload) {
    if (!this.initialized) {
      socket.close(4001, 'Space expired');
      return;
    }
    const attachment = socket.deserializeAttachment();
    if (attachment?.closing) return;
    if (attachment?.deviceId || typeof payload !== 'string' || payload.length > 1024 || attachment.authDeadline <= Date.now()) {
      socket.serializeAttachment({ closing: true });
      socket.close(1008, 'Authentication required');
      await this.scheduleAlarm();
      return;
    }
    let frame;
    try {
      frame = JSON.parse(payload);
    } catch {
      socket.serializeAttachment({ closing: true });
      socket.close(1008, 'Invalid authentication');
      await this.scheduleAlarm();
      return;
    }
    if (frame?.type !== 'auth' || typeof frame.token !== 'string' || !/^[0-9a-f]{64}$/.test(frame.token)) {
      socket.serializeAttachment({ closing: true });
      socket.close(1008, 'Invalid authentication');
      await this.scheduleAlarm();
      return;
    }
    const deviceId = await this.authorize(frame.token);
    if (!deviceId) {
      socket.serializeAttachment({ closing: true });
      socket.close(4001, 'Invalid credential');
      await this.scheduleAlarm();
      return;
    }
    const authenticated = await this.pairingSnapshot(attachment.roomId, pairing => {
      if (attachment.authDeadline <= Date.now()) {
        socket.serializeAttachment({ closing: true });
        socket.close(1008, 'Authentication timed out');
        return false;
      }
      if (!this.initialized || !this.sql.exec('SELECT 1 FROM devices WHERE device_id = ?', deviceId).toArray().length) {
        socket.serializeAttachment({ closing: true });
        socket.close(4001, 'Invalid credential');
        return false;
      }
      this.pruneExpired();
      this.sql.exec('INSERT OR IGNORE INTO metadata (key, value) VALUES (?, ?)', 'roomId', attachment.roomId);
      socket.serializeAttachment({ deviceId });
      socket.send(JSON.stringify({ type: 'ready', deviceId, messages: this.messages(), pairing }));
      return true;
    });
    await this.scheduleAlarm();
    if (authenticated) this.ctx.waitUntil(this.env.PAIRING_REGISTRY.getByName('registry').refreshRoom(attachment.roomId));
  }

  async scheduleAlarm() {
    if (!this.initialized) return;
    const deadlines = this.ctx.getWebSockets()
      .map(socket => socket.deserializeAttachment()?.authDeadline)
      .filter(Boolean);
    const oldest = this.sql.exec('SELECT min(created_at) AS oldest_at FROM messages').one().oldest_at;
    if (oldest !== null) deadlines.push(oldest + MESSAGE_LIFETIME);
    const uploading = this.sql.exec("SELECT min(updated_at) AS oldest_at FROM files WHERE status = 'uploading'").one().oldest_at;
    if (uploading !== null) deadlines.push(uploading + UPLOAD_LIFETIME);
    if (this.sql.exec("SELECT 1 FROM files WHERE status = 'deleting' LIMIT 1").toArray().length) deadlines.push(Date.now() + 1000);
    if (deadlines.length) await this.ctx.storage.setAlarm(Math.min(...deadlines));
    else await this.ctx.storage.deleteAlarm();
  }

  async alarm() {
    if (!this.initialized) return;
    const now = Date.now();
    for (const socket of this.ctx.getWebSockets()) {
      const deadline = socket.deserializeAttachment()?.authDeadline;
      if (!deadline || deadline > now) continue;
      socket.serializeAttachment({ closing: true });
      socket.close(1008, 'Authentication timed out');
    }
    const deleted = this.pruneExpired();
    const hadPending = this.sql.exec("SELECT 1 FROM files WHERE status = 'deleting' LIMIT 1").toArray().length;
    await this.cleanupFiles();
    await this.scheduleAlarm();
    const roomId = this.sql.exec('SELECT value FROM metadata WHERE key = ?', 'roomId').toArray()[0]?.value;
    if ((deleted || hadPending) && roomId) this.ctx.waitUntil(this.env.PAIRING_REGISTRY.getByName('registry').refreshRoom(roomId));
  }

  async webSocketClose(socket) {
    socket.serializeAttachment({ closing: true });
    await this.scheduleAlarm();
  }

  async webSocketError(socket) {
    socket.serializeAttachment({ closing: true });
    socket.close(1011, 'Connection error');
    await this.scheduleAlarm();
  }
}

export class FileShard extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS chunks (chunk_index INTEGER PRIMARY KEY, data BLOB NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS parts (part_index INTEGER PRIMARY KEY, hash TEXT NOT NULL)');
  }

  async writePart(index, contents) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', contents)), value => value.toString(16).padStart(2, '0')).join('');
      const existing = this.sql.exec('SELECT hash FROM parts WHERE part_index = ?', index).toArray()[0];
      if (existing) return existing.hash === digest ? { bytes: this.sql.databaseSize } : { error: 'chunk_conflict', status: 409 };
      this.ctx.storage.transactionSync(() => {
        const start = (index % (FILE_SHARD_SIZE / FILE_CHUNK_SIZE)) * (FILE_CHUNK_SIZE / BLOB_CHUNK_SIZE);
        for (let offset = 0, chunk = start; offset < contents.byteLength; offset += BLOB_CHUNK_SIZE, chunk++) {
          this.sql.exec('INSERT INTO chunks (chunk_index, data) VALUES (?, ?)', chunk, new Uint8Array(contents, offset, Math.min(BLOB_CHUNK_SIZE, contents.byteLength - offset)));
        }
        this.sql.exec('INSERT INTO parts (part_index, hash) VALUES (?, ?)', index, digest);
      });
      return { bytes: this.sql.databaseSize };
    });
  }

  readStream(offset = 0, length = FILE_SHARD_SIZE - offset) {
    const end = offset + length;
    return new ReadableStream({
      type: 'bytes',
      pull: (controller) => {
        if (offset >= end) { controller.close(); return; }
        const chunk = this.sql.exec('SELECT data FROM chunks WHERE chunk_index = ?', Math.floor(offset / BLOB_CHUNK_SIZE)).toArray()[0];
        if (!chunk) controller.close();
        else {
          const bytes = new Uint8Array(chunk.data).slice(offset % BLOB_CHUNK_SIZE, Math.min(BLOB_CHUNK_SIZE, offset % BLOB_CHUNK_SIZE + end - offset));
          offset += bytes.byteLength;
          controller.enqueue(bytes);
        }
      }
    });
  }

  storageBytes() {
    return this.sql.databaseSize;
  }

  erase() {
    return this.ctx.storage.deleteAll();
  }
}
