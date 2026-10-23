import { DurableObject } from 'cloudflare:workers';

const INVITE_LIFETIME = 10 * 60 * 1000;
const MESSAGE_LIFETIME = 5 * 24 * 60 * 60 * 1000;
const STORAGE_HIGH_WATER = 4_700_000_000;
const STORAGE_CLEANUP_BYTES = 3_000_000_000;
const MESSAGE_WRITE_HEADROOM = 128 * 1024;
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
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Expose-Headers': 'Retry-After',
      'Access-Control-Max-Age': '86400'
    };
    if (origin) corsHeaders['Access-Control-Allow-Origin'] = origin;

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });

    const response = await this.route(request, env);
    if (response.status === 101) return response;
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
      const roomId = crypto.randomUUID();
      const room = env.SYNC_ROOMS.getByName(roomId);
      const device = await room.initialize();
      await registry.refreshRoom(roomId);
      const invite = await registry.createInvite(roomId);
      if (invite.error) return resultResponse(invite);
      return json({ roomId, ...device, ...invite }, 201);
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
      const invite = await registry.findInvite(body.value.code);
      if (invite.error) return resultResponse(invite);
      const device = await env.SYNC_ROOMS.getByName(invite.roomId).addDevice();
      await registry.refreshRoom(invite.roomId);
      return json({ roomId: invite.roomId, ...device });
    }

    const match = url.pathname.match(/^\/v1\/spaces\/([^/]+)(\/pair-code|\/messages|\/socket|\/device)?$/);
    if (!match || !ROOM_ID.test(match[1])) return json({ error: 'not_found' }, 404);
    const roomId = match[1];
    const room = env.SYNC_ROOMS.getByName(roomId);
    if (request.method === 'GET' && match[2] === '/socket') {
      const ipHash = await hash(request.headers.get('CF-Connecting-IP') || 'local');
      const limit = await registry.takeLimit(`socket:${ipHash}`, 30, INVITE_LIFETIME);
      if (limit.error) return resultResponse(limit);
      return room.fetch(request);
    }
    const token = request.headers.get('Authorization')?.match(/^Bearer ([0-9a-f]{64})$/)?.[1];
    const deviceId = token ? await room.authorize(token) : null;
    if (!deviceId) return json({ error: 'unauthorized' }, 401);

    if (request.method === 'GET' && !match[2]) {
      await registry.refreshRoom(roomId);
      return json({ roomId, deviceId, ...await room.info() });
    }
    if (request.method === 'POST' && match[2] === '/pair-code') {
      const limit = await registry.takeLimit(`invite:${roomId}`, 1, 30 * 1000);
      if (limit.error) return resultResponse(limit);
      return resultResponse(await registry.createInvite(roomId));
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
    this.sql.exec('CREATE TABLE IF NOT EXISTS room_usage (room_id TEXT PRIMARY KEY, bytes INTEGER NOT NULL, oldest_at INTEGER)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS cleanup (id INTEGER PRIMARY KEY CHECK(id = 1), phase TEXT NOT NULL, cursor TEXT NOT NULL, target_bytes INTEGER)');
  }

  rememberUsage(roomId, usage) {
    this.sql.exec(
      'INSERT INTO room_usage (room_id, bytes, oldest_at) VALUES (?, ?, ?) ON CONFLICT(room_id) DO UPDATE SET bytes = excluded.bytes, oldest_at = excluded.oldest_at',
      roomId, usage.bytes, usage.oldestAt
    );
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
    return this.ctx.blockConcurrencyWhile(async () => {
      const usage = await this.env.SYNC_ROOMS.getByName(roomId).maintain(roomId);
      this.rememberUsage(roomId, usage);
    });
  }

  async storeMessage(roomId, deviceId, clientId, text) {
    return this.ctx.blockConcurrencyWhile(async () => {
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

  async alarm() {
    await this.ctx.blockConcurrencyWhile(async () => {
      let state = this.sql.exec('SELECT phase, cursor, target_bytes FROM cleanup WHERE id = 1').toArray()[0];
      if (!state) return;
      if (state.phase === 'refresh') {
        const rooms = this.sql.exec('SELECT room_id FROM room_usage WHERE room_id > ? ORDER BY room_id LIMIT 10', state.cursor).toArray();
        for (const { room_id: roomId } of rooms) {
          this.rememberUsage(roomId, await this.env.SYNC_ROOMS.getByName(roomId).maintain(roomId));
        }
        if (rooms.length === 10) {
          this.sql.exec('UPDATE cleanup SET cursor = ? WHERE id = 1', rooms[9].room_id);
          await this.ctx.storage.setAlarm(Date.now() + 1000);
          return;
        }
        const total = this.storageBytes();
        if (total + MESSAGE_WRITE_HEADROOM < STORAGE_HIGH_WATER) {
          this.sql.exec('DELETE FROM cleanup');
          return;
        }
        state = { phase: 'prune', target_bytes: Math.max(0, total - STORAGE_CLEANUP_BYTES) };
        this.sql.exec("UPDATE cleanup SET phase = 'prune', target_bytes = ? WHERE id = 1", state.target_bytes);
        await this.ctx.storage.setAlarm(Date.now() + 1000);
        return;
      }
      for (let batch = 0; batch < 10 && this.storageBytes() > state.target_bytes; batch += 1) {
        const oldest = this.sql.exec('SELECT room_id, oldest_at FROM room_usage WHERE oldest_at IS NOT NULL ORDER BY oldest_at, room_id LIMIT 1').toArray()[0];
        if (!oldest) break;
        const room = this.env.SYNC_ROOMS.getByName(oldest.room_id);
        this.rememberUsage(oldest.room_id, await room.maintain());
        if (this.storageBytes() <= state.target_bytes) break;
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
    this.sql.exec('CREATE TABLE IF NOT EXISTS devices (token_hash TEXT PRIMARY KEY, device_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id TEXT NOT NULL, device_id TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(device_id, client_id))');
    this.sql.exec('CREATE INDEX IF NOT EXISTS messages_expiry ON messages(created_at)');
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async initialize() {
    this.sql.exec('INSERT INTO metadata (key, value) VALUES (?, ?)', 'createdAt', String(Date.now()));
    return this.addDevice();
  }

  async addDevice() {
    const token = credential();
    const deviceId = crypto.randomUUID();
    this.sql.exec('INSERT INTO devices (token_hash, device_id, created_at) VALUES (?, ?, ?)', await hash(token), deviceId, Date.now());
    return { token, deviceId };
  }

  async authorize(token) {
    return this.sql.exec('SELECT device_id FROM devices WHERE token_hash = ?', await hash(token)).toArray()[0]?.device_id || null;
  }

  info() {
    return {
      createdAt: Number(this.sql.exec('SELECT value FROM metadata WHERE key = ?', 'createdAt').one().value),
      messages: this.messages()
    };
  }

  messages() {
    return this.sql.exec('SELECT id, client_id AS clientId, device_id AS deviceId, text, created_at AS createdAt FROM messages ORDER BY id').toArray();
  }

  storageUsage() {
    return {
      bytes: this.sql.databaseSize,
      oldestAt: this.sql.exec('SELECT min(created_at) AS oldest_at FROM messages').one().oldest_at
    };
  }

  pruneExpired() {
    const deleted = this.sql.exec('DELETE FROM messages WHERE created_at <= ? RETURNING id', Date.now() - MESSAGE_LIFETIME).toArray();
    if (deleted.length) this.broadcast({ type: 'history', messages: this.messages() });
    return deleted.length;
  }

  async maintain(roomId) {
    if (roomId) this.sql.exec('INSERT OR IGNORE INTO metadata (key, value) VALUES (?, ?)', 'roomId', roomId);
    this.pruneExpired();
    await this.scheduleAlarm();
    return this.storageUsage();
  }

  async pruneOldest(before = Number.MAX_SAFE_INTEGER) {
    this.sql.exec('DELETE FROM messages WHERE id IN (SELECT id FROM messages WHERE created_at <= ? ORDER BY created_at, id LIMIT 100)', before);
    this.broadcast({ type: 'history', messages: this.messages() });
    await this.scheduleAlarm();
    return this.storageUsage();
  }

  findMessage(deviceId, clientId) {
    if (!this.sql.exec('SELECT 1 FROM devices WHERE device_id = ?', deviceId).toArray().length) {
      return { error: 'unauthorized', status: 401 };
    }
    const existing = this.sql.exec('SELECT id, client_id AS clientId, device_id AS deviceId, text, created_at AS createdAt FROM messages WHERE device_id = ? AND client_id = ?', deviceId, clientId).toArray()[0];
    if (existing) return { message: existing, created: false };
    return null;
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
    if (!this.sql.exec('SELECT 1 FROM devices WHERE device_id = ?', deviceId).toArray().length) {
      return { error: 'unauthorized', status: 401 };
    }
    this.sql.exec('DELETE FROM messages');
    this.broadcast({ type: 'cleared' });
    await this.scheduleAlarm();
    return { ok: true };
  }

  removeDevice(deviceId) {
    this.sql.exec('DELETE FROM devices WHERE device_id = ?', deviceId);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.deserializeAttachment()?.deviceId !== deviceId) continue;
      socket.serializeAttachment({ closing: true });
      socket.close(4001, 'Device disconnected');
    }
    return { ok: true };
  }

  broadcast(event) {
    const payload = JSON.stringify(event);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.deserializeAttachment()?.deviceId && socket.readyState === WebSocket.OPEN) socket.send(payload);
    }
  }

  async fetch(request) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'websocket_required' }, 426);
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ authDeadline: Date.now() + 10000, roomId: new URL(request.url).pathname.split('/')[3] });
    await this.scheduleAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket, payload) {
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
    this.pruneExpired();
    this.sql.exec('INSERT OR IGNORE INTO metadata (key, value) VALUES (?, ?)', 'roomId', attachment.roomId);
    socket.serializeAttachment({ deviceId });
    socket.send(JSON.stringify({ type: 'ready', deviceId, messages: this.messages() }));
    await this.scheduleAlarm();
    this.ctx.waitUntil(this.env.PAIRING_REGISTRY.getByName('registry').refreshRoom(attachment.roomId));
  }

  async scheduleAlarm() {
    const deadlines = this.ctx.getWebSockets()
      .map(socket => socket.deserializeAttachment()?.authDeadline)
      .filter(Boolean);
    const oldest = this.sql.exec('SELECT min(created_at) AS oldest_at FROM messages').one().oldest_at;
    if (oldest !== null) deadlines.push(oldest + MESSAGE_LIFETIME);
    if (deadlines.length) await this.ctx.storage.setAlarm(Math.min(...deadlines));
    else await this.ctx.storage.deleteAlarm();
  }

  async alarm() {
    const now = Date.now();
    for (const socket of this.ctx.getWebSockets()) {
      const deadline = socket.deserializeAttachment()?.authDeadline;
      if (!deadline || deadline > now) continue;
      socket.serializeAttachment({ closing: true });
      socket.close(1008, 'Authentication timed out');
    }
    const deleted = this.pruneExpired();
    await this.scheduleAlarm();
    const roomId = this.sql.exec('SELECT value FROM metadata WHERE key = ?', 'roomId').toArray()[0]?.value;
    if (deleted && roomId) this.ctx.waitUntil(this.env.PAIRING_REGISTRY.getByName('registry').refreshRoom(roomId));
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
