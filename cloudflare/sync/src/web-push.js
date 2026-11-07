const encoder = new TextEncoder();
const roomIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const encode = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const decode = (value, length) => {
  if (typeof value !== 'string' || value.length !== Math.ceil(length * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), character => character.charCodeAt(0));
    return bytes.length === length && encode(bytes) === value ? bytes : null;
  } catch { return null; }
};
const join = (...parts) => {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) { result.set(new Uint8Array(part), offset); offset += part.byteLength; }
  return result;
};
const validSubject = value => {
  if (typeof value !== 'string' || value.length > 512) return false;
  if (/^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
  } catch { return false; }
};

export function getPushPublicKey(env) {
  const publicKey = decode(env.PUSH_VAPID_PUBLIC_KEY, 65);
  return publicKey?.[0] === 4 && decode(env.PUSH_VAPID_PRIVATE_KEY, 32) && validSubject(env.PUSH_VAPID_SUBJECT)
    ? env.PUSH_VAPID_PUBLIC_KEY : null;
}

export function validatePushSubscription(value) {
  if (!value || typeof value !== 'object' || typeof value.endpoint !== 'string' || value.endpoint.length > 2048) return null;
  let endpoint;
  try {
    const url = new URL(value.endpoint);
    const allowed = url.hostname === 'fcm.googleapis.com'
      || url.hostname === 'updates.push.services.mozilla.com'
      || url.hostname.endsWith('.push.apple.com')
      || url.hostname.endsWith('.notify.windows.com');
    if (!allowed || url.protocol !== 'https:' || url.port || url.username || url.password || url.hash) return null;
    endpoint = url.href;
  } catch { return null; }
  const publicKey = decode(value.keys?.p256dh, 65);
  if (publicKey?.[0] !== 4 || !decode(value.keys?.auth, 16)) return null;
  if (value.expirationTime != null && (!Number.isFinite(value.expirationTime) || value.expirationTime <= Date.now())) return null;
  return { endpoint, expirationTime: value.expirationTime ?? null, keys: { p256dh: value.keys.p256dh, auth: value.keys.auth } };
}

const hkdf = async (secret, salt, info, length) => {
  const key = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8);
};

async function encryptPayload(subscription, payload) {
  const receiverPublic = decode(subscription.keys.p256dh, 65);
  const receiverKey = await crypto.subtle.importKey('raw', receiverPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const sender = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const senderPublic = new Uint8Array(await crypto.subtle.exportKey('raw', sender.publicKey));
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: receiverKey }, sender.privateKey, 256);
  const ikm = await hkdf(shared, decode(subscription.keys.auth, 16), join(encoder.encode('WebPush: info\0'), receiverPublic, senderPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const [keyBytes, nonce] = await Promise.all([
    hkdf(ikm, salt, encoder.encode('Content-Encoding: aes128gcm\0'), 16),
    hkdf(ikm, salt, encoder.encode('Content-Encoding: nonce\0'), 12)
  ]);
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, join(encoder.encode(JSON.stringify(payload)), new Uint8Array([2])));
  // RFC 8188: salt, record size, key-id length, then the ephemeral public key.
  return join(salt, new Uint8Array([0, 0, 16, 0, 65]), senderPublic, ciphertext);
}

const authorizations = new Map();
function authorization(endpoint, env) {
  const origin = new URL(endpoint).origin;
  const cacheKey = JSON.stringify([origin, env.PUSH_VAPID_PUBLIC_KEY, env.PUSH_VAPID_PRIVATE_KEY, env.PUSH_VAPID_SUBJECT]);
  const previous = authorizations.get(cacheKey);
  if (previous?.expiresAt > Date.now()) return previous.promise;
  const entry = { expiresAt: Date.now() + 11 * 60 * 60 * 1000 };
  entry.promise = signAuthorization(origin, env).catch(error => {
    if (authorizations.get(cacheKey) === entry) authorizations.delete(cacheKey);
    throw error;
  });
  authorizations.delete(cacheKey);
  authorizations.set(cacheKey, entry);
  while (authorizations.size > 16) authorizations.delete(authorizations.keys().next().value);
  return entry.promise;
}

async function signAuthorization(origin, env) {
  const publicKey = decode(env.PUSH_VAPID_PUBLIC_KEY, 65);
  const key = await crypto.subtle.importKey('jwk', {
    kty: 'EC', crv: 'P-256', x: encode(publicKey.subarray(1, 33)), y: encode(publicKey.subarray(33)),
    d: env.PUSH_VAPID_PRIVATE_KEY
  }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const header = encode(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = encode(encoder.encode(JSON.stringify({ aud: origin, exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60, sub: env.PUSH_VAPID_SUBJECT })));
  const unsigned = `${header}.${claims}`;
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(unsigned));
  return `vapid t=${unsigned}.${encode(signature)}, k=${env.PUSH_VAPID_PUBLIC_KEY}`;
}

export async function sendWebPush(subscription, payload, env, { signal } = {}) {
  const target = validatePushSubscription(subscription);
  if (!target || !getPushPublicKey(env) || !roomIdPattern.test(payload?.roomId)
      || !Number.isSafeInteger(payload?.messageId) || payload.messageId < 1 || !['zh-CN', 'en'].includes(payload.language)) {
    throw new Error('invalid_push_configuration');
  }
  const notification = { roomId: payload.roomId, messageId: payload.messageId, language: payload.language };
  signal?.throwIfAborted();
  const [body, auth, topic] = await Promise.all([
    encryptPayload(target, notification), authorization(target.endpoint, env),
    crypto.subtle.digest('SHA-256', encoder.encode(notification.roomId))
  ]);
  signal?.throwIfAborted();
  const response = await fetch(target.endpoint, {
    method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
    headers: {
      Authorization: auth, 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
      TTL: '3600', Urgency: 'normal', Topic: encode(topic).slice(0, 32)
    }, body
  });
  await response.body?.cancel();
  const result = { status: response.status };
  const retryAfter = response.headers.get('Retry-After');
  if (retryAfter !== null) {
    const delay = /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(delay)) result.retryAfterMs = Math.max(0, delay);
  }
  return result;
}
