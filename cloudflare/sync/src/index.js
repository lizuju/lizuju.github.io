import { DurableObject } from 'cloudflare:workers';
import { API_VERSION } from './api-version.js';
import { collectDailyUsage, unavailableDailyUsage } from './daily-usage.js';

const INVITE_LIFETIME = 10 * 60 * 1000;
const MESSAGE_LIFETIME = 7 * 24 * 60 * 60 * 1000;
const STORAGE_HIGH_WATER = 4_800_000_000;
const STORAGE_CLEANUP_BYTES = 3_000_000_000;
const MESSAGE_WRITE_HEADROOM = 128 * 1024;
const FILE_PLAINTEXT_LIMIT = 2 * 1024 * 1024 * 1024;
const FILE_SIZE_LIMIT = FILE_PLAINTEXT_LIMIT + Math.ceil(FILE_PLAINTEXT_LIMIT / (512 * 1024 - 16)) * 16;
const FILE_CHUNK_SIZE = 8 * 1024 * 1024;
const FILE_SHARD_SIZE = 64 * 1024 * 1024;
const BLOB_CHUNK_SIZE = 1024 * 1024;
const UPLOAD_LIFETIME = 24 * 60 * 60 * 1000;
const DOWNLOAD_LIFETIME = 24 * 60 * 60 * 1000;
const DEVICE_IDLE_LIFETIME = 7 * 24 * 60 * 60 * 1000;
const ROOM_IDLE_LIFETIME = 7 * 24 * 60 * 60 * 1000;
const ACTIVITY_WRITE_INTERVAL = 60 * 60 * 1000;
const DEVICE_ACTIVITY_WRITE_INTERVAL = 60 * 1000;
const PAIR_CANDIDATE_LIMIT = 30;
const PAIR_REQUEST_LIMIT = 100;
const PAIR_RPC_TIMEOUT = 2000;
const PAIR_DISCOVERY_CACHE_LIFETIME = 2000;
const statusRefreshes = new Map();
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

function encrypted(value, maximum = 65536, prefix = 'e2ee1') {
  return typeof value === 'string' && value.length >= 64 && value.length <= maximum && value.startsWith(`${prefix}.`) && /^[A-Za-z0-9_-]+$/.test(value.slice(prefix.length + 1));
}

function envelopeKey(value) {
  if (!encrypted(value, 262144)) return null;
  try {
    const encoded = value.slice(6).replace(/-/g, '+').replace(/_/g, '/');
    const parsed = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(encoded), character => character.charCodeAt(0))));
    return ROOM_ID.test(parsed.keyId) ? parsed.keyId : null;
  } catch { return null; }
}

function rotationFields(value) {
  return ROOM_ID.test(value.rotationId) && ROOM_ID.test(value.newKeyId) && Array.isArray(value.grants) && value.grants.length > 0 && value.grants.length <= 20
    && value.grants.every(grant => grant && ROOM_ID.test(grant.deviceId) && encrypted(grant.envelope, 262144))
    && new Set(value.grants.map(grant => grant.deviceId)).size === value.grants.length;
}

function relayValue(value) {
  return typeof value === 'string' && value.length >= 16 && value.length <= 8192 && /^[A-Za-z0-9+/=_-]+$/.test(value);
}

function credential() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function rpcResult(operation, timeout = PAIR_RPC_TIMEOUT) {
  let timer;
  try {
    return await Promise.race([
      operation.then(value => ({ ok: true, value }), () => ({ ok: false })),
      new Promise(resolve => { timer = setTimeout(() => resolve({ ok: false }), timeout); })
    ]);
  } finally { clearTimeout(timer); }
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
  return json({ error: result.error, ...(result.game ? { game: result.game } : {}) }, result.status, headers);
}

export default {
  async scheduled(event, env) {
    await env.E2EE_PAIRING_REGISTRY.getByName('registry').maintainRooms();
  },

  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const allowedOrigins = env.ALLOWED_ORIGINS.split(',').map(value => value.trim());
    if (origin && !allowedOrigins.includes(origin)) return json({ error: 'origin_not_allowed' }, 403);

    const corsHeaders = {
      'Vary': 'Origin',
      'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, Range, If-Range, X-Sync-Key-Id',
      'Access-Control-Expose-Headers': 'Retry-After, Content-Disposition, Accept-Ranges, Content-Range, Content-Length, ETag, Last-Modified',
      'Access-Control-Max-Age': '86400'
    };
    if (origin) corsHeaders['Access-Control-Allow-Origin'] = origin;

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });

    const startedAt = Date.now();
    const path = new URL(request.url).pathname;
    const route = path.includes('/files/') || path.includes('/downloads/') ? 'files' : path.endsWith('/messages') ? 'messages' : path === '/v1/status' ? 'status' : path.includes('pair') || path === '/v1/spaces' ? 'pairing' : 'other';
    let response;
    try { response = await this.route(request, env); }
    catch {
      console.error(JSON.stringify({ event: 'sync_request_error', route, status: 500, durationMs: Date.now() - startedAt }));
      return json({ error: 'internal_error' }, 500, corsHeaders);
    }
    if (response.status >= 500) console.warn(JSON.stringify({ event: 'sync_request_error', route, status: response.status, durationMs: Date.now() - startedAt }));
    if (response.status === 101) return response;
    response = new Response(response.body, response);
    for (const [key, value] of Object.entries(corsHeaders)) response.headers.set(key, value);
    return response;
  },

  async route(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true, service: 'portfolio-sync', apiVersion: API_VERSION, encryptionVersion: 1, revision: env.RELEASE_REVISION || null, versionId: env.WORKER_VERSION?.id || null });
    }

    const registry = env.E2EE_PAIRING_REGISTRY.getByName('registry');
    if (request.method === 'GET' && url.pathname === '/v1/status') {
      const cacheKey = new Request(`${url.origin}/v1/status?release=${encodeURIComponent(env.WORKER_VERSION?.id || env.RELEASE_REVISION || 'local')}`);
      const cached = await caches.default.match(cacheKey);
      if (cached) return new Response(cached.body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
      let pending = statusRefreshes.get(cacheKey.url);
      if (!pending) {
        pending = (async () => {
          const status = await registry.publicStatus();
          const ttl = Math.floor((status.checkedAt + 15000 - Date.now()) / 1000);
          if (status.ok && ttl > 0) await caches.default.put(cacheKey, json(status, 200, { 'Cache-Control': `public, max-age=${ttl}` }));
          return status;
        })().finally(() => { if (statusRefreshes.get(cacheKey.url) === pending) statusRefreshes.delete(cacheKey.url); });
        statusRefreshes.set(cacheKey.url, pending);
      }
      return json(await pending);
    }
    if (request.method === 'POST' && url.pathname === '/v1/spaces') {
      const ipHash = await hash(request.headers.get('CF-Connecting-IP') || 'local');
      const limit = await registry.takeLimit(`create:${ipHash}`, 5, 60 * 60 * 1000);
      if (limit.error) return resultResponse(limit);
      const body = await readJson(request);
      if (body.error) return resultResponse(body);
      if (!ROOM_ID.test(body.value.keyId)) return json({ error: 'invalid_key' }, 400);
      return resultResponse(await registry.createSpace(body.value.keyId), 201);
    }

    if (request.method === 'GET' && url.pathname === '/v1/pair/offers') return resultResponse(await registry.publicOffers(await hash(request.headers.get('CF-Connecting-IP') || 'local')));
    if (request.method === 'POST' && url.pathname === '/v1/pair') {
      const ipHash = await hash(request.headers.get('CF-Connecting-IP') || 'local');
      const limit = await registry.takeLimit(`pair:${ipHash}`, 20, INVITE_LIFETIME);
      if (limit.error) return resultResponse(limit);
      const body = await readJson(request, 32768);
      if (body.error) return resultResponse(body);
      const { requestId, requestToken, requests } = body.value;
      if (Object.keys(body.value).some(key => !['requestId', 'requestToken', 'requests'].includes(key)) || !ROOM_ID.test(requestId) || !/^[0-9a-f]{64}$/.test(requestToken)
          || !Array.isArray(requests) || !requests.length || requests.length > PAIR_CANDIDATE_LIMIT
          || requests.some(value => !value || Object.keys(value).some(key => !['offerId', 'startLoginRequest'].includes(key)) || !ROOM_ID.test(value.offerId) || !relayValue(value.startLoginRequest))
          || new Set(requests.map(value => value.offerId)).size !== requests.length) return json({ error: 'invalid_pairing' }, 400);
      return resultResponse(await registry.startPairing(requestId, requestToken, requests, ipHash), 202);
    }
    const pairingRequest = url.pathname.match(/^\/v1\/pair\/([^/]+)(\/ack)?$/);
    if (pairingRequest && ROOM_ID.test(pairingRequest[1])) {
      const token = request.headers.get('Authorization')?.match(/^Bearer ([0-9a-f]{64})$/)?.[1];
      if (!token) return json({ error: 'unauthorized' }, 401);
      if (pairingRequest[2]) return request.method === 'POST' ? resultResponse(await registry.ackPairing(pairingRequest[1], token)) : json({ error: 'not_found' }, 404);
      if (request.method === 'GET') return resultResponse(await registry.readPairing(pairingRequest[1], token));
      if (request.method === 'DELETE') return resultResponse(await registry.cancelPairing(pairingRequest[1], token));
      if (request.method === 'POST') {
        const body = await readJson(request, 8 * 1024 * 1024);
        if (body.error) return resultResponse(body);
        const { offerId, finishLoginRequest, clientData } = body.value;
        if (Object.keys(body.value).some(key => !['offerId', 'finishLoginRequest', 'clientData'].includes(key)) || !ROOM_ID.test(offerId) || !relayValue(finishLoginRequest) || !encrypted(clientData, 262144, 'pair1')) return json({ error: 'invalid_pairing' }, 400);
        return resultResponse(await registry.finishPairing(pairingRequest[1], token, offerId, finishLoginRequest, clientData));
      }
      return json({ error: 'not_found' }, 404);
    }

    const match = url.pathname.match(/^\/v1\/spaces\/([^/]+)(\/key-rotation|\/key-grants|\/pair-code|\/pair-challenge|\/pair-accept|\/pair-requests|\/messages|\/socket|\/profile|\/device|\/devices(?:\/([^/]+))?|\/gomoku\/[^/]+(?:\/(?:join|move|leave))?|\/files(?:\/.*)?|\/downloads\/[0-9a-f]{64})?$/);
    if (!match || !ROOM_ID.test(match[1]) || (match[3] && !ROOM_ID.test(match[3]))) return json({ error: 'not_found' }, 404);
    const roomId = match[1];
    const uploadChunk = match[2]?.match(/^\/files\/uploads\/([0-9a-f-]{36})\/chunks\/(0|[1-9][0-9]*)$/i);
    if (request.method === 'PUT' && uploadChunk && ROOM_ID.test(uploadChunk[1])) return env.E2EE_SYNC_ROOMS.getByName(roomId).fetch(request);
    const gamePath = /^\/gomoku\/([^/]+)(?:\/(join|move|leave))?$/.exec(match[2] || '');
    if (!gamePath && match[2] !== '/profile' && !await registry.hasRoom(roomId)) return json({ error: 'not_found' }, 404);
    const room = env.E2EE_SYNC_ROOMS.getByName(roomId);
    if (request.method === 'GET' && match[2] === '/socket') {
      const protocols = (request.headers.get('Sec-WebSocket-Protocol') || '').split(',').map(value => value.trim());
      const token = protocols.find(value => /^auth\.[0-9a-f]{64}$/.test(value))?.slice(5);
      const deviceId = token ? await room.authorize(token) : null;
      const key = deviceId ? `socket-device:${roomId}:${deviceId}` : `socket:${await hash(request.headers.get('CF-Connecting-IP') || 'local')}`;
      const limit = await registry.takeLimit(key, deviceId ? 60 : 30, INVITE_LIFETIME);
      if (limit.error) return resultResponse(limit);
      const headers = new Headers(request.headers);
      headers.set('X-Sync-Device', deviceId || '');
      return room.fetch(new Request(request, { headers }));
    }
    if (['GET', 'HEAD'].includes(request.method) && match[2]?.startsWith('/downloads/')) return room.fetch(request);
    const token = request.headers.get('Authorization')?.match(/^Bearer ([0-9a-f]{64})$/)?.[1];
    if (request.method === 'POST' && match[2] === '/messages') {
      if (!token) return json({ error: 'unauthorized' }, 401);
      const body = await readJson(request, 73728);
      if (body.error) return resultResponse(body);
      const { clientId, text, game } = body.value;
      if (typeof clientId !== 'string' || !ROOM_ID.test(clientId)) return json({ error: 'invalid_client_id' }, 400);
      if (!encrypted(text)) return json({ error: 'invalid_text' }, 400);
      if (game !== undefined && game !== 'gomoku') return json({ error: 'game_invalid_move' }, 400);
      const result = await registry.storeMessage(roomId, token, clientId, text, request.headers.get('X-Sync-Key-Id'), game);
      if (result.error) return resultResponse(result);
      return json(result.message, result.created ? 201 : 200);
    }
    const deviceId = token ? await room.authorize(token) : null;
    if (!deviceId) return json({ error: 'unauthorized' }, 401);
    const keyId = request.headers.get('X-Sync-Key-Id');
    if (match[2] === '/profile') {
      if (request.method === 'GET') return resultResponse(await room.readSpaceProfile(deviceId));
      if (request.method !== 'PATCH') return json({ error: 'not_found' }, 404);
      const body = await readJson(request, 8192);
      if (body.error) return resultResponse(body);
      if (Object.keys(body.value).some(key => key !== 'name') || !encrypted(body.value.name, 4096)) return json({ error: 'invalid_name' }, 400);
      return resultResponse(await room.renameSpace(deviceId, body.value.name, keyId));
    }
    if (gamePath) {
      if (!ROOM_ID.test(gamePath[1])) return json({ error: 'game_not_found' }, 404);
      if (request.method === 'GET' && !gamePath[2]) return resultResponse(await room.readGame(deviceId, gamePath[1]));
      if (request.method !== 'POST' || !gamePath[2]) return json({ error: 'not_found' }, 404);
      const body = await readJson(request);
      if (body.error) return resultResponse(body);
      return resultResponse(await room.updateGame(deviceId, keyId, gamePath[1], gamePath[2], body.value));
    }
    if (request.method === 'GET' && match[2] === '/key-grants') return resultResponse(await room.keyGrants(deviceId, keyId));
    if (request.method === 'DELETE' && match[2] === '/key-grants') {
      const body = await readJson(request);
      if (body.error) return resultResponse(body);
      if (!Number.isSafeInteger(body.value.through) || body.value.through < 1) return json({ error: 'invalid_cursor' }, 400);
      return resultResponse(await room.ackKeyGrants(deviceId, body.value.through));
    }
    if (request.method === 'POST' && match[2] === '/key-rotation') {
      const body = await readJson(request, 8 * 1024 * 1024);
      if (body.error) return resultResponse(body);
      if (!rotationFields(body.value) || !(body.value.removedDeviceId === null || ROOM_ID.test(body.value.removedDeviceId))) return json({ error: 'invalid_rotation' }, 400);
      return resultResponse(await registry.rotateKeys(roomId, deviceId, keyId, body.value));
    }
    const guarded = (request.method === 'POST' && ['/files/uploads', '/pair-code', '/pair-challenge'].includes(match[2]))
      || (request.method === 'PATCH' && match[3]) || (['PUT', 'POST'].includes(request.method) && match[2]?.startsWith('/files/uploads/'));
    if (guarded) {
      const state = await room.checkWrite(keyId);
      if (state.error) return resultResponse(state);
    }

    if (request.method === 'POST' && match[2] === '/files/uploads') {
      const body = await readJson(request, 73728);
      if (body.error) return resultResponse(body);
      const file = body.value;
      if (typeof file.clientId !== 'string' || !ROOM_ID.test(file.clientId)) return json({ error: 'invalid_client_id' }, 400);
      if (typeof file.name !== 'string' || !ROOM_ID.test(file.name)) return json({ error: 'invalid_file_name' }, 400);
      if (file.type !== 'application/octet-stream') return json({ error: 'invalid_file_type' }, 400);
      if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > FILE_SIZE_LIMIT) return json({ error: 'file_too_large' }, 413);
      if (typeof file.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(file.fingerprint)) return json({ error: 'invalid_fingerprint' }, 400);
      if (!encrypted(file.text)) return json({ error: 'invalid_text' }, 400);
      const result = await registry.prepareUpload(roomId, deviceId, file, keyId);
      const { created, ...response } = result;
      return resultResponse(response, created ? 201 : 200);
    }
    const upload = match[2]?.match(/^\/files\/uploads\/([^/]+)(?:\/chunks\/(0|[1-9][0-9]*)|\/(complete))?$/);
    if (upload && ROOM_ID.test(upload[1])) {
      let result;
      if (request.method === 'POST' && upload[3]) {
        result = await room.completeUpload(deviceId, upload[1], keyId);
      } else if (request.method === 'DELETE' && !upload[2] && !upload[3]) {
        result = await room.cancelUpload(deviceId, upload[1]);
      } else return json({ error: 'not_found' }, 404);
      await registry.refreshRoom(roomId);
      if (result.message) return json(result.message, result.created ? 201 : 200);
      return resultResponse(result);
    }
    const file = match[2]?.match(/^\/files\/([1-9][0-9]*)(\/download)?$/);
    if (file) {
      if (request.method === 'POST' && file[2]) {
        await registry.refreshRoom(roomId);
        return resultResponse(await room.issueDownload(deviceId, file[1]));
      }
      if (['GET', 'HEAD'].includes(request.method) && !file[2]) return room.fetch(request);
    }
    if (request.method === 'GET' && match[2] === '/devices') {
      return resultResponse(await room.listDevices(deviceId));
    }
    if (request.method === 'PATCH' && match[3]) {
      const body = await readJson(request, 8192);
      if (body.error) return resultResponse(body);
      if (!encrypted(body.value.name, 4096)) return json({ error: 'invalid_name' }, 400);
      const result = await room.renameDevice(deviceId, match[3], body.value.name, keyId);
      await registry.refreshRoom(roomId);
      return resultResponse(result);
    }
    if (request.method === 'DELETE' && match[3]) {
      return resultResponse(await registry.removeDevice(roomId, match[3], deviceId));
    }
    if (request.method === 'GET' && !match[2]) {
      await registry.refreshRoom(roomId);
      const info = await room.info();
      if (!info) return json({ error: 'not_found' }, 404);
      return json({ roomId, deviceId, ...info, pairing: await registry.currentInvite(roomId) });
    }
    if (request.method === 'GET' && match[2] === '/pair-code') return json(await registry.currentInvite(roomId));
    if (request.method === 'POST' && match[2] === '/pair-code') {
      const body = await readJson(request, 8192);
      if (body.error) return resultResponse(body);
      if (Object.keys(body.value).some(key => !['offerId', 'secret', 'revision', 'reopen'].includes(key)) || !ROOM_ID.test(body.value.offerId) || !encrypted(body.value.secret, 4096)
        || body.value.revision !== undefined && !Number.isSafeInteger(body.value.revision) || body.value.reopen !== undefined && typeof body.value.reopen !== 'boolean') return json({ error: 'invalid_pairing' }, 400);
      const invite = await registry.createOffer(roomId, deviceId, body.value.offerId, body.value.secret, keyId, body.value);
      if (invite.error) return resultResponse(invite);
      await room.publishPairing(roomId);
      return resultResponse(invite);
    }
    if (request.method === 'PATCH' && match[2] === '/pair-code') {
      const body = await readJson(request, 16384);
      if (body.error) return resultResponse(body);
      const value = body.value;
      if (Object.keys(value).some(key => !['offerId', 'locked', 'secret', 'fixedSecret', 'revision'].includes(key))
        || !ROOM_ID.test(value.offerId) || typeof value.locked !== 'boolean' || !encrypted(value.secret, 4096)
        || !Number.isSafeInteger(value.revision) || (value.locked ? !encrypted(value.fixedSecret, 4096) : value.fixedSecret !== null)) return json({ error: 'invalid_pairing' }, 400);
      const result = await registry.updateOffer(roomId, keyId, value);
      if (!result.error) await room.publishPairing(roomId);
      return resultResponse(result);
    }
    if (request.method === 'DELETE' && match[2] === '/pair-code') {
      const result = await registry.deleteOffer(roomId, keyId);
      if (!result.error) await room.publishPairing(roomId);
      return resultResponse(result);
    }
    if (request.method === 'GET' && match[2] === '/pair-requests') return json(await registry.pendingPairings(roomId, deviceId));
    if (request.method === 'POST' && match[2] === '/pair-challenge') {
      const body = await readJson(request, 12288);
      if (body.error) return resultResponse(body);
      const { requestId, offerId, loginResponse } = body.value;
      if (!ROOM_ID.test(requestId) || !ROOM_ID.test(offerId) || !relayValue(loginResponse)) return json({ error: 'invalid_pairing' }, 400);
      return resultResponse(await registry.challengePairing(roomId, deviceId, requestId, offerId, loginResponse));
    }
    if (request.method === 'POST' && match[2] === '/pair-accept') {
      const body = await readJson(request, 8 * 1024 * 1024);
      if (body.error) return resultResponse(body);
      const { requestId, offerId, deviceId: joinedId, token: joinedToken, name, grant } = body.value;
      if (!ROOM_ID.test(requestId) || !ROOM_ID.test(offerId) || !ROOM_ID.test(joinedId) || !/^[0-9a-f]{64}$/.test(joinedToken) || !encrypted(name, 4096) || !encrypted(grant, 262144, 'pair1') || !rotationFields(body.value)) return json({ error: 'invalid_pairing' }, 400);
      return resultResponse(await registry.acceptPairing(roomId, deviceId, requestId, offerId, joinedId, joinedToken, name, grant, keyId, body.value));
    }
    if (request.method === 'GET' && match[2] === '/messages') {
      const before = url.searchParams.get('before');
      const after = url.searchParams.get('after');
      const limit = url.searchParams.get('limit') || '50';
      if ((before && after) || !/^[1-9][0-9]*$/.test(limit) || Number(limit) > 50 || [before, after].some(value => value !== null && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))))) return json({ error: 'invalid_cursor' }, 400);
      return resultResponse(await room.messagePage({ before: before === null ? null : Number(before), after: after === null ? null : Number(after), limit: Number(limit), generation: url.searchParams.get('generation') }));
    }
    if (request.method === 'DELETE' && match[2] === '/messages') {
      const result = await room.clearMessages(deviceId);
      await registry.refreshRoom(roomId);
      return resultResponse(result);
    }
    if (request.method === 'DELETE' && match[2] === '/device') {
      return resultResponse(await registry.removeDevice(roomId, deviceId));
    }
    return json({ error: 'not_found' }, 404);
  }
};

