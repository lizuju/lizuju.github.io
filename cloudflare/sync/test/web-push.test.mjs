import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, generateKeyPairSync, hkdfSync, randomBytes, verify } from 'node:crypto';
import { test } from 'node:test';
import { getPushPublicKey, sendWebPush, validatePushSubscription } from '../src/web-push.js';

const receiver = createECDH('prime256v1');
receiver.generateKeys();
const auth = randomBytes(16);
const vapid = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = vapid.privateKey.export({ format: 'jwk' });
const publicKey = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url');
const env = { PUSH_VAPID_PUBLIC_KEY: publicKey, PUSH_VAPID_PRIVATE_KEY: jwk.d, PUSH_VAPID_SUBJECT: 'mailto:owner@example.test' };
const subscription = { endpoint: 'https://web.push.apple.com/test-subscription', expirationTime: null,
  keys: { p256dh: receiver.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
const payload = { roomId: 'f346cc3e-00ae-4a9d-9f88-40a578c88a36', messageId: 17, language: 'zh-CN' };

test('only exposes the public key when the VAPID configuration is complete', () => {
  assert.equal(getPushPublicKey(env), publicKey);
  assert.equal(getPushPublicKey({ ...env, PUSH_VAPID_SUBJECT: 'https://example.test/contact' }), publicKey);
  for (const key of Object.keys(env)) assert.equal(getPushPublicKey({ ...env, [key]: undefined }), null);
  for (const subject of ['javascript:alert(1)', 'http://example.test', 'mailto:invalid', 'https://user:password@example.test/', 'https://example.test/#secret']) {
    assert.equal(getPushPublicKey({ ...env, PUSH_VAPID_SUBJECT: subject }), null);
  }
  assert.equal(getPushPublicKey({ ...env, PUSH_VAPID_PRIVATE_KEY: 'a' }), null);
});

test('accepts supported push providers and strips unknown subscription fields', () => {
  for (const endpoint of [subscription.endpoint, 'https://fcm.googleapis.com/fcm/send/token', 'https://updates.push.services.mozilla.com/wpush/v2/token', 'https://wns2.notify.windows.com/?token=opaque']) {
    assert.deepEqual(validatePushSubscription({ ...subscription, endpoint, secret: 'unused', keys: { ...subscription.keys, secret: 'unused' } }), { ...subscription, endpoint });
  }
});

test('rejects arbitrary destinations, credentials, malformed keys and expired subscriptions', () => {
  for (const endpoint of ['http://web.push.apple.com/test', 'https://web.push.apple.com:444/test', 'https://user:password@web.push.apple.com/test',
    'https://web.push.apple.com/test#fragment', 'https://127.0.0.1/', 'https://169.254.169.254/', 'https://fcm.googleapis.com.attacker.test/',
    'https://evilpush.apple.com/', 'https://example.test/', 'not-a-url']) {
    assert.equal(validatePushSubscription({ ...subscription, endpoint }), null, endpoint);
  }
  for (const keys of [{}, { ...subscription.keys, auth: `${subscription.keys.auth}==` }, { ...subscription.keys, auth: 'a' },
    { ...subscription.keys, p256dh: Buffer.alloc(65).toString('base64url') }]) {
    assert.equal(validatePushSubscription({ ...subscription, keys }), null);
  }
  for (const expirationTime of [0, Date.now() - 1, Infinity, 'tomorrow']) assert.equal(validatePushSubscription({ ...subscription, expirationTime }), null);
});

test('sends a standards-decryptable private payload and verifiable VAPID signature', async () => {
  const originalFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, options) => {
    sent.push({ url, ...options });
    return new Response(null, { status: 201 });
  };
  try {
    assert.deepEqual(await sendWebPush(subscription, { ...payload, text: 'private plaintext', token: 'private credential' }, env), { status: 201 });
    assert.deepEqual(await sendWebPush(subscription, payload, env), { status: 201 });
  } finally { globalThis.fetch = originalFetch; }
  assert.equal(sent.length, 2);
  const request = sent[0];
  assert.equal(request.url, subscription.endpoint);
  assert.equal(request.method, 'POST');
  assert.equal(request.redirect, 'error');
  assert.equal(request.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(request.headers.TTL, '3600');
  assert.equal(request.headers.Urgency, 'normal');
  assert.match(request.headers.Topic, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(request.headers.Topic, sent[1].headers.Topic);
  const authorization = /^vapid t=([^,]+), k=(.+)$/.exec(request.headers.Authorization);
  assert.equal(authorization[2], publicKey);
  const [header, claims, signature] = authorization[1].split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { typ: 'JWT', alg: 'ES256' });
  const decodedClaims = JSON.parse(Buffer.from(claims, 'base64url'));
  assert.equal(decodedClaims.aud, 'https://web.push.apple.com');
  assert.equal(decodedClaims.sub, env.PUSH_VAPID_SUBJECT);
  assert.ok(decodedClaims.exp > Date.now() / 1000 + 11 * 60 * 60 && decodedClaims.exp <= Date.now() / 1000 + 12 * 60 * 60);
  assert.equal(verify('sha256', Buffer.from(`${header}.${claims}`), { key: vapid.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')), true);

  const body = Buffer.from(request.body);
  assert.equal(body.readUInt32BE(16), 4096);
  assert.equal(body[20], 65);
  const senderPublic = body.subarray(21, 86);
  const shared = receiver.computeSecret(senderPublic);
  const ikm = hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), receiver.getPublicKey(), senderPublic]), 32);
  const key = hkdfSync('sha256', ikm, body.subarray(0, 16), Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdfSync('sha256', ikm, body.subarray(0, 16), Buffer.from('Content-Encoding: nonce\0'), 12);
  const decipher = createDecipheriv('aes-128-gcm', Buffer.from(key), Buffer.from(nonce));
  decipher.setAuthTag(body.subarray(-16));
  const plaintext = Buffer.concat([decipher.update(body.subarray(86, -16)), decipher.final()]);
  assert.equal(plaintext.at(-1), 2);
  assert.deepEqual(JSON.parse(plaintext.subarray(0, -1)), payload);
  assert.equal(plaintext.includes(Buffer.from('private')), false);
  assert.notDeepEqual(body.subarray(0, 16), Buffer.from(sent[1].body).subarray(0, 16));
  assert.notDeepEqual(senderPublic, Buffer.from(sent[1].body).subarray(21, 86));
});

test('does not fetch for invalid input or an already cancelled subscription', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(null, { status: 201 }); };
  try {
    await assert.rejects(sendWebPush({ ...subscription, endpoint: 'https://example.test/' }, payload, env));
    await assert.rejects(sendWebPush(subscription, payload, {}));
    await assert.rejects(sendWebPush(subscription, { ...payload, messageId: 0 }, env));
    await assert.rejects(sendWebPush(subscription, { ...payload, language: 'private text' }, env));
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(sendWebPush(subscription, payload, env, { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(calls, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('returns only provider status and aborts in-flight delivery when revoked', async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let requested;
  const started = new Promise(resolve => { requested = resolve; });
  globalThis.fetch = async (_url, { signal }) => {
    requested();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  };
  try {
    const sending = sendWebPush(subscription, payload, env, { signal: controller.signal });
    await started;
    controller.abort();
    await assert.rejects(sending, { name: 'AbortError' });
    globalThis.fetch = async () => new Response('sensitive provider detail', { status: 410 });
    assert.deepEqual(await sendWebPush(subscription, payload, env), { status: 410 });
  } finally { globalThis.fetch = originalFetch; }
});
