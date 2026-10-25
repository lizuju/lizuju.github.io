import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const source = (await readFile(new URL('../../../static/portfolio/js/apps/sync-crypto.js', import.meta.url), 'utf8'))
  .replaceAll("'@serenity-kit/opaque'", JSON.stringify(import.meta.resolve('@serenity-kit/opaque')));
export const cryptoClient = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const runtimes = new WeakMap();
const getState = runtime => {
  if (!runtimes.has(runtime)) runtimes.set(runtime, { sessions: new Map(), offers: new Map(), updates: new WeakMap() });
  return runtimes.get(runtime);
};

export function encryptedClient(runtime, { origin = 'https://lizuju.github.io', ip = '198.51.100.1' } = {}) {
  const state = getState(runtime);
  const raw = async (path, { method = 'GET', token, json, body, headers = {} } = {}) => {
    const requestHeaders = { Origin: origin, 'CF-Connecting-IP': ip, ...headers };
    if (requestHeaders.Origin === null) delete requestHeaders.Origin;
    if (token !== undefined) requestHeaders.Authorization = `Bearer ${token}`;
    if (json !== undefined) { requestHeaders['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    const response = await runtime.dispatchFetch(`https://sync.test${path}`, { method, headers: requestHeaders, body });
    return {
      status: response.status, headers: response.headers,
      body: method !== 'HEAD' && response.headers.get('Content-Type')?.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer())
    };
  };
  const performUpdate = async session => {
    if (!session) return;
    const path = `/v1/spaces/${session.roomId}/key-grants`;
    const result = await raw(path, { token: session.token, headers: { 'X-Sync-Key-Id': session.keyring.currentKeyId } });
    if (result.status !== 200) return;
    for (const grant of result.body.grants) Object.assign(session, await cryptoClient.acceptKeyRotation(session, grant));
    if (result.body.grants.length) await raw(path, { method: 'DELETE', token: session.token, json: { through: result.body.grants.at(-1).id }, headers: { 'X-Sync-Key-Id': session.keyring.currentKeyId } });
    if (result.body.hasMore) await performUpdate(session);
  };
  const update = session => {
    if (!session) return Promise.resolve();
    if (state.updates.has(session)) return state.updates.get(session);
    const task = performUpdate(session).finally(() => state.updates.delete(session));
    state.updates.set(session, task);
    return task;
  };
  const offer = async session => {
    await update(session);
    const offerId = randomUUID();
    const secret = { ...await cryptoClient.createPairingSecret(String(Math.floor(Math.random() * 10000)).padStart(4, '0'), offerId), ownerDeviceId: session.deviceId };
    const encrypted = await cryptoClient.encryptPayload(session.keyring, session.roomId, `offer:${offerId}`, secret);
    const result = await raw(`/v1/spaces/${session.roomId}/pair-code`, { method: 'POST', token: session.token, headers: { 'X-Sync-Key-Id': session.keyring.currentKeyId }, json: { offerId, secret: encrypted } });
    if (result.status !== 200) return result;
    const wire = result.body;
    const opened = await cryptoClient.decryptPayload(session.keyring, session.roomId, `offer:${wire.offerId}`, wire.secret);
    state.offers.set(wire.offerId, { ...wire, secret: opened, session: state.sessions.get([...state.sessions].find(([, value]) => value.deviceId === wire.ownerDeviceId)?.[0]) || session });
    return { ...result, body: { ...wire, code: opened.code } };
  };
  const create = async options => {
    const keyring = await cryptoClient.createKeyring();
    const result = await raw('/v1/spaces', { ...options, json: { keyId: keyring.currentKeyId } });
    if (result.status !== 201) return result;
    const session = { ...result.body, keyring, identity: await cryptoClient.createDeviceIdentity(), trustedDevices: {}, revokedDevices: [] };
    session.trustedDevices[session.deviceId] = session.identity.publicKey;
    state.sessions.set(session.token, session);
    const name = await cryptoClient.encryptPayload(keyring, session.roomId, `device:${session.deviceId}`, { name: '', publicKey: session.identity.publicKey });
    await raw(`/v1/spaces/${session.roomId}/devices/${session.deviceId}`, { method: 'PATCH', token: session.token, headers: { 'X-Sync-Key-Id': keyring.currentKeyId }, json: { name } });
    const invitation = await offer(session);
    const { code, ...pairing } = invitation.status === 200 ? invitation.body : {};
    return { ...result, body: { ...result.body, ...(invitation.status === 200 ? { code, expiresAt: pairing.expiresAt, pairing } : {}) } };
  };
  const join = async code => {
    const entry = [...state.offers.values()].find(value => value.secret.code === code && value.expiresAt > Date.now());
    if (!entry) return raw('/v1/pair', { method: 'POST', json: { code } });
    const host = entry.session;
    await update(host);
    const offerId = entry.offerId, requestId = randomUUID(), requestToken = randomBytes(32).toString('hex');
    const start = await cryptoClient.startPairingClient(code, offerId);
    let result = await raw('/v1/pair', { method: 'POST', json: { requestId, requestToken, requests: [{ offerId, startLoginRequest: start.startLoginRequest }] } });
    if (result.status !== 202) return result;
    const response = await cryptoClient.startPairingHost(entry.secret, offerId, requestId, start.startLoginRequest);
    const authHeaders = { 'X-Sync-Key-Id': host.keyring.currentKeyId };
    result = await raw(`/v1/spaces/${host.roomId}/pair-challenge`, { method: 'POST', token: host.token, headers: authHeaders, json: { requestId, offerId, loginResponse: response.loginResponse } });
    if (result.status !== 200) return result;
    const accepted = await cryptoClient.finishPairingClient(start.clientState, offerId, requestId, response.loginResponse);
    const identity = await cryptoClient.createDeviceIdentity();
    const nonce = randomBytes(32).toString('hex');
    const clientData = await cryptoClient.encryptPairing(accepted.sessionKey, offerId, requestId, { nonce, publicKey: identity.publicKey });
    result = await raw(`/v1/pair/${requestId}`, { method: 'POST', token: requestToken, json: { offerId, finishLoginRequest: accepted.finishLoginRequest, clientData } });
    if (result.status !== 200) return result;
    const sessionKey = await cryptoClient.finishPairingHost(response.serverState, accepted.finishLoginRequest);
    const deviceId = randomUUID(), token = randomBytes(32).toString('hex');
    const recipients = Object.entries(host.trustedDevices).map(([deviceId, publicKey]) => ({ deviceId, publicKey }));
    recipients.push({ deviceId, publicKey: identity.publicKey });
    const rotation = await cryptoClient.createKeyRotation(host, recipients);
    const name = await cryptoClient.encryptPayload(rotation.next.keyring, host.roomId, `device:${deviceId}`, { name: '', publicKey: identity.publicKey });
    const grant = await cryptoClient.encryptPairing(sessionKey, offerId, requestId, { roomId: host.roomId, deviceId, token, ...rotation.next, nonce });
    result = await raw(`/v1/spaces/${host.roomId}/pair-accept`, { method: 'POST', token: host.token, headers: authHeaders, json: { requestId, offerId, deviceId, token, name, grant, rotationId: rotation.rotationId, newKeyId: rotation.newKeyId, grants: rotation.grants.filter(value => value.deviceId !== deviceId) } });
    if (result.status !== 200) return result;
    const polled = await raw(`/v1/pair/${requestId}`, { token: requestToken });
    const session = { ...await cryptoClient.decryptPairing(accepted.sessionKey, offerId, requestId, polled.body.grant), identity };
    delete session.nonce;
    state.sessions.set(token, session);
    await update(host);
    await raw(`/v1/pair/${requestId}/ack`, { method: 'POST', token: requestToken });
    return { ...result, body: { roomId: session.roomId, deviceId, token, pairing: null } };
  };
  const decode = async (value, session) => {
    if (!value || typeof value !== 'object' || Buffer.isBuffer(value)) return value;
    if (Array.isArray(value)) return Promise.all(value.map(item => decode(item, session)));
    if (typeof value.text === 'string' && value.text.startsWith('e2ee1.')) {
      const payload = await cryptoClient.decryptPayload(session.keyring, session.roomId, `message:${value.deviceId}:${value.clientId}`, value.text);
      return { ...value, ...payload };
    }
    if (value.devices) value.devices = await Promise.all(value.devices.map(async device => ({ ...device, name: device.name ? (await cryptoClient.decryptPayload(session.keyring, session.roomId, `device:${device.deviceId}`, device.name)).name : '' })));
    for (const key of ['messages', 'message']) if (value[key]) value[key] = await decode(value[key], session);
    return value;
  };
  const request = async (path, options = {}) => {
    const { method = 'GET', token } = options;
    if (path === '/v1/spaces' && method === 'POST' && options.json === undefined && options.body === undefined) return create(options);
    if (path === '/v1/pair' && method === 'POST' && options.json && Object.keys(options.json).length === 1 && /^\d{4}$/.test(options.json.code)) return join(options.json.code);
    const session = state.sessions.get(token);
    if (!session) return raw(path, options);
    await update(session);
    if (path === `/v1/spaces/${session.roomId}/pair-code` && method === 'POST' && options.json === undefined) return offer(session);
    const outgoing = { ...options, headers: { 'X-Sync-Key-Id': session.keyring.currentKeyId, ...options.headers } };
    if (options.json) {
      const value = { ...options.json };
      if (path.endsWith('/messages') && method === 'POST' && typeof value.text === 'string' && !value.text.startsWith('e2ee1.')) value.text = await cryptoClient.encryptPayload(session.keyring, session.roomId, `message:${session.deviceId}:${value.clientId}`, { text: value.text });
      if (/\/devices\/[^/]+$/.test(path) && method === 'PATCH' && typeof value.name === 'string' && !value.name.startsWith('e2ee1.')) {
        const target = path.split('/').at(-1);
        const peer = [...state.sessions.values()].find(item => item.deviceId === target);
        value.name = await cryptoClient.encryptPayload(session.keyring, session.roomId, `device:${target}`, { name: value.name.trim(), publicKey: peer?.identity.publicKey || '' });
      }
      if (path.endsWith('/files/uploads') && method === 'POST') {
        const attachment = { name: value.name, type: value.type || 'application/octet-stream', size: value.size };
        value.name = /^[0-9a-f-]{36}$/.test(value.name) ? value.name : '13b34bdc-047a-4a50-882a-46483def821a';
        value.type = 'application/octet-stream';
        value.fingerprint ??= 'a'.repeat(64);
        value.text = await cryptoClient.encryptPayload(session.keyring, session.roomId, `message:${session.deviceId}:${value.clientId}`, { text: value.text || '', attachment });
      }
      outgoing.json = value;
    }
    const result = await raw(path, outgoing);
    if (result.status < 300) result.body = await decode(result.body, session);
    return result;
  };
  request.raw = raw;
  request.decode = decode;
  request.state = state;
  request.update = update;
  return request;
}