export class E2eePairingRegistry extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS offers (offer_id TEXT PRIMARY KEY, room_id TEXT NOT NULL UNIQUE, owner_device_id TEXT NOT NULL, secret TEXT NOT NULL, expires_at INTEGER NOT NULL)');
    if (!this.sql.exec('PRAGMA table_info(offers)').toArray().some(column => column.name === 'locked')) this.sql.exec('ALTER TABLE offers ADD COLUMN locked INTEGER NOT NULL DEFAULT 0');
    this.sql.exec('CREATE INDEX IF NOT EXISTS offers_expiry ON offers(expires_at)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS room_pairing (room_id TEXT PRIMARY KEY, locked INTEGER NOT NULL, enabled INTEGER NOT NULL, fixed_secret TEXT, revision INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS pair_requests (request_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, selected_offer TEXT, finish_request TEXT, client_data TEXT, grant TEXT, accepted_device TEXT)');
    const pairColumns = this.sql.exec('PRAGMA table_info(pair_requests)').toArray();
    if (!pairColumns.some(column => column.name === 'room_id')) {
      this.sql.exec('ALTER TABLE pair_requests ADD COLUMN room_id TEXT');
      this.sql.exec('UPDATE pair_requests SET room_id = (SELECT room_id FROM offers WHERE offer_id = selected_offer) WHERE selected_offer IS NOT NULL');
    }
    if (!pairColumns.some(column => column.name === 'committing_until')) this.sql.exec('ALTER TABLE pair_requests ADD COLUMN committing_until INTEGER');
    this.sql.exec("CREATE TABLE IF NOT EXISTS pair_candidates (request_id TEXT NOT NULL, offer_id TEXT NOT NULL, start_request TEXT NOT NULL, challenge TEXT, owner_device_id TEXT NOT NULL, source_id TEXT NOT NULL DEFAULT 'legacy', PRIMARY KEY(request_id, offer_id))");
    if (!this.sql.exec('PRAGMA table_info(pair_candidates)').toArray().some(column => column.name === 'source_id')) {
      this.sql.exec("ALTER TABLE pair_candidates ADD COLUMN source_id TEXT NOT NULL DEFAULT 'legacy'");
    }
    this.sql.exec('CREATE TABLE IF NOT EXISTS attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS attempts_expiry ON attempts(expires_at)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS room_usage (room_id TEXT PRIMARY KEY, bytes INTEGER NOT NULL, oldest_at INTEGER, deleting_files INTEGER)');
    if (!this.sql.exec('PRAGMA table_info(room_usage)').toArray().some(column => column.name === 'deleting_files')) {
      this.sql.exec('ALTER TABLE room_usage ADD COLUMN deleting_files INTEGER');
    }
    const migrateReservations = !this.sql.exec('PRAGMA table_info(room_usage)').toArray().some(column => column.name === 'reserved_bytes');
    if (migrateReservations) this.sql.exec('ALTER TABLE room_usage ADD COLUMN reserved_bytes INTEGER NOT NULL DEFAULT 0');
    this.sql.exec('CREATE TABLE IF NOT EXISTS cleanup (id INTEGER PRIMARY KEY CHECK(id = 1), phase TEXT NOT NULL, cursor TEXT NOT NULL, target_bytes INTEGER)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS maintenance_failures (room_id TEXT PRIMARY KEY, retry_at INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS reservations (room_id TEXT PRIMARY KEY, bytes INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS registry_metadata (key TEXT PRIMARY KEY, value INTEGER NOT NULL)');
    this.roomQueues = new Map();
    this.pairingQueues = new Map();
    if (migrateReservations && this.sql.exec('SELECT 1 FROM room_usage LIMIT 1').toArray().length) {
      this.startCleanup();
      this.ctx.waitUntil(this.resumeCleanup());
    }
  }

  rememberUsage(roomId, usage) {
    this.sql.exec(
      'INSERT INTO room_usage (room_id, bytes, oldest_at, deleting_files, reserved_bytes) VALUES (?, ?, ?, ?, ?) ON CONFLICT(room_id) DO UPDATE SET bytes = excluded.bytes, oldest_at = excluded.oldest_at, deleting_files = excluded.deleting_files, reserved_bytes = excluded.reserved_bytes WHERE room_usage.bytes IS NOT excluded.bytes OR room_usage.oldest_at IS NOT excluded.oldest_at OR room_usage.deleting_files IS NOT excluded.deleting_files OR room_usage.reserved_bytes IS NOT excluded.reserved_bytes',
      roomId, usage.bytes, usage.oldestAt, usage.deletingFiles, usage.reservedBytes
    );
  }

  hasRoom(roomId) {
    return this.sql.exec('SELECT 1 FROM room_usage WHERE room_id = ?', roomId).toArray().length !== 0;
  }

  storageBytes() {
    return this.sql.databaseSize + this.sql.exec('SELECT coalesce(sum(bytes), 0) AS bytes FROM room_usage').one().bytes + this.sql.exec('SELECT coalesce(sum(bytes), 0) AS bytes FROM reservations').one().bytes;
  }

  async resumeCleanup() {
    const state = this.sql.exec('SELECT phase FROM cleanup WHERE id = 1').toArray()[0];
    if (!state) return;
    const alarm = await this.ctx.storage.getAlarm();
    const next = Date.now() + 1000;
    if (alarm === null || (state.phase !== 'retry' && alarm > next)) await this.ctx.storage.setAlarm(next);
  }

  withRoom(roomId, work) {
    const previous = this.roomQueues.get(roomId) || Promise.resolve();
    const pending = previous.then(work);
    const settled = pending.then(() => {}, () => {});
    this.roomQueues.set(roomId, settled);
    settled.then(() => { if (this.roomQueues.get(roomId) === settled) this.roomQueues.delete(roomId); });
    return pending;
  }

  withPairing(requestId, work) {
    const previous = this.pairingQueues.get(requestId) || Promise.resolve();
    const pending = previous.then(work);
    const settled = pending.then(() => {}, () => {});
    this.pairingQueues.set(requestId, settled);
    settled.then(() => { if (this.pairingQueues.get(requestId) === settled) this.pairingQueues.delete(requestId); });
    return pending;
  }

  startCleanup() {
    const started = this.sql.exec("INSERT OR IGNORE INTO cleanup (id, phase, cursor) VALUES (1, 'refresh', '') RETURNING id").toArray().length;
    if (started) this.sql.exec('INSERT INTO registry_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', 'maintenanceStartedAt', Date.now());
  }

  finishCleanup() {
    this.sql.exec('DELETE FROM cleanup');
    this.sql.exec('INSERT INTO registry_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', 'lastMaintenanceSuccessAt', Date.now());
  }

  async maintainRooms() {
    this.startCleanup();
    this.sql.exec("UPDATE cleanup SET phase = CASE WHEN target_bytes IS NULL THEN 'refresh' ELSE 'prune' END, cursor = '' WHERE phase = 'retry'");
    await this.resumeCleanup();
  }

  maintenanceFailed(roomId) {
    this.sql.exec('INSERT INTO maintenance_failures (room_id, retry_at) VALUES (?, ?) ON CONFLICT(room_id) DO UPDATE SET retry_at = excluded.retry_at', roomId, Date.now() + 60000);
    this.sql.exec('INSERT INTO registry_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', 'lastMaintenanceFailureAt', Date.now());
  }

  async refreshMaintenanceRoom(roomId) {
    if (this.sql.exec('SELECT 1 FROM maintenance_failures WHERE room_id = ? AND retry_at > ?', roomId, Date.now()).toArray().length) return;
    try {
      await this.refreshRoom(roomId);
      this.sql.exec('DELETE FROM maintenance_failures WHERE room_id = ?', roomId);
    } catch { this.maintenanceFailed(roomId); }
  }

  async finishMaintenancePass() {
    const retryAt = this.sql.exec('SELECT min(retry_at) AS retryAt FROM maintenance_failures').one().retryAt;
    if (retryAt === null) { this.finishCleanup(); return; }
    this.sql.exec("UPDATE cleanup SET target_bytes = CASE WHEN phase IN ('prune', 'retry') AND target_bytes < ? THEN target_bytes ELSE NULL END, phase = 'retry' WHERE id = 1", this.storageBytes());
    await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, retryAt));
  }

  async refreshRoom(roomId) {
    await this.withRoom(roomId, () => this.refreshUsage(roomId));
  }

  async refreshUsage(roomId) {
    if (!this.hasRoom(roomId)) return null;
    const room = this.env.E2EE_SYNC_ROOMS.getByName(roomId);
    const usage = await room.maintain(roomId);
    const invitation = this.currentInvite(roomId);
    if (usage.oldestAt === null && (!invitation?.offerId || invitation.locked) && await room.reclaimIfEmpty()) {
      this.sql.exec('DELETE FROM offers WHERE room_id = ?', roomId);
      this.sql.exec('DELETE FROM room_pairing WHERE room_id = ?', roomId);
      this.sql.exec('DELETE FROM room_usage WHERE room_id = ?', roomId);
      this.sql.exec('DELETE FROM reservations WHERE room_id = ?', roomId);
      return null;
    }
    this.ctx.storage.transactionSync(() => {
      this.rememberUsage(roomId, usage);
      this.sql.exec('DELETE FROM reservations WHERE room_id = ?', roomId);
    });
    return usage;
  }

  reserveCapacity(roomId, bytes) {
    if (this.storageBytes() + bytes >= STORAGE_HIGH_WATER) {
      if (!this.sql.exec('SELECT 1 FROM room_usage WHERE oldest_at IS NOT NULL LIMIT 1').toArray().length) return { error: 'storage_full', status: 507 };
      this.startCleanup();
      this.sql.exec("UPDATE cleanup SET phase = CASE WHEN target_bytes IS NULL THEN 'refresh' ELSE 'prune' END, cursor = '' WHERE phase = 'retry'");
      if (bytes > MESSAGE_WRITE_HEADROOM) this.sql.exec("UPDATE cleanup SET target_bytes = max(coalesce(target_bytes, 0), ?) WHERE id = 1 AND phase = 'refresh'", bytes);
      return { error: 'storage_cleaning', status: 503, retryAfter: 1 };
    }
    this.sql.exec('INSERT INTO reservations (room_id, bytes) VALUES (?, ?)', roomId, bytes);
    return null;
  }

  async commitUsage(roomId, room) {
    const usage = await room.storageUsage();
    this.ctx.storage.transactionSync(() => {
      this.rememberUsage(roomId, usage);
      this.sql.exec('DELETE FROM reservations WHERE room_id = ?', roomId);
    });
  }

  async createSpace(keyId) {
    const roomId = crypto.randomUUID();
    return this.withRoom(roomId, async () => {
      const denied = this.reserveCapacity(roomId, MESSAGE_WRITE_HEADROOM);
      if (denied) { await this.resumeCleanup(); return denied; }
      this.rememberUsage(roomId, { bytes: 0, reservedBytes: 0, oldestAt: null, deletingFiles: 0 });
      const room = this.env.E2EE_SYNC_ROOMS.getByName(roomId);
      const device = await room.initialize(keyId);
      await room.maintain(roomId);
      await this.commitUsage(roomId, room);
      return { roomId, ...device, pairing: null, currentKeyId: keyId, encryptionVersion: 1 };
    });
  }

  async storeMessage(roomId, token, clientId, text, keyId, game) {
    return this.withRoom(roomId, async () => {
      if (!this.hasRoom(roomId)) return { error: 'not_found', status: 404 };
      const room = this.env.E2EE_SYNC_ROOMS.getByName(roomId);
      const prepared = await room.prepareMessage(roomId, token, clientId, text, keyId);
      if (prepared.error) return prepared;
      this.ctx.storage.transactionSync(() => {
        this.rememberUsage(roomId, prepared.usage);
        this.sql.exec('DELETE FROM reservations WHERE room_id = ?', roomId);
      });
      if (prepared.existing) return prepared.existing;
      const denied = this.reserveCapacity(roomId, MESSAGE_WRITE_HEADROOM);
      if (denied) { await this.resumeCleanup(); return denied; }
      let committed = false;
      try {
        const { usage, ...result } = await room.addMessage(prepared.deviceId, clientId, text, keyId, game);
        if (usage) {
          this.ctx.storage.transactionSync(() => {
            this.rememberUsage(roomId, usage);
            this.sql.exec('DELETE FROM reservations WHERE room_id = ?', roomId);
          });
          committed = true;
        }
        return result;
      } finally { if (!committed) await this.commitUsage(roomId, room); }
    });
  }

  async prepareUpload(roomId, deviceId, file, keyId) {
    return this.withRoom(roomId, async () => {
      if (!this.hasRoom(roomId)) return { error: 'not_found', status: 404 };
      const room = this.env.E2EE_SYNC_ROOMS.getByName(roomId);
      if (!await this.refreshUsage(roomId)) return { error: 'not_found', status: 404 };
      const existing = await room.uploadInfo(deviceId, file.clientId, file) || await room.findMessage(deviceId, file.clientId);
      if (existing) return existing.uploadId ? room.beginUpload(deviceId, file, keyId) : existing;
      const denied = this.reserveCapacity(roomId, fileReserve(file.size));
      if (denied) { await this.resumeCleanup(); return denied; }
      try { return await room.beginUpload(deviceId, file, keyId); }
      finally { await this.commitUsage(roomId, room); }
    });
  }

  async publicStatus() {
    const [status, dailyUsage] = await Promise.all([this.diagnostics(), this.dailyUsage()]);
    return { ...status, dailyUsage };
  }

  diagnostics() {
    if (this.diagnosticsCacheUntil > Date.now()) return this.diagnosticsCache;
    if (this.diagnosticsRefresh) return this.diagnosticsRefresh;
    this.diagnosticsRefresh = this.collectDiagnostics().then(status => {
      if (status.ok) {
        this.diagnosticsCache = status;
        this.diagnosticsCacheUntil = status.checkedAt + 15000;
      }
      return status;
    }).finally(() => { this.diagnosticsRefresh = null; });
    return this.diagnosticsRefresh;
  }

  async collectDiagnostics() {
    const checkedAt = Date.now();
    const probe = this.sql.exec('SELECT 1 AS ok').one().ok === 1;
    const metadata = Object.fromEntries(this.sql.exec('SELECT key, value FROM registry_metadata').toArray().map(row => [row.key, row.value]));
    const cleanup = this.sql.exec('SELECT phase, cursor, target_bytes AS targetBytes FROM cleanup WHERE id = 1').toArray()[0];
    const roomCount = this.sql.exec('SELECT count(*) AS count FROM room_usage').one().count;
    const rooms = this.sql.exec('SELECT coalesce(sum(bytes), 0) AS bytes, coalesce(sum(reserved_bytes), 0) AS reservedBytes FROM room_usage').one();
    const roomBytes = rooms.bytes;
    const pendingReservations = this.sql.exec('SELECT coalesce(sum(bytes), 0) AS bytes FROM reservations').one().bytes;
    const reservedBytes = rooms.reservedBytes + pendingReservations;
    const storedBytes = this.sql.databaseSize + roomBytes - rooms.reservedBytes;
    const sample = this.sql.exec('SELECT room_id FROM room_usage WHERE room_id > ? ORDER BY room_id LIMIT 1', this.diagnosticRoomCursor || '').toArray()[0]
      || this.sql.exec('SELECT room_id FROM room_usage ORDER BY room_id LIMIT 1').toArray()[0];
    let roomDatabase = null;
    let shardDatabase = null;
    if (sample) {
      this.diagnosticRoomCursor = sample.room_id;
      const result = await rpcResult(this.env.E2EE_SYNC_ROOMS.getByName(sample.room_id).databaseProbe(), 2500);
      if (result.ok) {
        const { sampledShard, ...room } = result.value;
        roomDatabase = room;
        shardDatabase = sampledShard;
      }
      else roomDatabase = { ok: false };
    }
    const nextAlarmAt = await this.ctx.storage.getAlarm();
    const lastSuccessAt = metadata.lastMaintenanceSuccessAt || null;
    const lastFailureAt = metadata.lastMaintenanceFailureAt || null;
    const stale = !lastSuccessAt || checkedAt - lastSuccessAt > 26 * 60 * 60 * 1000;
    const overdue = Boolean(cleanup && (nextAlarmAt === null || nextAlarmAt < checkedAt - 60000)) || Boolean(lastSuccessAt && stale);
    const failed = Boolean(lastFailureAt && (!lastSuccessAt || lastFailureAt > lastSuccessAt));
    const status = overdue ? 'overdue' : cleanup ? 'running' : failed ? 'failed' : !lastSuccessAt ? 'never' : 'healthy';
    return {
      ok: probe && roomDatabase?.ok !== false && shardDatabase?.ok !== false, checkedAt,
      database: { registry: { ok: probe, bytes: this.sql.databaseSize }, sampledRoom: roomDatabase, sampledShard: shardDatabase },
      storage: { scope: 'this-project', bytes: storedBytes + reservedBytes, storedBytes, roomBytes, reservedBytes, roomCount, highWaterBytes: STORAGE_HIGH_WATER, cleanupBytes: STORAGE_CLEANUP_BYTES, accountUsageAvailable: false },
      maintenance: { status, stale, overdue, running: Boolean(cleanup), phase: cleanup?.phase || null, failedRooms: this.sql.exec('SELECT count(*) AS count FROM maintenance_failures').one().count, scannedRooms: cleanup?.phase === 'refresh' ? this.sql.exec('SELECT count(*) AS count FROM room_usage WHERE room_id <= ?', cleanup.cursor).one().count : null, targetBytes: cleanup?.targetBytes ?? null, startedAt: metadata.maintenanceStartedAt || null, lastSuccessAt, lastFailureAt, lastFailureCode: failed ? 'maintenance_failed' : null, nextAlarmAt }
    };
  }

  async dailyUsage() {
    const now = Date.now();
    if (!this.env.CF_ACCOUNT_ID || !this.env.CF_ANALYTICS_TOKEN) return unavailableDailyUsage(now, 'not_configured');
    const day = new Date(now).toISOString().slice(0, 10);
    if (this.dailyUsageCache?.day === day && this.dailyUsageCacheUntil > now) return this.dailyUsageCache;
    if (this.dailyUsageRefresh) return this.dailyUsageRefresh;
    const refresh = async () => {
      if (!this.dailyUsageSnapshotLoaded) {
        const saved = await this.ctx.storage.get('dailyUsageCache').catch(() => null);
        this.dailyUsageSnapshot = saved?.snapshot;
        this.dailyUsageCache = saved?.value;
        this.dailyUsageCacheUntil = saved?.expiresAt;
        this.dailyUsageSnapshotLoaded = true;
      }
      if (this.dailyUsageCache?.day === day && this.dailyUsageCacheUntil > now) return this.dailyUsageCache;
      const measured = await collectDailyUsage(this.env, { now, clock: Date.now });
      if (measured.available) {
        this.dailyUsageSnapshot = measured;
        this.dailyUsageCache = measured;
      } else if (this.dailyUsageSnapshot?.day === measured.day) {
        this.dailyUsageCache = { ...this.dailyUsageSnapshot, status: 'stale', stale: true, failureCode: measured.failureCode };
      } else this.dailyUsageCache = measured;
      this.dailyUsageCacheUntil = Date.now() + (measured.available ? 15 * 60 * 1000 : 60 * 1000);
      await this.ctx.storage.put('dailyUsageCache', { value: this.dailyUsageCache, snapshot: this.dailyUsageSnapshot || null, expiresAt: this.dailyUsageCacheUntil }).catch(() => {});
      return this.dailyUsageCache;
    };
    this.dailyUsageRefresh = refresh().finally(() => { this.dailyUsageRefresh = null; });
    return this.dailyUsageRefresh;
  }

  async alarm() {
    try { await this.runMaintenance(); }
    catch {
      this.sql.exec('INSERT INTO registry_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', 'lastMaintenanceFailureAt', Date.now());
      console.error(JSON.stringify({ event: 'sync_maintenance_error', code: 'maintenance_failed' }));
      throw new Error('maintenance_failed');
    }
  }

  async runMaintenance() {
    let state = this.sql.exec('SELECT phase, cursor, target_bytes FROM cleanup WHERE id = 1').toArray()[0];
    if (!state) return;
    if (state.phase === 'retry') {
      const rooms = this.sql.exec('SELECT room_id FROM maintenance_failures WHERE retry_at <= ? ORDER BY retry_at LIMIT 10', Date.now()).toArray();
      await Promise.all(rooms.map(({ room_id }) => this.refreshMaintenanceRoom(room_id)));
      if (state.target_bytes !== null && this.storageBytes() > state.target_bytes && this.sql.exec('SELECT 1 FROM room_usage WHERE oldest_at IS NOT NULL AND room_id NOT IN (SELECT room_id FROM maintenance_failures) LIMIT 1').toArray().length) {
        this.sql.exec("UPDATE cleanup SET phase = 'prune' WHERE id = 1");
        await this.ctx.storage.setAlarm(Date.now() + 1000);
        return;
      }
      await this.finishMaintenancePass();
      return;
    }
    if (state.phase === 'refresh') {
      const rooms = this.sql.exec('SELECT room_id FROM room_usage WHERE room_id > ? ORDER BY room_id LIMIT 10', state.cursor).toArray();
      await Promise.all(rooms.map(({ room_id: roomId }) => this.refreshMaintenanceRoom(roomId)));
      if (rooms.length === 10) {
        this.sql.exec('UPDATE cleanup SET cursor = ? WHERE id = 1', rooms[9].room_id);
        await this.ctx.storage.setAlarm(Date.now() + 1000);
        return;
      }
      const total = this.storageBytes();
      const pending = this.sql.exec('SELECT target_bytes FROM cleanup WHERE id = 1').one().target_bytes;
      if (total + Math.max(MESSAGE_WRITE_HEADROOM, pending || 0) < STORAGE_HIGH_WATER) { await this.finishMaintenancePass(); return; }
      state = { phase: 'prune', target_bytes: Math.max(0, total - STORAGE_CLEANUP_BYTES) };
      this.sql.exec("UPDATE cleanup SET phase = 'prune', target_bytes = ? WHERE id = 1", state.target_bytes);
      await this.ctx.storage.setAlarm(Date.now() + 1000);
      return;
    }
    for (let batch = 0; batch < 10 && this.storageBytes() > state.target_bytes; batch += 1) {
      const pending = this.sql.exec('SELECT room_id FROM room_usage WHERE (deleting_files IS NULL OR deleting_files > 0) AND room_id NOT IN (SELECT room_id FROM maintenance_failures) ORDER BY oldest_at, room_id LIMIT 1').toArray()[0];
      if (pending) { await this.refreshMaintenanceRoom(pending.room_id); continue; }
      const oldest = this.sql.exec('SELECT room_id, oldest_at FROM room_usage WHERE oldest_at IS NOT NULL AND room_id NOT IN (SELECT room_id FROM maintenance_failures) ORDER BY oldest_at, room_id LIMIT 1').toArray()[0];
      if (!oldest) break;
      try { await this.withRoom(oldest.room_id, async () => {
        const usage = await this.refreshUsage(oldest.room_id);
        if (!usage || this.storageBytes() <= state.target_bytes || usage.deletingFiles) return;
        const first = this.sql.exec('SELECT room_id, oldest_at FROM room_usage WHERE oldest_at IS NOT NULL AND room_id NOT IN (SELECT room_id FROM maintenance_failures) ORDER BY oldest_at, room_id LIMIT 2').toArray();
        if (first[0]?.room_id !== oldest.room_id) return;
        this.rememberUsage(oldest.room_id, await this.env.E2EE_SYNC_ROOMS.getByName(oldest.room_id).pruneOldest(first[1]?.oldest_at ?? Number.MAX_SAFE_INTEGER));
      }); } catch { this.maintenanceFailed(oldest.room_id); }
    }
    if (this.storageBytes() <= state.target_bytes || !this.sql.exec('SELECT 1 FROM room_usage WHERE oldest_at IS NOT NULL AND room_id NOT IN (SELECT room_id FROM maintenance_failures) LIMIT 1').toArray().length) await this.finishMaintenancePass();
    else await this.ctx.storage.setAlarm(Date.now() + 1000);
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

  prunePairings() {
    const now = Date.now();
    this.sql.exec('DELETE FROM offers WHERE locked = 0 AND expires_at <= ?', now);
    const active = [...this.pairingQueues.keys()];
    const expired = `expires_at <= ? AND (committing_until IS NULL OR committing_until <= ?)${active.length ? ` AND request_id NOT IN (${active.map(() => '?').join(',')})` : ''}`;
    this.sql.exec(`DELETE FROM pair_candidates WHERE request_id IN (SELECT request_id FROM pair_requests WHERE ${expired})`, now, now, ...active);
    this.sql.exec(`DELETE FROM pair_requests WHERE ${expired}`, now, now, ...active);
  }

  async publicOffers(ipHash) {
    const now = Date.now();
    if (!this.discoveryWindow || this.discoveryWindow.expiresAt <= now) this.discoveryWindow = { expiresAt: now + 60000, attempts: new Map() };
    const attempts = this.discoveryWindow.attempts.get(ipHash) || 0;
    if (attempts >= 10 || (!attempts && this.discoveryWindow.attempts.size >= 1024)) return { error: 'rate_limited', status: 429, retryAfter: Math.max(1, Math.ceil((this.discoveryWindow.expiresAt - now) / 1000)) };
    this.discoveryWindow.attempts.set(ipHash, attempts + 1);
    this.prunePairings();
    const offers = this.sql.exec('SELECT offer_id AS offerId, room_id AS roomId, owner_device_id AS ownerDeviceId, CASE WHEN locked = 1 THEN NULL ELSE expires_at END AS expiresAt FROM offers ORDER BY expires_at, offer_id LIMIT ?', PAIR_CANDIDATE_LIMIT).toArray();
    const snapshot = JSON.stringify(offers);
    if (this.discoveryCache?.snapshot === snapshot && this.discoveryCache.expiresAt > now) return this.discoveryCache.result;
    if (this.discoveryRefresh?.snapshot === snapshot) return this.discoveryRefresh.promise;
    const refresh = { snapshot };
    refresh.promise = (async () => {
      const online = await Promise.all(offers.map(offer => rpcResult(this.env.E2EE_SYNC_ROOMS.getByName(offer.roomId).deviceOnline(offer.ownerDeviceId))));
      const current = new Set(this.sql.exec('SELECT offer_id AS offerId, room_id AS roomId, owner_device_id AS ownerDeviceId, CASE WHEN locked = 1 THEN NULL ELSE expires_at END AS expiresAt FROM offers WHERE (locked = 1 OR expires_at > ?)', Date.now()).toArray().map(offer => JSON.stringify(offer)));
      // Unknown candidates must still answer PAKE so duplicate codes cannot be mistaken for a unique match.
      const result = { offers: offers.filter((offer, index) => (!online[index].ok || online[index].value) && current.has(JSON.stringify(offer))).map(({ offerId, expiresAt }) => ({ offerId, expiresAt })) };
      if (this.discoveryRefresh === refresh && online.every(probe => probe.ok)) {
        this.discoveryCache = { snapshot, result, expiresAt: Math.min(Date.now() + PAIR_DISCOVERY_CACHE_LIFETIME, ...offers.map(offer => offer.expiresAt ?? Infinity)) };
      }
      return result;
    })().finally(() => { if (this.discoveryRefresh === refresh) this.discoveryRefresh = null; });
    this.discoveryRefresh = refresh;
    return refresh.promise;
  }

  removeDevice(roomId, deviceId, requesterId = deviceId) {
    return this.withRoom(roomId, async () => {
      const room = this.env.E2EE_SYNC_ROOMS.getByName(roomId);
      const result = await room.removeDevice(deviceId, requesterId);
      if (result.error) return result;
      if (this.sql.exec('SELECT 1 FROM offers WHERE room_id = ? AND owner_device_id = ?', roomId, deviceId).toArray().length) {
        this.invalidateOffer(roomId);
        await room.publishPairing(roomId);
      }
      await this.refreshUsage(roomId);
      return result;
    });
  }

  invalidateDiscovery() {
    this.discoveryCache = null;
    this.discoveryRefresh = null;
  }

  pairingPolicy(roomId) {
    const policy = this.sql.exec('SELECT locked, enabled, fixed_secret AS fixedSecret, revision FROM room_pairing WHERE room_id = ?', roomId).toArray()[0];
    return policy ? { ...policy, locked: !!policy.locked, enabled: !!policy.enabled } : null;
  }

  currentInvite(roomId, presenceChanged = false) {
    if (presenceChanged) this.invalidateDiscovery();
    const policy = this.pairingPolicy(roomId);
    const offer = this.sql.exec('SELECT offer_id AS offerId, owner_device_id AS ownerDeviceId, secret, expires_at AS expiresAt, locked FROM offers WHERE room_id = ? AND (locked = 1 OR expires_at > ?)', roomId, Date.now()).toArray()[0];
    if (!offer) return policy;
    return { ...offer, locked: !!offer.locked, enabled: true, fixedSecret: null, revision: offer.expiresAt, ...policy, expiresAt: offer.locked ? null : offer.expiresAt };
  }

  savePairingPolicy(roomId, { locked, enabled, fixedSecret, revision }) {
    const nextRevision = Math.max(Date.now(), revision + 1);
    this.sql.exec('INSERT INTO room_pairing (room_id, locked, enabled, fixed_secret, revision) VALUES (?, ?, ?, ?, ?) ON CONFLICT(room_id) DO UPDATE SET locked = excluded.locked, enabled = excluded.enabled, fixed_secret = excluded.fixed_secret, revision = excluded.revision', roomId, locked ? 1 : 0, enabled ? 1 : 0, fixedSecret, nextRevision);
    this.invalidateDiscovery();
  }

  invalidateOffer(roomId) {
    this.sql.exec('DELETE FROM offers WHERE room_id = ?', roomId);
    const policy = this.pairingPolicy(roomId);
    if (policy) this.savePairingPolicy(roomId, policy);
    else this.invalidateDiscovery();
  }

  createOffer(roomId, deviceId, offerId, secret, keyId, { revision, reopen = false } = {}) {
    return this.withRoom(roomId, async () => {
      this.prunePairings();
      const room = this.env.E2EE_SYNC_ROOMS.getByName(roomId);
      const denied = await room.checkWrite(keyId, secret);
      if (denied.error) return denied;
      const policy = this.pairingPolicy(roomId);
      if (policy && revision !== policy.revision) return { error: 'pairing_conflict', status: 409 };
      if (policy && !policy.enabled && !reopen) return { error: 'pairing_closed', status: 409 };
      const existing = this.currentInvite(roomId);
      if (existing?.offerId && existing.ownerDeviceId === deviceId) return existing;
      if (existing?.offerId && await room.deviceOnline(existing.ownerDeviceId)) {
        const current = this.currentInvite(roomId);
        if (current?.offerId === existing.offerId) return current;
      }
      this.prunePairings();
      if (!this.currentInvite(roomId)?.offerId && this.sql.exec('SELECT count(*) AS count FROM offers').one().count >= PAIR_CANDIDATE_LIMIT) return { error: 'pairing_busy', status: 503, retryAfter: 60 };
      this.sql.exec('DELETE FROM offers WHERE room_id = ?', roomId);
      this.sql.exec('INSERT INTO offers (offer_id, room_id, owner_device_id, secret, expires_at, locked) VALUES (?, ?, ?, ?, ?, ?)', offerId, roomId, deviceId, secret, Date.now() + INVITE_LIFETIME, policy?.locked ? 1 : 0);
      if (policy) this.savePairingPolicy(roomId, { ...policy, enabled: true });
      else this.invalidateDiscovery();
      return this.currentInvite(roomId);
    });
  }

  updateOffer(roomId, keyId, update) {
    return this.withRoom(roomId, async () => {
      const room = this.env.E2EE_SYNC_ROOMS.getByName(roomId);
      const denied = await room.checkWrite(keyId, update.secret);
      if (denied.error) return denied;
      if (update.locked) {
        const fixedDenied = await room.checkWrite(keyId, update.fixedSecret);
        if (fixedDenied.error) return fixedDenied;
      }
      const existing = this.currentInvite(roomId);
      if (!existing?.offerId || existing.offerId !== update.offerId || existing.revision !== update.revision) return { error: 'pairing_conflict', status: 409 };
      this.sql.exec('UPDATE offers SET secret = ?, locked = ?, expires_at = ? WHERE room_id = ?', update.secret, update.locked ? 1 : 0, Date.now() + INVITE_LIFETIME, roomId);
      this.savePairingPolicy(roomId, { locked: update.locked, enabled: true, fixedSecret: update.locked ? update.fixedSecret : null, revision: existing.revision });
      return this.currentInvite(roomId);
    });
  }

  deleteOffer(roomId, keyId) {
    return this.withRoom(roomId, async () => {
      const denied = await this.env.E2EE_SYNC_ROOMS.getByName(roomId).checkWrite(keyId);
      if (denied.error) return denied;
      const existing = this.currentInvite(roomId);
      this.sql.exec('DELETE FROM offers WHERE room_id = ?', roomId);
      this.savePairingPolicy(roomId, { locked: false, enabled: false, fixedSecret: null, revision: existing?.revision || 0 });
      return this.currentInvite(roomId);
    });
  }

  async startPairing(requestId, requestToken, requests, ipHash) {
    this.prunePairings();
    const tokenHash = await hash(requestToken);
    const sourceIds = await Promise.all(requests.map(value => hash(`${value.offerId}:${ipHash}`)));
    const existing = this.sql.exec('SELECT token_hash FROM pair_requests WHERE request_id = ?', requestId).toArray()[0];
    if (existing) {
      if (existing.token_hash !== tokenHash) return { error: 'unauthorized', status: 401 };
      const candidates = this.sql.exec('SELECT offer_id AS offerId, start_request AS startLoginRequest FROM pair_candidates WHERE request_id = ? ORDER BY offer_id', requestId).toArray();
      if (JSON.stringify(candidates) !== JSON.stringify([...requests].sort((a, b) => a.offerId.localeCompare(b.offerId)))) return { error: 'pairing_conflict', status: 409 };
      return { requestId };
    }
    if (this.sql.exec('SELECT count(*) AS count FROM pair_requests').one().count >= PAIR_REQUEST_LIMIT) return { error: 'pairing_busy', status: 503, retryAfter: 60 };
    const offers = requests.map((value, index) => ({ ...value, sourceId: sourceIds[index], offer: this.sql.exec('SELECT * FROM offers WHERE offer_id = ? AND (locked = 1 OR expires_at > ?)', value.offerId, Date.now()).toArray()[0] }));
    if (offers.some(value => !value.offer)) return { error: 'code_expired', status: 404 };
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('INSERT INTO pair_requests (request_id, token_hash, expires_at) VALUES (?, ?, ?)', requestId, tokenHash, Date.now() + INVITE_LIFETIME);
      for (const value of offers) this.sql.exec('INSERT INTO pair_candidates (request_id, offer_id, start_request, owner_device_id, source_id) VALUES (?, ?, ?, ?, ?)', requestId, value.offerId, value.startLoginRequest, value.offer.owner_device_id, value.sourceId);
    });
    await Promise.all(offers.map(async value => {
      const room = this.env.E2EE_SYNC_ROOMS.getByName(value.offer.room_id);
      const frame = { type: 'pair-request', requestId, offerId: value.offerId, startLoginRequest: value.startLoginRequest, sourceId: value.sourceId };
      if (!(await rpcResult(room.publishToDevice(value.offer.owner_device_id, frame))).ok) await rpcResult(room.publishToDevice(value.offer.owner_device_id, frame));
    }));
    return { requestId };
  }

  async pairRequest(requestId, token) {
    this.prunePairings();
    const request = this.sql.exec('SELECT * FROM pair_requests WHERE request_id = ?', requestId).toArray()[0];
    if (!request || request.expires_at <= Date.now() && !(request.committing_until > Date.now())) return { error: 'code_expired', status: 404 };
    if (request.token_hash !== await hash(token)) return { error: 'unauthorized', status: 401 };
    return request;
  }

  savePairingAcceptance(request, accepted) {
    Object.assign(request, { grant: accepted.grant, accepted_device: accepted.deviceId, expires_at: Date.now() + INVITE_LIFETIME, committing_until: null });
    this.sql.exec('UPDATE pair_requests SET grant = ?, accepted_device = ?, expires_at = ?, committing_until = NULL WHERE request_id = ?', request.grant, request.accepted_device, request.expires_at, request.request_id);
  }

  async recoverPairing(request, cancel = false) {
    if (!request.grant && request.room_id) return this.withRoom(request.room_id, async () => {
      const room = this.env.E2EE_SYNC_ROOMS.getByName(request.room_id);
      const accepted = await (cancel ? room.cancelPairingAdmission(request.request_id) : room.pairingAcceptance(request.request_id));
      if (accepted) {
        this.savePairingAcceptance(request, accepted);
        if (this.sql.exec('SELECT 1 FROM offers WHERE offer_id = ?', request.selected_offer).toArray().length) {
          this.invalidateOffer(request.room_id);
          await room.publishPairing(request.room_id);
        }
        await this.commitUsage(request.room_id, room);
      }
    });
  }

  readPairing(requestId, token) {
    return this.withPairing(requestId, async () => {
      const request = await this.pairRequest(requestId, token);
      if (request.error) return request;
      await this.recoverPairing(request);
      return { requestId, responses: this.sql.exec('SELECT offer_id AS offerId, challenge AS loginResponse FROM pair_candidates WHERE request_id = ? AND challenge IS NOT NULL', requestId).toArray(), grant: request.grant, offerId: request.selected_offer };
    });
  }

  cancelPairing(requestId, token) {
    return this.withPairing(requestId, async () => {
      const request = await this.pairRequest(requestId, token);
      if (request.error) return request;
      await this.recoverPairing(request, true);
      if (request.grant) return { ok: true, cancelled: false, requestId, offerId: request.selected_offer, grant: request.grant };
      this.sql.exec('DELETE FROM pair_candidates WHERE request_id = ?', requestId);
      this.sql.exec('DELETE FROM pair_requests WHERE request_id = ?', requestId);
      return { ok: true, cancelled: true };
    });
  }

  ackPairing(requestId, token) {
    return this.withPairing(requestId, async () => {
      const request = await this.pairRequest(requestId, token);
      if (request.error) return request;
      await this.recoverPairing(request);
      if (!request.grant) return { error: 'pairing_incomplete', status: 409 };
      this.sql.exec('DELETE FROM pair_candidates WHERE request_id = ?', requestId);
      this.sql.exec('DELETE FROM pair_requests WHERE request_id = ?', requestId);
      return { ok: true };
    });
  }

  finishPairing(requestId, token, offerId, finishLoginRequest, clientData) {
    return this.withPairing(requestId, async () => {
      const request = await this.pairRequest(requestId, token);
      if (request.error) return request;
      const candidate = this.sql.exec('SELECT * FROM pair_candidates WHERE request_id = ? AND offer_id = ? AND challenge IS NOT NULL', requestId, offerId).toArray()[0];
      const offer = this.sql.exec('SELECT * FROM offers WHERE offer_id = ? AND (locked = 1 OR expires_at > ?)', offerId, Date.now()).toArray()[0];
      if (!candidate || !offer || offer.owner_device_id !== candidate.owner_device_id) return { error: 'code_expired', status: 404 };
      if (request.selected_offer && (request.selected_offer !== offerId || request.finish_request !== finishLoginRequest || request.client_data !== clientData)) return { error: 'pairing_conflict', status: 409 };
      this.sql.exec('UPDATE pair_requests SET selected_offer = ?, room_id = ?, finish_request = ?, client_data = ? WHERE request_id = ?', offerId, offer.room_id, finishLoginRequest, clientData, requestId);
      await this.env.E2EE_SYNC_ROOMS.getByName(offer.room_id).publishToDevice(candidate.owner_device_id, { type: 'pair-finish', requestId, offerId, finishLoginRequest, clientData });
      return { ok: true, requestId };
    });
  }

  candidateForOwner(roomId, deviceId, requestId, offerId) {
    this.prunePairings();
    const offer = this.sql.exec('SELECT * FROM offers WHERE offer_id = ? AND room_id = ? AND owner_device_id = ? AND (locked = 1 OR expires_at > ?)', offerId, roomId, deviceId, Date.now()).toArray()[0];
    const candidate = this.sql.exec('SELECT * FROM pair_candidates WHERE request_id = ? AND offer_id = ? AND owner_device_id = ?', requestId, offerId, deviceId).toArray()[0];
    if (!offer || !candidate) return { error: 'code_expired', status: 404 };
    return candidate;
  }

  challengePairing(roomId, deviceId, requestId, offerId, loginResponse) {
    const candidate = this.candidateForOwner(roomId, deviceId, requestId, offerId);
    if (candidate.error) return candidate;
    if (candidate.challenge && candidate.challenge !== loginResponse) return { error: 'pairing_conflict', status: 409 };
    this.sql.exec('UPDATE pair_candidates SET challenge = ? WHERE request_id = ? AND offer_id = ?', loginResponse, requestId, offerId);
    return { accepted: true };
  }

  pendingPairings(roomId, deviceId) {
    this.prunePairings();
    const rows = this.sql.exec('SELECT r.request_id, r.selected_offer, r.finish_request, r.client_data, c.offer_id, c.start_request, c.source_id FROM pair_candidates c JOIN pair_requests r ON r.request_id = c.request_id JOIN offers o ON o.offer_id = c.offer_id WHERE o.room_id = ? AND c.owner_device_id = ? AND r.grant IS NULL ORDER BY r.expires_at, r.request_id', roomId, deviceId).toArray();
    return { requests: rows.map(row => row.selected_offer === row.offer_id ? { type: 'pair-finish', requestId: row.request_id, offerId: row.offer_id, finishLoginRequest: row.finish_request, clientData: row.client_data } : { type: 'pair-request', requestId: row.request_id, offerId: row.offer_id, startLoginRequest: row.start_request, sourceId: row.source_id }) };
  }

  acceptPairing(roomId, deviceId, requestId, offerId, joinedId, token, name, grant, keyId, rotation) {
    return this.withPairing(requestId, () => this.withRoom(roomId, async () => {
      const request = this.sql.exec('SELECT * FROM pair_requests WHERE request_id = ? AND expires_at > ?', requestId, Date.now()).toArray()[0];
      if (request?.grant) return request.accepted_device === joinedId && request.grant === grant ? { ok: true, requestId } : { error: 'pairing_conflict', status: 409 };
      const candidate = this.candidateForOwner(roomId, deviceId, requestId, offerId);
      if (candidate.error) return candidate;
      if (!request || request.selected_offer !== offerId || !request.finish_request || !candidate.challenge) return { error: 'pairing_incomplete', status: 409 };
      const room = this.env.E2EE_SYNC_ROOMS.getByName(roomId);
      this.sql.exec('UPDATE pair_requests SET committing_until = ? WHERE request_id = ?', Date.now() + 2 * INVITE_LIFETIME, requestId);
      const result = await room.admitDevice(deviceId, keyId, { ...rotation, joinedId, tokenHash: await hash(token), name, requestId, grant, expiresAt: request.expires_at });
      if (result.error) {
        this.sql.exec('UPDATE pair_requests SET committing_until = NULL WHERE request_id = ?', requestId);
        return result;
      }
      this.savePairingAcceptance(request, { grant, deviceId: joinedId });
      this.invalidateOffer(roomId);
      await room.publishPairing(roomId);
      await this.commitUsage(roomId, room);
      return { ok: true, requestId };
    }));
  }

  rotateKeys(roomId, deviceId, keyId, rotation) {
    return this.withRoom(roomId, async () => {
      const room = this.env.E2EE_SYNC_ROOMS.getByName(roomId);
      const result = await room.rotateKeys(deviceId, keyId, rotation);
      if (result.error) return result;
      this.invalidateOffer(roomId);
      await room.publishPairing(roomId);
      await this.commitUsage(roomId, room);
      return result;
    });
  }
}

export class E2eeSyncRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.pairingQueue = Promise.resolve();
    this.downloadRevision = 0;
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
    const migrateDeviceActivity = !this.sql.exec('PRAGMA table_info(devices)').toArray().some(column => column.name === 'last_active_at');
    if (migrateDeviceActivity) {
      this.sql.exec('ALTER TABLE devices ADD COLUMN last_active_at INTEGER NOT NULL DEFAULT 0');
      // Existing credentials get a full seven-day grace period when this migration runs.
      this.sql.exec('UPDATE devices SET last_active_at = ?', Date.now());
    }
    if (!this.sql.exec('PRAGMA table_info(devices)').toArray().some(column => column.name === 'read_message_id')) {
      this.sql.exec('ALTER TABLE devices ADD COLUMN read_message_id INTEGER NOT NULL DEFAULT 0');
    }
    this.sql.exec('CREATE INDEX IF NOT EXISTS devices_activity ON devices(last_active_at)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.sql.exec('INSERT OR IGNORE INTO metadata (key, value) VALUES (?, ?)', 'lastActiveAt', String(Date.now()));
    if (migrateDeviceActivity) this.sql.exec('UPDATE metadata SET value = ? WHERE key = ?', String(Date.now()), 'lastActiveAt');
    this.sql.exec('INSERT OR IGNORE INTO metadata (key, value) VALUES (?, ?)', 'historyGeneration', crypto.randomUUID());
    this.lastActivity = Number(this.sql.exec('SELECT value FROM metadata WHERE key = ?', 'lastActiveAt').one().value);
    this.sql.exec('CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id TEXT NOT NULL, device_id TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL, attachment TEXT, UNIQUE(device_id, client_id))');
    if (!this.sql.exec('PRAGMA table_info(messages)').toArray().some(column => column.name === 'attachment')) this.sql.exec('ALTER TABLE messages ADD COLUMN attachment TEXT');
    this.sql.exec('CREATE INDEX IF NOT EXISTS messages_expiry ON messages(created_at)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS gomoku_games (game_id TEXT PRIMARY KEY, message_id INTEGER NOT NULL UNIQUE, host_device_id TEXT NOT NULL, guest_device_id TEXT, status TEXT NOT NULL, revision INTEGER NOT NULL, move_count INTEGER NOT NULL DEFAULT 0, board TEXT, last_move TEXT, last_command_id TEXT, last_command_device_id TEXT, result TEXT, updated_at INTEGER NOT NULL)');
    this.sql.exec("CREATE TRIGGER IF NOT EXISTS delete_message_games AFTER DELETE ON messages BEGIN DELETE FROM gomoku_games WHERE message_id = OLD.id; END");
    this.sql.exec('CREATE TABLE IF NOT EXISTS files (file_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, client_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, message_id INTEGER, reserved_bytes INTEGER NOT NULL, UNIQUE(device_id, client_id))');
    const fileColumns = this.sql.exec('PRAGMA table_info(files)').toArray();
    if (!fileColumns.some(column => column.name === 'received_bytes')) this.sql.exec('ALTER TABLE files ADD COLUMN received_bytes INTEGER');
    if (!fileColumns.some(column => column.name === 'received_chunks')) this.sql.exec('ALTER TABLE files ADD COLUMN received_chunks INTEGER');
    if (!fileColumns.some(column => column.name === 'fingerprint')) this.sql.exec('ALTER TABLE files ADD COLUMN fingerprint TEXT');
    this.sql.exec('CREATE INDEX IF NOT EXISTS files_message ON files(message_id)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS files_status_updated ON files(status, updated_at)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS file_shards (file_id TEXT NOT NULL, shard_index INTEGER NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY(file_id, shard_index))');
    this.sql.exec('CREATE TABLE IF NOT EXISTS file_upload_chunks (file_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, size INTEGER NOT NULL, received INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(file_id, chunk_index))');
    this.sql.exec('CREATE TABLE IF NOT EXISTS pair_acceptances (request_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, token_hash TEXT NOT NULL, rotation_id TEXT NOT NULL, key_id TEXT NOT NULL, grant TEXT NOT NULL, expires_at INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS pair_cancellations (request_id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS key_grants (id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL, rotation_id TEXT NOT NULL, previous_key_id TEXT NOT NULL, new_key_id TEXT NOT NULL, envelope TEXT NOT NULL, UNIQUE(device_id, rotation_id))');
    this.sql.exec('CREATE INDEX IF NOT EXISTS key_grants_device ON key_grants(device_id, id)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS download_tickets (ticket TEXT PRIMARY KEY, file_id TEXT NOT NULL, device_id TEXT NOT NULL, expires_at INTEGER NOT NULL)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS download_tickets_device_file ON download_tickets(device_id, file_id, expires_at)');
    this.sql.exec("CREATE TRIGGER IF NOT EXISTS delete_message_files AFTER DELETE ON messages BEGIN UPDATE files SET status = 'deleting', reserved_bytes = 0 WHERE message_id = OLD.id; END");
    this.initialized = true;
  }

  async initialize(keyId) {
    this.initializeStorage();
    this.sql.exec('INSERT INTO metadata (key, value) VALUES (?, ?)', 'createdAt', String(Date.now()));
    this.sql.exec('INSERT INTO metadata (key, value) VALUES (?, ?)', 'currentKeyId', keyId);
    return this.addDevice();
  }

  async addDevice() {
    if (!this.initialized) return { error: 'not_found', status: 404 };
    const token = credential();
    const deviceId = crypto.randomUUID();
    const now = Date.now();
    this.sql.exec('INSERT INTO devices (token_hash, device_id, created_at, last_active_at) VALUES (?, ?, ?, ?)', await hash(token), deviceId, now, now);
    this.touchActivity();
    await this.scheduleAlarm();
    this.broadcast({ type: 'devices' });
    return { token, deviceId };
  }

  keyState() {
    if (!this.initialized) return { currentKeyId: null, rekeyRequired: false };
    return { currentKeyId: this.sql.exec("SELECT value FROM metadata WHERE key = 'currentKeyId'").toArray()[0]?.value || null,
      rekeyRequired: this.sql.exec("SELECT value FROM metadata WHERE key = 'rekeyRequired'").toArray()[0]?.value === '1' };
  }

  checkWrite(keyId, envelope = null, allowRekey = false) {
    const state = this.keyState();
    if (!keyId || keyId !== state.currentKeyId) return { error: 'key_changed', status: 409 };
    if (state.rekeyRequired && !allowRekey) return { error: 'rekey_required', status: 409 };
    if (envelope !== null && envelopeKey(envelope) !== state.currentKeyId) return { error: 'key_changed', status: 409 };
    return { ok: true };
  }

  deviceOnline(deviceId) {
    return this.ctx.getWebSockets().some(socket => socket.readyState === WebSocket.OPEN && socket.deserializeAttachment()?.deviceId === deviceId && !socket.deserializeAttachment()?.closing);
  }

  publishToDevice(deviceId, frame) {
    for (const socket of this.ctx.getWebSockets()) if (socket.readyState === WebSocket.OPEN && socket.deserializeAttachment()?.deviceId === deviceId && !socket.deserializeAttachment()?.closing) socket.send(JSON.stringify(frame));
  }

  keyGrants(deviceId, keyId) {
    const state = this.keyState();
    if (keyId === state.currentKeyId) return { grants: [], hasMore: false, currentKeyId: state.currentKeyId };
    const start = this.sql.exec('SELECT id FROM key_grants WHERE device_id = ? AND previous_key_id = ? ORDER BY id LIMIT 1', deviceId, keyId).toArray()[0];
    if (!start) return { error: 'key_unavailable', status: 409 };
    const rows = this.sql.exec('SELECT id, rotation_id AS rotationId, envelope FROM key_grants WHERE device_id = ? AND id >= ? ORDER BY id LIMIT 51', deviceId, start.id).toArray();
    return { grants: rows.slice(0, 50), hasMore: rows.length > 50, currentKeyId: state.currentKeyId };
  }

  ackKeyGrants(deviceId, through) {
    this.sql.exec('DELETE FROM key_grants WHERE device_id = ? AND id <= ?', deviceId, through);
    return { ok: true };
  }

  validateRotation(deviceId, keyId, rotation, joining = null) {
    const denied = this.checkWrite(keyId, null, true);
    if (denied.error) return denied;
    const members = this.sql.exec('SELECT device_id FROM devices ORDER BY device_id').toArray().map(value => value.device_id);
    if (!members.includes(deviceId)) return { error: 'unauthorized', status: 401 };
    if (rotation.newKeyId === keyId) return { error: 'invalid_rotation', status: 400 };
    if (rotation.removedDeviceId && (!members.includes(rotation.removedDeviceId) || rotation.removedDeviceId === deviceId)) return { error: 'invalid_rotation', status: 400 };
    const recipients = members.filter(id => id !== rotation.removedDeviceId);
    if (joining && (members.includes(joining.joinedId) || members.length >= 20 || envelopeKey(joining.name) !== rotation.newKeyId)) return { error: 'invalid_pairing', status: 400 };
    if (recipients.length !== rotation.grants.length || rotation.grants.some(grant => !recipients.includes(grant.deviceId) || envelopeKey(grant.envelope) !== keyId)) return { error: 'invalid_rotation', status: 400 };
    if (this.sql.exec('SELECT 1 FROM key_grants WHERE rotation_id = ? LIMIT 1', rotation.rotationId).toArray().length) return { error: 'rotation_conflict', status: 409 };
    return { ok: true };
  }

  applyRotation(keyId, rotation, preserveUploads = false) {
    for (const grant of rotation.grants) this.sql.exec('INSERT INTO key_grants (device_id, rotation_id, previous_key_id, new_key_id, envelope) VALUES (?, ?, ?, ?, ?)', grant.deviceId, rotation.rotationId, keyId, rotation.newKeyId, grant.envelope);
    this.sql.exec("UPDATE metadata SET value = ? WHERE key = 'currentKeyId'", rotation.newKeyId);
    this.sql.exec("INSERT INTO metadata (key, value) VALUES ('rekeyRequired', '0') ON CONFLICT(key) DO UPDATE SET value = '0'");
    if (!preserveUploads) this.sql.exec("UPDATE files SET status = 'deleting', reserved_bytes = 0 WHERE status = 'uploading'");
    if (rotation.removedDeviceId) {
      this.sql.exec('DELETE FROM devices WHERE device_id = ?', rotation.removedDeviceId);
      this.downloadRevision++;
      this.sql.exec('DELETE FROM key_grants WHERE device_id = ?', rotation.removedDeviceId);
    }
    return rotation.removedDeviceId ? this.finishDeviceGames(rotation.removedDeviceId) : [];
  }

  async finishRotation(removedDeviceId, games = []) {
    if (removedDeviceId) for (const socket of this.ctx.getWebSockets()) if (socket.deserializeAttachment()?.deviceId === removedDeviceId) { socket.serializeAttachment({ closing: true }); socket.close(4001, 'Device removed'); }
    this.broadcast({ type: 'key-rotation' });
    this.broadcast({ type: 'devices' });
    for (const game of games) this.broadcast({ type: 'gomoku', game });
    await this.scheduleAlarm();
  }

  async rotateKeys(deviceId, keyId, rotation) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const denied = this.validateRotation(deviceId, keyId, rotation);
      if (denied.error) return denied;
      const games = this.ctx.storage.transactionSync(() => this.applyRotation(keyId, rotation));
      await this.finishRotation(rotation.removedDeviceId, games);
      return { ok: true, currentKeyId: rotation.newKeyId };
    });
  }

  pairingAcceptance(requestId) {
    return this.sql.exec('SELECT device_id AS deviceId, grant FROM pair_acceptances WHERE request_id = ? AND expires_at > ?', requestId, Date.now()).toArray()[0] || null;
  }

  cancelPairingAdmission(requestId) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const accepted = this.pairingAcceptance(requestId);
      if (accepted) return accepted;
      this.sql.exec('DELETE FROM pair_cancellations WHERE expires_at <= ?', Date.now());
      this.sql.exec('INSERT OR REPLACE INTO pair_cancellations (request_id, expires_at) VALUES (?, ?)', requestId, Date.now() + 2 * INVITE_LIFETIME);
      return null;
    });
  }

  async admitDevice(deviceId, keyId, admission) {
    return this.ctx.blockConcurrencyWhile(async () => {
      this.sql.exec('DELETE FROM pair_acceptances WHERE expires_at <= ?', Date.now());
      const accepted = this.sql.exec('SELECT * FROM pair_acceptances WHERE request_id = ?', admission.requestId).toArray()[0];
      if (accepted) return accepted.device_id === admission.joinedId && accepted.token_hash === admission.tokenHash && accepted.rotation_id === admission.rotationId && accepted.key_id === admission.newKeyId && accepted.grant === admission.grant ? { ok: true, currentKeyId: accepted.key_id } : { error: 'pairing_conflict', status: 409 };
      this.sql.exec('DELETE FROM pair_cancellations WHERE expires_at <= ?', Date.now());
      if (admission.expiresAt <= Date.now() || this.sql.exec('SELECT 1 FROM pair_cancellations WHERE request_id = ?', admission.requestId).toArray().length) return { error: 'code_expired', status: 404 };
      const rotation = { ...admission, removedDeviceId: null };
      const denied = this.validateRotation(deviceId, keyId, rotation, admission);
      if (denied.error) return denied;
      this.ctx.storage.transactionSync(() => {
        this.applyRotation(keyId, rotation, !this.keyState().rekeyRequired);
        const now = Date.now();
        this.sql.exec('INSERT INTO devices (token_hash, device_id, created_at, name, last_active_at) VALUES (?, ?, ?, ?, ?)', admission.tokenHash, admission.joinedId, now, admission.name, now);
        this.sql.exec('INSERT INTO pair_acceptances (request_id, device_id, token_hash, rotation_id, key_id, grant, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)', admission.requestId, admission.joinedId, admission.tokenHash, admission.rotationId, admission.newKeyId, admission.grant, Date.now() + INVITE_LIFETIME);
      });
      await this.finishRotation(null);
      return { ok: true, currentKeyId: admission.newKeyId };
    });
  }

  async authorize(token) {
    const tokenHash = await hash(token);
    if (!this.initialized) return null;
    const deviceId = this.sql.exec('SELECT device_id FROM devices WHERE token_hash = ?', tokenHash).toArray()[0]?.device_id || null;
    return deviceId && this.touchDevice(deviceId) ? deviceId : null;
  }

  refreshConnectedDevices() {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment();
      if (!attachment?.deviceId || attachment.closing) continue;
      const lastActiveAt = this.ctx.getWebSocketAutoResponseTimestamp(socket)?.getTime() || attachment.connectedAt;
      if (lastActiveAt) this.sql.exec('UPDATE devices SET last_active_at = ? WHERE device_id = ? AND last_active_at <= ?', lastActiveAt, attachment.deviceId, lastActiveAt - DEVICE_ACTIVITY_WRITE_INTERVAL);
    }
  }

  touchDevice(deviceId) {
    this.refreshConnectedDevices();
    const device = this.sql.exec('SELECT last_active_at FROM devices WHERE device_id = ?', deviceId).toArray()[0];
    if (!device) return false;
    const now = Date.now();
    if (device.last_active_at + DEVICE_IDLE_LIFETIME <= now) {
      this.removeDevice(deviceId);
      return false;
    }
    if (now - device.last_active_at >= DEVICE_ACTIVITY_WRITE_INTERVAL) this.sql.exec('UPDATE devices SET last_active_at = ? WHERE device_id = ?', now, deviceId);
    this.touchActivity();
    return true;
  }

  touchActivity() {
    const now = Date.now();
    if (now - this.lastActivity < ACTIVITY_WRITE_INTERVAL) return;
    this.sql.exec('UPDATE metadata SET value = ? WHERE key = ?', String(now), 'lastActiveAt');
    this.lastActivity = now;
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

  renameDevice(deviceId, targetDeviceId, name, keyId) {
    const denied = this.checkWrite(keyId, name);
    if (denied.error) return denied;
    if (!this.initialized || !this.sql.exec('SELECT 1 FROM devices WHERE device_id = ?', deviceId).toArray().length) {
      return { error: 'unauthorized', status: 401 };
    }
    if (!this.sql.exec('UPDATE devices SET name = ? WHERE device_id = ? RETURNING device_id', name, targetDeviceId).toArray().length) {
      return { error: 'device_not_found', status: 404 };
    }
    this.broadcast({ type: 'devices' });
    return { ok: true };
  }

  spaceProfile() {
    const saved = this.sql.exec("SELECT value FROM metadata WHERE key = 'spaceProfile'").toArray()[0];
    return saved ? JSON.parse(saved.value) : { name: null, revision: 0 };
  }

  readSpaceProfile(deviceId) {
    if (!this.initialized || !this.sql.exec('SELECT 1 FROM devices WHERE device_id = ?', deviceId).toArray().length) return { error: 'unauthorized', status: 401 };
    return { profile: this.spaceProfile() };
  }

  renameSpace(deviceId, name, keyId) {
    if (!this.initialized || !this.sql.exec('SELECT 1 FROM devices WHERE device_id = ?', deviceId).toArray().length) return { error: 'unauthorized', status: 401 };
    const denied = this.checkWrite(keyId, name);
    if (denied.error) return denied;
    const profile = this.spaceProfile();
    if (profile.name === name) return { profile };
    profile.name = name;
    profile.revision++;
    this.sql.exec("INSERT INTO metadata (key, value) VALUES ('spaceProfile', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(profile));
    this.broadcast({ type: 'space-profile', profile });
    return { profile };
  }

  info() {
    if (!this.initialized) return null;
    return {
      ...this.keyState(),
      encryptionVersion: 1,
      spaceProfile: this.spaceProfile(),
      createdAt: Number(this.sql.exec('SELECT value FROM metadata WHERE key = ?', 'createdAt').one().value),
      ...this.messagePage()
    };
  }

  messages() {
    if (!this.initialized) return [];
    return this.decorateMessages(this.sql.exec('SELECT id, client_id AS clientId, device_id AS deviceId, text, created_at AS createdAt, attachment FROM messages ORDER BY id').toArray());
  }

  gameSnapshot(game, includeBoard = game.status === 'waiting' || game.status === 'playing') {
    return {
      id: game.game_id, messageId: game.message_id, hostDeviceId: game.host_device_id,
      guestDeviceId: game.guest_device_id, status: game.status, revision: game.revision,
      turnDeviceId: game.status === 'playing' ? (game.move_count % 2 ? game.guest_device_id : game.host_device_id) : null,
      canViewBoard: game.status === 'finished' && !!game.board,
      ...(includeBoard && game.board ? { board: JSON.parse(game.board) } : {}),
      lastMove: includeBoard && game.last_move ? JSON.parse(game.last_move) : null,
      result: game.result ? JSON.parse(game.result) : null, updatedAt: game.updated_at
    };
  }

  activeGames() {
    return this.sql.exec("SELECT * FROM gomoku_games WHERE status IN ('waiting', 'playing')").toArray().map(game => this.gameSnapshot(game));
  }

  decorateMessages(rows) {
    if (!rows.length) return [];
    const games = new Map(this.sql.exec(`SELECT * FROM gomoku_games WHERE message_id IN (${rows.map(() => '?').join(',')})`, ...rows.map(row => row.id))
      .toArray().map(game => [game.message_id, this.gameSnapshot(game, false)]));
    return rows.map(row => ({ ...publicMessage(row), ...(games.has(row.id) ? { game: games.get(row.id) } : {}) }));
  }

  readGame(deviceId, gameId) {
    if (!this.initialized) return { error: 'game_not_found', status: 404 };
    this.pruneExpired();
    if (!this.sql.exec('SELECT 1 FROM devices WHERE device_id = ?', deviceId).toArray().length) return { error: 'unauthorized', status: 401 };
    const game = this.sql.exec('SELECT * FROM gomoku_games WHERE game_id = ?', gameId).toArray()[0];
    return game ? { game: this.gameSnapshot(game, true) } : { error: 'game_not_found', status: 404 };
  }

  finishGame(game, winnerDeviceId, reason) {
    const result = game.status === 'waiting' ? null : {
      winnerDeviceId, reason, hostMoves: Math.ceil(game.move_count / 2), guestMoves: Math.floor(game.move_count / 2),
      hostScore: reason === 'draw' || winnerDeviceId === game.host_device_id ? 1 : 0,
      guestScore: reason === 'draw' || winnerDeviceId === game.guest_device_id ? 1 : 0
    };
    game.status = game.status === 'waiting' ? 'cancelled' : 'finished';
    game.revision++;
    game.updated_at = Date.now();
    if (game.status === 'cancelled') {
      game.board = null;
      game.last_move = null;
    }
    game.result = result ? JSON.stringify(result) : null;
    this.sql.exec('UPDATE gomoku_games SET status = ?, revision = ?, move_count = ?, board = ?, last_move = ?, last_command_id = ?, last_command_device_id = ?, result = ?, updated_at = ? WHERE game_id = ?',
      game.status, game.revision, game.move_count, game.board, game.last_move, game.last_command_id, game.last_command_device_id, game.result, game.updated_at, game.game_id);
    return this.gameSnapshot(game);
  }

  finishDeviceGames(deviceId) {
    return this.sql.exec("SELECT * FROM gomoku_games WHERE status IN ('waiting', 'playing') AND (host_device_id = ? OR guest_device_id = ?)", deviceId, deviceId).toArray()
      .map(game => this.finishGame(game, game.host_device_id === deviceId ? game.guest_device_id : game.host_device_id, 'device-left'));
  }

  updateGame(deviceId, keyId, gameId, action, value) {
    if (!this.initialized) return { error: 'game_not_found', status: 404 };
    if (!this.sql.exec('SELECT 1 FROM devices WHERE device_id = ?', deviceId).toArray().length) return { error: 'unauthorized', status: 401 };
    const denied = this.checkWrite(keyId);
    if (denied.error) return denied;
    let changed = false;
    let expired = false;
    const result = this.ctx.storage.transactionSync(() => {
      const game = this.sql.exec('SELECT g.*, m.created_at FROM gomoku_games g JOIN messages m ON m.id = g.message_id WHERE g.game_id = ?', gameId).toArray()[0];
      if (!game) return { error: 'game_not_found', status: 404 };
      if (game.created_at + MESSAGE_LIFETIME <= Date.now()) {
        this.sql.exec('DELETE FROM messages WHERE id = ?', game.message_id);
        expired = true;
        return { error: 'game_not_found', status: 404 };
      }
      const reject = (error, status = 409) => ({ error, status, game: this.gameSnapshot(game) });
      if (action === 'join') {
        if (Object.keys(value).length) return reject('game_invalid_move', 400);
        if (game.host_device_id === deviceId || game.guest_device_id === deviceId || game.status !== 'waiting') return { game: this.gameSnapshot(game) };
        if (this.sql.exec("SELECT 1 FROM gomoku_games WHERE status IN ('waiting', 'playing') AND (host_device_id = ? OR guest_device_id = ?)", deviceId, deviceId).toArray().length) return reject('game_busy');
        this.sql.exec("UPDATE gomoku_games SET guest_device_id = ?, status = 'playing', revision = revision + 1, updated_at = ? WHERE game_id = ? AND status = 'waiting' AND guest_device_id IS NULL", deviceId, Date.now(), gameId);
        changed = true;
        return { game: this.gameSnapshot(this.sql.exec('SELECT * FROM gomoku_games WHERE game_id = ?', gameId).one()) };
      }
      if (game.host_device_id !== deviceId && game.guest_device_id !== deviceId) return reject('game_not_player', 403);
      if (action === 'leave') {
        if (Object.keys(value).length) return reject('game_invalid_move', 400);
        if (!['waiting', 'playing'].includes(game.status)) return { game: this.gameSnapshot(game) };
        changed = true;
        return { game: this.finishGame(game, game.host_device_id === deviceId ? game.guest_device_id : game.host_device_id, 'resigned') };
      }
      const { revision, commandId, row, col } = value;
      if (Object.keys(value).some(key => !['revision', 'commandId', 'row', 'col'].includes(key)) || !Number.isSafeInteger(revision) || revision < 1
        || !ROOM_ID.test(commandId) || !Number.isInteger(row) || row < 0 || row >= 15 || !Number.isInteger(col) || col < 0 || col >= 15) return reject('game_invalid_move', 400);
      if (game.last_command_id === commandId && game.last_command_device_id === deviceId) return { game: this.gameSnapshot(game) };
      if (game.status !== 'playing' || game.revision !== revision) return reject('game_conflict');
      const player = game.move_count % 2 ? 2 : 1;
      if (deviceId !== (player === 1 ? game.host_device_id : game.guest_device_id)) return reject('game_not_turn');
      const board = JSON.parse(game.board);
      if (board[row * 15 + col]) return reject('game_invalid_move', 400);
      board[row * 15 + col] = player;
      game.move_count++;
      game.last_command_id = commandId;
      game.last_command_device_id = deviceId;
      let won = false;
      for (const [dr, dc] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
        let count = 1;
        for (const sign of [-1, 1]) {
          let r = row + dr * sign;
          let c = col + dc * sign;
          while (r >= 0 && r < 15 && c >= 0 && c < 15 && board[r * 15 + c] === player) { count++; r += dr * sign; c += dc * sign; }
        }
        if (count >= 5) { won = true; break; }
      }
      changed = true;
      game.board = JSON.stringify(board);
      game.last_move = JSON.stringify({ row, col });
      if (won || game.move_count === 225) return { game: this.finishGame(game, won ? deviceId : null, won ? 'five' : 'draw') };
      game.revision++;
      game.updated_at = Date.now();
      this.sql.exec('UPDATE gomoku_games SET revision = ?, move_count = ?, board = ?, last_move = ?, last_command_id = ?, last_command_device_id = ?, updated_at = ? WHERE game_id = ?',
        game.revision, game.move_count, game.board, game.last_move, commandId, deviceId, game.updated_at, gameId);
      return { game: this.gameSnapshot(game) };
    });
    if (expired) this.historyChanged();
    if (changed) this.broadcast({ type: 'gomoku', game: result.game });
    return result;
  }

  readReceipts() {
    return this.sql.exec('SELECT device_id AS deviceId, read_message_id AS messageId FROM devices WHERE read_message_id > 0').toArray();
  }

  markRead(deviceId, messageId) {
    const latestId = this.sql.exec('SELECT max(id) AS id FROM messages WHERE id <= ?', messageId).one().id;
    if (latestId === null) return;
    if (this.sql.exec('UPDATE devices SET read_message_id = ? WHERE device_id = ? AND read_message_id < ? RETURNING device_id', latestId, deviceId, latestId).toArray().length) {
      this.broadcast({ type: 'read', deviceId, messageId: latestId });
    }
  }

  historySnapshot(firstId) {
    const bounds = this.sql.exec('SELECT min(id) AS oldestId, max(id) AS latestId FROM messages').one();
    return {
      generation: this.sql.exec('SELECT value FROM metadata WHERE key = ?', 'historyGeneration').one().value,
      ...bounds,
      hasMore: firstId !== undefined && bounds.oldestId !== null && bounds.oldestId < firstId
    };
  }

  messagePage({ before = null, after = null, limit = 50, generation = null } = {}) {
    if (!this.initialized) return { error: 'not_found', status: 404 };
    this.pruneExpired();
    const bounds = this.historySnapshot();
    let historyMode = 'replace';
    let rows;
    if (before !== null && (!generation || generation === bounds.generation)) {
      rows = this.sql.exec('SELECT id, client_id AS clientId, device_id AS deviceId, text, created_at AS createdAt, attachment FROM messages WHERE id < ? ORDER BY id DESC LIMIT ?', before, limit).toArray().reverse();
      historyMode = 'prepend';
    } else if (after !== null && generation === bounds.generation && (after === bounds.latestId || (bounds.oldestId !== null && after >= bounds.oldestId && after <= bounds.latestId))) {
      rows = this.sql.exec('SELECT id, client_id AS clientId, device_id AS deviceId, text, created_at AS createdAt, attachment FROM messages WHERE id > ? ORDER BY id LIMIT ?', after, limit).toArray();
      historyMode = 'append';
    } else {
      rows = this.sql.exec('SELECT id, client_id AS clientId, device_id AS deviceId, text, created_at AS createdAt, attachment FROM messages ORDER BY id DESC LIMIT ?', limit).toArray().reverse();
    }
    const history = this.historySnapshot(rows[0]?.id ?? before ?? after ?? undefined);
    history.continuationId = rows.at(-1)?.id ?? after ?? null;
    history.hasNewer = history.continuationId !== null && history.latestId > history.continuationId;
    return { messages: this.decorateMessages(rows), history, historyMode, readReceipts: this.readReceipts() };
  }

  historyChanged(type = 'history') {
    this.downloadRevision++;
    this.sql.exec('UPDATE metadata SET value = ? WHERE key = ?', crypto.randomUUID(), 'historyGeneration');
    const rows = this.sql.exec('SELECT id, client_id AS clientId, device_id AS deviceId, text, created_at AS createdAt, attachment FROM messages ORDER BY id DESC LIMIT 50').toArray().reverse();
    this.broadcast({ type, messages: this.decorateMessages(rows), history: this.historySnapshot(rows[0]?.id), historyMode: 'replace', readReceipts: this.readReceipts(), activeGames: this.activeGames() });
  }

  async databaseProbe() {
    const room = { ok: this.sql.exec('SELECT 1 AS ok').one().ok === 1 && this.initialized, initialized: this.initialized, bytes: this.sql.databaseSize };
    if (!this.initialized) return { ...room, sampledShard: null };
    const shard = this.sql.exec("SELECT s.file_id, s.shard_index FROM file_shards s JOIN files f ON f.file_id = s.file_id WHERE f.status = 'complete' AND (s.file_id > ? OR (s.file_id = ? AND s.shard_index > ?)) ORDER BY s.file_id, s.shard_index LIMIT 1", this.diagnosticFileCursor || '', this.diagnosticFileCursor || '', this.diagnosticShardCursor ?? -1).toArray()[0]
      || this.sql.exec("SELECT s.file_id, s.shard_index FROM file_shards s JOIN files f ON f.file_id = s.file_id WHERE f.status = 'complete' ORDER BY s.file_id, s.shard_index LIMIT 1").toArray()[0];
    if (!shard) return { ...room, sampledShard: null };
    this.diagnosticFileCursor = shard.file_id;
    this.diagnosticShardCursor = shard.shard_index;
    const result = await rpcResult(this.env.E2EE_FILE_SHARDS.getByName(`${shard.file_id}:${shard.shard_index}`).databaseProbe());
    const sampledShard = result.ok ? result.value : { ok: false };
    return { ...room, sampledShard };
  }

  storageUsage() {
    if (!this.initialized) return { bytes: 0, reservedBytes: 0, oldestAt: null, deletingFiles: 0 };
    const reservedBytes = this.sql.exec('SELECT coalesce(sum(reserved_bytes), 0) AS bytes FROM files').one().bytes;
    return {
      bytes: this.sql.databaseSize + this.sql.exec('SELECT coalesce(sum(bytes), 0) AS bytes FROM file_shards').one().bytes + reservedBytes,
      reservedBytes,
      oldestAt: this.sql.exec("SELECT min(created_at) AS oldest_at FROM (SELECT created_at FROM messages UNION ALL SELECT created_at FROM files WHERE status = 'deleting')").one().oldest_at,
      deletingFiles: this.sql.exec("SELECT count(*) AS count FROM files WHERE status = 'deleting'").one().count
    };
  }

  pruneExpired() {
    if (!this.initialized) return 0;
    this.refreshConnectedDevices();
    const expiredDevices = this.sql.exec('SELECT device_id FROM devices WHERE last_active_at <= ?', Date.now() - DEVICE_IDLE_LIFETIME).toArray();
    for (const { device_id: deviceId } of expiredDevices) this.removeDevice(deviceId);
    const deleted = this.sql.exec('DELETE FROM messages WHERE created_at <= ? RETURNING id', Date.now() - MESSAGE_LIFETIME).toArray();
    if (deleted.length) this.historyChanged();
    this.sql.exec("UPDATE files SET status = 'deleting', reserved_bytes = 0 WHERE status = 'uploading' AND updated_at <= ?", Date.now() - UPLOAD_LIFETIME);
    this.sql.exec('DELETE FROM download_tickets WHERE expires_at <= ?', Date.now());
    return deleted.length + expiredDevices.length;
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
      if (this.initialized) {
        if (this.sql.exec('SELECT 1 FROM messages UNION ALL SELECT 1 FROM files UNION ALL SELECT 1 FROM file_shards UNION ALL SELECT 1 FROM file_upload_chunks LIMIT 1').toArray().length) return false;
        if (this.sql.exec('SELECT 1 FROM devices LIMIT 1').toArray().length) {
          const lastActivity = Number(this.sql.exec('SELECT value FROM metadata WHERE key = ?', 'lastActiveAt').one().value);
          if (lastActivity + ROOM_IDLE_LIFETIME + ACTIVITY_WRITE_INTERVAL > Date.now() || this.ctx.getWebSockets().some(socket => socket.readyState === WebSocket.OPEN && socket.deserializeAttachment()?.deviceId && !socket.deserializeAttachment()?.closing)) return false;
        }
      }
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
      const items = this.sql.exec('SELECT id AS messageId, attachment IS NOT NULL AS attachment FROM messages WHERE created_at <= ? ORDER BY created_at, id LIMIT 100', before).toArray();
      // Reclaim one completed file before considering any newer history.
      const attachmentIndex = items.findIndex(item => item.attachment);
      const selected = items.slice(0, attachmentIndex < 0 ? items.length : attachmentIndex + 1);
      const ids = selected.map(item => item.messageId);
      if (ids.length) this.sql.exec(`DELETE FROM messages WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids);
      if (ids.length) this.historyChanged();
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
    if (existing) return { message: this.decorateMessages([existing])[0], created: false };
    return null;
  }

  uploadInfo(deviceId, clientId, identity = null) {
    if (!this.initialized || !this.sql.exec('SELECT 1 FROM devices WHERE device_id = ?', deviceId).toArray().length) return { error: 'unauthorized', status: 401 };
    const file = this.sql.exec('SELECT file_id, status, received_bytes, received_chunks, name, type, size, fingerprint FROM files WHERE device_id = ? AND client_id = ?', deviceId, clientId).toArray()[0];
    if (!file) return null;
    if (identity && (file.name !== identity.name || file.type !== identity.type || file.size !== identity.size || file.fingerprint !== (identity.fingerprint ?? null))) return { error: 'upload_conflict', status: 409 };
    if (file.status === 'complete') return this.findMessage(deviceId, clientId);
    if (file.status !== 'uploading') return { error: 'upload_unavailable', status: 409 };
    this.uploadProgress(file);
    return { uploadId: file.file_id, chunkSize: FILE_CHUNK_SIZE, receivedBytes: file.received_bytes };
  }

  uploadProgress(file) {
    if (file.received_bytes !== null && file.received_chunks !== null) return;
    const progress = this.sql.exec('SELECT coalesce(sum(size), 0) AS bytes, count(*) AS count FROM file_upload_chunks WHERE file_id = ? AND received = 1', file.file_id).one();
    this.sql.exec('UPDATE files SET received_bytes = ?, received_chunks = ? WHERE file_id = ?', progress.bytes, progress.count, file.file_id);
    file.received_bytes = progress.bytes;
    file.received_chunks = progress.count;
  }

  async beginUpload(deviceId, file, keyId) {
    const denied = this.checkWrite(keyId, file.text);
    if (denied.error) return denied;
    const existing = this.uploadInfo(deviceId, file.clientId, file) || this.findMessage(deviceId, file.clientId);
    if (existing) {
      if (existing.uploadId) this.sql.exec('UPDATE files SET text = ? WHERE file_id = ?', file.text, existing.uploadId);
      return existing;
    }
    const uploadId = crypto.randomUUID();
    this.sql.exec('INSERT INTO files (file_id, device_id, client_id, name, type, size, text, status, created_at, updated_at, reserved_bytes, received_bytes, received_chunks, fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)', uploadId, deviceId, file.clientId, file.name, file.type, file.size, file.text, 'uploading', Date.now(), Date.now(), fileReserve(file.size), file.fingerprint ?? null);
    await this.scheduleAlarm();
    return { uploadId, chunkSize: FILE_CHUNK_SIZE, receivedBytes: 0, created: true };
  }

  async writeFileChunk(deviceId, uploadId, index, bytes, keyId) {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (!this.initialized || !this.sql.exec('SELECT 1 FROM devices WHERE device_id = ?', deviceId).toArray().length) return { error: 'unauthorized', status: 401 };
      const denied = this.checkWrite(keyId);
      if (denied.error) return denied;
      const file = this.sql.exec("SELECT * FROM files WHERE file_id = ? AND device_id = ? AND status = 'uploading'", uploadId, deviceId).toArray()[0];
      if (!file || file.updated_at + UPLOAD_LIFETIME <= Date.now()) return { error: 'not_found', status: 404 };
      const count = Math.ceil(file.size / FILE_CHUNK_SIZE);
      const expected = Math.min(FILE_CHUNK_SIZE, file.size - index * FILE_CHUNK_SIZE);
      if (!Number.isSafeInteger(index) || index >= count || bytes.byteLength !== expected) return { error: 'invalid_chunk', status: 400 };
      const shardIndex = Math.floor(index * FILE_CHUNK_SIZE / FILE_SHARD_SIZE);
      const shard = this.env.E2EE_FILE_SHARDS.getByName(`${uploadId}:${shardIndex}`);
      const tracked = this.sql.exec('SELECT bytes FROM file_shards WHERE file_id = ? AND shard_index = ?', uploadId, shardIndex).toArray()[0];
      const previous = this.sql.exec('SELECT size, received FROM file_upload_chunks WHERE file_id = ? AND chunk_index = ?', uploadId, index).toArray()[0];
      this.uploadProgress(file);
      const received = file.received_chunks;
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
        this.sql.exec('UPDATE files SET updated_at = ?, received_bytes = received_bytes + ?, received_chunks = received_chunks + ? WHERE file_id = ?', Date.now(), previous?.received ? 0 : bytes.byteLength, previous?.received ? 0 : 1, uploadId);
        const accounted = (tracked?.bytes || 0) + (previous ? 0 : allocation);
        this.sql.exec('UPDATE file_shards SET bytes = ? WHERE file_id = ? AND shard_index = ?', Math.max(result.bytes, accounted), uploadId, shardIndex);
      });
      await this.scheduleAlarm();
      return { receivedBytes: file.received_bytes + (previous?.received ? 0 : bytes.byteLength) };
    });
  }

  async completeUpload(deviceId, uploadId, keyId) {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (!this.initialized || !this.sql.exec('SELECT 1 FROM devices WHERE device_id = ?', deviceId).toArray().length) return { error: 'unauthorized', status: 401 };
      const denied = this.checkWrite(keyId);
      if (denied.error) return denied;
      const file = this.sql.exec('SELECT * FROM files WHERE file_id = ? AND device_id = ?', uploadId, deviceId).toArray()[0];
      if (!file || file.status === 'deleting' || (file.status === 'uploading' && file.updated_at + UPLOAD_LIFETIME <= Date.now())) return { error: 'not_found', status: 404 };
      const existing = this.findMessage(deviceId, file.client_id);
      if (existing) return existing;
      const metadata = this.checkWrite(keyId, file.text);
      if (metadata.error) return metadata;
      this.uploadProgress(file);
      if (file.received_bytes !== file.size) return { error: 'upload_incomplete', status: 409 };
      const shards = this.sql.exec('SELECT shard_index, bytes FROM file_shards WHERE file_id = ? ORDER BY shard_index', uploadId).toArray();
      for (let index = 0; index < shards.length; index += 4) {
        const batch = shards.slice(index, index + 4);
        const sizes = await Promise.allSettled(batch.map(shard => this.env.E2EE_FILE_SHARDS.getByName(`${uploadId}:${shard.shard_index}`).storageBytes()));
        const failed = sizes.find(result => result.status === 'rejected');
        if (failed) throw failed.reason;
        this.ctx.storage.transactionSync(() => {
          batch.forEach((shard, position) => {
            if (sizes[position].value !== shard.bytes) this.sql.exec('UPDATE file_shards SET bytes = ? WHERE file_id = ? AND shard_index = ?', sizes[position].value, uploadId, shard.shard_index);
          });
        });
      }
      const attachment = { name: file.name, type: file.type, size: file.size };
      let pruned = false;
      const message = this.ctx.storage.transactionSync(() => {
        const created = this.sql.exec('INSERT INTO messages (client_id, device_id, text, created_at, attachment) VALUES (?, ?, ?, ?, ?) RETURNING id, client_id AS clientId, device_id AS deviceId, text, created_at AS createdAt, attachment', file.client_id, deviceId, file.text, Date.now(), JSON.stringify(attachment)).one();
        this.sql.exec("UPDATE files SET status = 'complete', message_id = ?, created_at = ?, reserved_bytes = 0 WHERE file_id = ?", created.id, created.createdAt, uploadId);
        pruned = this.sql.exec('DELETE FROM messages WHERE id <= (SELECT id FROM messages ORDER BY id DESC LIMIT 1 OFFSET 500) RETURNING id').toArray().length > 0;
        if (pruned) this.sql.exec('UPDATE metadata SET value = ? WHERE key = ?', crypto.randomUUID(), 'historyGeneration');
        return publicMessage(created);
      });
      if (pruned) this.downloadRevision++;
      this.broadcast({ type: 'message', message, history: this.historySnapshot(), ...(pruned ? { activeGames: this.activeGames() } : {}) });
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
      await this.env.E2EE_FILE_SHARDS.getByName(`${shard.file_id}:${shard.shard_index}`).erase();
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
    const existing = this.sql.exec('SELECT ticket, expires_at AS expiresAt FROM download_tickets WHERE device_id = ? AND file_id = ? AND expires_at > ? ORDER BY expires_at DESC LIMIT 1', deviceId, file.file_id, Date.now() + 60000).toArray()[0];
    if (existing) return existing;
    this.sql.exec('DELETE FROM download_tickets WHERE device_id = ? AND file_id = ? AND expires_at <= ?', deviceId, file.file_id, Date.now());
    const ticket = credential();
    const expiresAt = Date.now() + DOWNLOAD_LIFETIME;
    this.sql.exec('INSERT INTO download_tickets (ticket, file_id, device_id, expires_at) VALUES (?, ?, ?, ?)', ticket, file.file_id, deviceId, expiresAt);
    return { ticket, expiresAt };
  }

  async prepareMessage(roomId, token, clientId, text, keyId) {
    const deviceId = await this.authorize(token);
    if (!deviceId) return { error: 'unauthorized', status: 401 };
    const denied = this.checkWrite(keyId, text);
    if (denied.error) return denied;
    const usage = await this.maintain(roomId);
    return { deviceId, existing: this.findMessage(deviceId, clientId), usage };
  }

  async addMessage(deviceId, clientId, text, keyId, gameType) {
    if (!this.initialized || !this.sql.exec('SELECT 1 FROM devices WHERE device_id = ?', deviceId).toArray().length) return { error: 'unauthorized', status: 401 };
    const denied = this.checkWrite(keyId, text);
    if (denied.error) return denied;
    const existing = this.findMessage(deviceId, clientId);
    if (existing) return existing;
    let pruned = false;
    const saved = this.ctx.storage.transactionSync(() => {
      if (gameType) {
        const busy = this.sql.exec("SELECT * FROM gomoku_games WHERE status IN ('waiting', 'playing') AND (host_device_id = ? OR guest_device_id = ?)", deviceId, deviceId).toArray()[0];
        if (busy) return { error: 'game_busy', status: 409, game: this.gameSnapshot(busy) };
        if (this.sql.exec('SELECT 1 FROM gomoku_games WHERE game_id = ?', clientId).toArray().length) return { error: 'game_conflict', status: 409 };
      }
      const created = this.sql.exec(
        'INSERT INTO messages (client_id, device_id, text, created_at) VALUES (?, ?, ?, ?) RETURNING id, client_id AS clientId, device_id AS deviceId, text, created_at AS createdAt',
        clientId, deviceId, text, Date.now()
      ).one();
      if (gameType) this.sql.exec("INSERT INTO gomoku_games (game_id, message_id, host_device_id, status, revision, board, updated_at) VALUES (?, ?, ?, 'waiting', 1, ?, ?)", clientId, created.id, deviceId, JSON.stringify(Array(225).fill(0)), created.createdAt);
      pruned = this.sql.exec('DELETE FROM messages WHERE id <= (SELECT id FROM messages ORDER BY id DESC LIMIT 1 OFFSET 500) RETURNING id').toArray().length > 0;
      if (pruned) this.sql.exec('UPDATE metadata SET value = ? WHERE key = ?', crypto.randomUUID(), 'historyGeneration');
      return { message: this.decorateMessages([created])[0] };
    });
    if (saved.error) return saved;
    const { message } = saved;
    if (pruned) this.downloadRevision++;
    this.broadcast({ type: 'message', message, history: this.historySnapshot(), ...(pruned ? { activeGames: this.activeGames() } : {}) });
    if (gameType) this.broadcast({ type: 'gomoku', game: this.gameSnapshot(this.sql.exec('SELECT * FROM gomoku_games WHERE game_id = ?', clientId).one()) });
    await this.scheduleAlarm();
    return { message, created: true, usage: this.storageUsage() };
  }

  async clearMessages(deviceId) {
    if (!this.initialized || !this.sql.exec('SELECT 1 FROM devices WHERE device_id = ?', deviceId).toArray().length) {
      return { error: 'unauthorized', status: 401 };
    }
    this.sql.exec('DELETE FROM messages');
    this.sql.exec("UPDATE files SET status = 'deleting', reserved_bytes = 0 WHERE status = 'uploading'");
    this.historyChanged('cleared');
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
    this.downloadRevision++;
    const games = this.finishDeviceGames(deviceId);
    this.sql.exec('DELETE FROM download_tickets WHERE device_id = ?', deviceId);
    this.sql.exec("UPDATE files SET status = 'deleting', reserved_bytes = 0 WHERE device_id = ? AND status = 'uploading'", deviceId);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.deserializeAttachment()?.deviceId !== deviceId) continue;
      socket.serializeAttachment({ closing: true });
      socket.close(4001, 'Device disconnected');
    }
    this.sql.exec('DELETE FROM key_grants WHERE device_id = ?', deviceId);
    if (this.sql.exec('SELECT 1 FROM devices LIMIT 1').toArray().length) {
      this.sql.exec("INSERT INTO metadata (key, value) VALUES ('rekeyRequired', '1') ON CONFLICT(key) DO UPDATE SET value = '1'");
      this.broadcast({ type: 'rekey-required' });
    }
    this.broadcast({ type: 'devices' });
    for (const game of games) this.broadcast({ type: 'gomoku', game });
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
      const pairing = await this.env.E2EE_PAIRING_REGISTRY.getByName('registry').currentInvite(roomId, true);
      return receive(pairing);
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
    const uploadChunk = path.match(/^\/v1\/spaces\/[^/]+\/files\/uploads\/([0-9a-f-]{36})\/chunks\/(0|[1-9][0-9]*)$/i);
    if (request.method === 'PUT' && uploadChunk && ROOM_ID.test(uploadChunk[1])) {
      const token = request.headers.get('Authorization')?.match(/^Bearer ([0-9a-f]{64})$/)?.[1];
      const deviceId = token ? await this.authorize(token) : null;
      if (!deviceId) return json({ error: 'unauthorized' }, 401);
      const keyId = request.headers.get('X-Sync-Key-Id');
      const denied = this.checkWrite(keyId);
      if (denied.error) return resultResponse(denied);
      const body = await readBytes(request, FILE_CHUNK_SIZE);
      if (body.error) return resultResponse(body);
      // Reading the body yields to revocations and rotations; validate again at the actual write.
      return resultResponse(await this.writeFileChunk(deviceId, uploadChunk[1], Number(uploadChunk[2]), body.bytes, keyId));
    }
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
      if (!deviceId || (ticketMatch && !this.touchDevice(deviceId))) return json({ error: 'unauthorized' }, 401);
      if (!file || !this.sql.exec('SELECT 1 FROM messages WHERE id = ?', file.message_id).toArray().length || file.created_at + MESSAGE_LIFETIME <= Date.now()) return json({ error: 'not_found' }, 404);
      this.touchActivity();
      const headers = {
        'Content-Type': 'application/octet-stream', 'Content-Length': String(file.size),
        'Content-Disposition': 'attachment; filename="encrypted-file"',
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
      // Only membership/history changes invalidate access; transport chunk boundaries do not.
      let revision = this.downloadRevision;
      const available = () => {
        if (!this.initialized || file.created_at + MESSAGE_LIFETIME <= Date.now()) return false;
        if (revision === this.downloadRevision) return true;
        if (!this.sql.exec('SELECT 1 FROM devices WHERE device_id = ?', deviceId).toArray().length
            || !this.sql.exec("SELECT 1 FROM files WHERE file_id = ? AND status = 'complete'", file.file_id).toArray().length) return false;
        revision = this.downloadRevision;
        return true;
      };
      const body = new ReadableStream({
        type: 'bytes',
        pull: async (controller) => {
          if (!available()) {
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
              const stream = await this.env.E2EE_FILE_SHARDS.getByName(`${file.file_id}:${nextShard}`).readStream(shardOffset, Math.min(FILE_SHARD_SIZE - shardOffset, end - offset + 1));
              shardReader = stream.getReader();
              shardIndex = nextShard;
            }
            const { done, value } = await shardReader.read();
            if (!available()) throw new Error('download_unavailable');
            if (done || !value?.byteLength) throw new Error('not_found');
            offset += value.byteLength;
            controller.enqueue(value);
          } catch {
            await shardReader?.cancel().catch(() => {});
            shardReader?.releaseLock();
            shardReader = null;
            controller.error(new Error('download_unavailable'));
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
    server.serializeAttachment({ authDeadline: Date.now() + 10000, roomId: new URL(request.url).pathname.split('/')[3], expectedDeviceId: request.headers.get('X-Sync-Device') || null, after: /^\d+$/.test(url.searchParams.get('after') || '') && Number.isSafeInteger(Number(url.searchParams.get('after'))) ? Number(url.searchParams.get('after')) : null, generation: url.searchParams.get('generation') });
    await this.scheduleAlarm();
    const protocols = (request.headers.get('Sec-WebSocket-Protocol') || '').split(',').map(value => value.trim());
    return new Response(null, { status: 101, webSocket: client, headers: protocols.includes('sync') ? { 'Sec-WebSocket-Protocol': 'sync' } : {} });
  }

  async webSocketMessage(socket, payload) {
    if (!this.initialized) {
      socket.close(4001, 'Space expired');
      return;
    }
    const attachment = socket.deserializeAttachment();
    if (attachment?.closing) return;
    if (attachment?.deviceId) {
      let frame;
      try { frame = typeof payload === 'string' && payload.length <= 1024 ? JSON.parse(payload) : null; } catch { frame = null; }
      if (frame?.type !== 'read' || !Number.isSafeInteger(frame.messageId) || frame.messageId < 1) {
        socket.serializeAttachment({ closing: true });
        socket.close(1008, 'Invalid read receipt');
        return;
      }
      if (!this.touchDevice(attachment.deviceId)) {
        socket.serializeAttachment({ closing: true });
        socket.close(4001, 'Invalid credential');
        return;
      }
      this.markRead(attachment.deviceId, frame.messageId);
      return;
    }
    if (typeof payload !== 'string' || payload.length > 1024 || attachment.authDeadline <= Date.now()) {
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
    if (!deviceId || (attachment.expectedDeviceId && attachment.expectedDeviceId !== deviceId)) {
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
      socket.serializeAttachment({ deviceId, connectedAt: Date.now() });
      socket.send(JSON.stringify({ type: 'ready', deviceId, ...this.keyState(), encryptionVersion: 1, ...this.messagePage({ after: attachment.after ?? null, generation: attachment.generation }), pairing, activeGames: this.activeGames(), spaceProfile: this.spaceProfile() }));
      return true;
    });
    await this.scheduleAlarm();
    if (authenticated) this.ctx.waitUntil(this.env.E2EE_PAIRING_REGISTRY.getByName('registry').refreshRoom(attachment.roomId));
  }

  async scheduleAlarm() {
    if (!this.initialized) return;
    const deadlines = this.ctx.getWebSockets()
      .map(socket => socket.deserializeAttachment()?.authDeadline)
      .filter(Boolean);
    const oldest = this.sql.exec('SELECT min(created_at) AS oldest_at FROM messages').one().oldest_at;
    if (oldest !== null) deadlines.push(oldest + MESSAGE_LIFETIME);
    const oldestDevice = this.sql.exec('SELECT min(last_active_at) AS oldest_at FROM devices').one().oldest_at;
    if (oldestDevice !== null) deadlines.push(oldestDevice + DEVICE_IDLE_LIFETIME);
    const uploading = this.sql.exec("SELECT min(updated_at) AS oldest_at FROM files WHERE status = 'uploading'").one().oldest_at;
    if (uploading !== null) deadlines.push(uploading + UPLOAD_LIFETIME);
    if (this.sql.exec("SELECT 1 FROM files WHERE status = 'deleting' LIMIT 1").toArray().length) deadlines.push(Date.now() + 1000);
    const nextAlarm = deadlines.length ? Math.min(...deadlines) : null;
    if (nextAlarm === await this.ctx.storage.getAlarm()) return;
    if (nextAlarm !== null) await this.ctx.storage.setAlarm(nextAlarm);
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
    if ((deleted || hadPending) && roomId) this.ctx.waitUntil(this.env.E2EE_PAIRING_REGISTRY.getByName('registry').refreshRoom(roomId));
  }

  async webSocketClose(socket) {
    if (this.initialized && socket.deserializeAttachment()?.deviceId && !socket.deserializeAttachment()?.closing) {
      this.touchDevice(socket.deserializeAttachment().deviceId);
      this.ctx.waitUntil(this.env.E2EE_PAIRING_REGISTRY.getByName('registry').invalidateDiscovery());
    }
    socket.serializeAttachment({ closing: true });
    socket.close(1000, 'Connection closed');
    await this.scheduleAlarm();
  }

  async webSocketError(socket) {
    if (this.initialized && socket.deserializeAttachment()?.deviceId && !socket.deserializeAttachment()?.closing) {
      this.touchDevice(socket.deserializeAttachment().deviceId);
      this.ctx.waitUntil(this.env.E2EE_PAIRING_REGISTRY.getByName('registry').invalidateDiscovery());
    }
    socket.serializeAttachment({ closing: true });
    socket.close(1011, 'Connection error');
    await this.scheduleAlarm();
  }
}

export class E2eeFileShard extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.initialized = this.sql.exec("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('chunks', 'parts')").one().count === 2;
  }

  async writePart(index, contents) {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (!this.initialized) {
        this.sql.exec('CREATE TABLE IF NOT EXISTS chunks (chunk_index INTEGER PRIMARY KEY, data BLOB NOT NULL)');
        this.sql.exec('CREATE TABLE IF NOT EXISTS parts (part_index INTEGER PRIMARY KEY, hash TEXT NOT NULL)');
        this.initialized = true;
      }
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
        if (!this.initialized || offset >= end) { controller.close(); return; }
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

  databaseProbe() {
    return { ok: this.initialized && this.sql.exec('SELECT 1 FROM chunks LIMIT 1').toArray().length !== 0, initialized: this.initialized, bytes: this.sql.databaseSize };
  }

  erase() {
    this.initialized = false;
    return this.ctx.storage.deleteAll();
  }
}
