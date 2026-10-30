import assert from 'node:assert/strict';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { Miniflare } from 'miniflare';

const origin = 'https://lizuju.github.io';
const workerName = 'sync-gomoku-test';
const sockets = new Set();
let runtime;
const cipher = keyId => `e2ee1.${Buffer.from(JSON.stringify({ keyId, iv: randomBytes(12).toString('base64url'), ciphertext: randomBytes(64).toString('base64url') })).toString('base64url')}`;

before(async () => {
  runtime = new Miniflare({ unsafeInspectDurableObjects: true, workers: [{ config: {
    name: workerName, compatibilityDate: '2026-10-23', manifest: { mainModule: 'index.js', modules: {
      'index.js': { type: 'esm', contents: await readFile(new URL('../src/index.js', import.meta.url), 'utf8') },
      'daily-usage.js': { type: 'esm', contents: await readFile(new URL('../src/daily-usage.js', import.meta.url), 'utf8') },
      'api-version.js': { type: 'esm', contents: await readFile(new URL('../src/api-version.js', import.meta.url), 'utf8') }
    } }, env: { ALLOWED_ORIGINS: { type: 'text', value: origin },
      ...Object.fromEntries([['E2EE_PAIRING_REGISTRY', 'E2eePairingRegistry'], ['E2EE_SYNC_ROOMS', 'E2eeSyncRoom'], ['E2EE_FILE_SHARDS', 'E2eeFileShard']]
        .map(([key, name]) => [key, { type: 'durable-object', worker: workerName, exportName: name }])) },
    exports: Object.fromEntries(['E2eePairingRegistry', 'E2eeSyncRoom', 'E2eeFileShard'].map(name => [name, { type: 'durable-object', storage: 'sqlite' }]))
  } }] });
  await runtime.ready;
});

after(async () => {
  for (const socket of sockets) if (socket.readyState === 1) socket.close();
  await runtime.dispose();
});

async function request(path, device, { method = 'GET', json } = {}) {
  const response = await runtime.dispatchFetch(`https://sync.test${path}`, { method,
    headers: { Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': randomUUID(),
      ...(device ? { Authorization: `Bearer ${device.token}`, 'X-Sync-Key-Id': device.keyId } : {}) },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}) });
  return { status: response.status, body: await response.json() };
}

async function room(peerCount = 1) {
  const keyId = randomUUID();
  const created = await request('/v1/spaces', null, { method: 'POST', json: { keyId } });
  assert.equal(created.status, 201);
  const host = { ...created.body, keyId };
  const storage = await runtime.unsafeGetDurableObjectStorage(workerName, 'E2eeSyncRoom', { name: host.roomId });
  const peers = [];
  for (let index = 0; index < peerCount; index++) {
    const peer = { roomId: host.roomId, deviceId: randomUUID(), token: randomBytes(32).toString('hex'), keyId };
    await storage.exec('INSERT INTO devices (token_hash, device_id, created_at, last_active_at) VALUES (?, ?, ?, ?)',
      createHash('sha256').update(peer.token).digest('hex'), peer.deviceId, Date.now(), Date.now());
    peers.push(peer);
  }
  return { host, peers, storage, path: `/v1/spaces/${host.roomId}` };
}

async function invite(device, id = randomUUID()) {
  return request(`/v1/spaces/${device.roomId}/messages`, device, { method: 'POST', json: { clientId: id, text: cipher(device.keyId), game: 'gomoku' } });
}

const act = (device, id, action, json = {}) => request(`/v1/spaces/${device.roomId}/gomoku/${id}/${action}`, device, { method: 'POST', json });
const read = (device, id) => request(`/v1/spaces/${device.roomId}/gomoku/${id}`, device);
const move = (device, game, row, col, commandId = randomUUID()) => act(device, game.id, 'move', { revision: game.revision, commandId, row, col });

async function playing() {
  const state = await room(2);
  const invitation = await invite(state.host);
  assert.equal(invitation.status, 201);
  const joined = await act(state.peers[0], invitation.body.game.id, 'join');
  assert.equal(joined.status, 200);
  return { ...state, guest: state.peers[0], spectator: state.peers[1], game: joined.body.game };
}

async function connect(device) {
  const response = await runtime.dispatchFetch(`https://sync.test/v1/spaces/${device.roomId}/socket`, { headers: { Origin: origin, Upgrade: 'websocket', 'CF-Connecting-IP': randomUUID() } });
  assert.equal(response.status, 101);
  const socket = response.webSocket;
  socket.accept();
  sockets.add(socket);
  const frames = [];
  const waiters = [];
  socket.addEventListener('message', event => {
    const frame = JSON.parse(event.data);
    frames.push(frame);
    for (const waiter of [...waiters]) if (waiter.predicate(frame)) { waiters.splice(waiters.indexOf(waiter), 1); clearTimeout(waiter.timer); waiter.resolve(frame); }
  });
  const next = predicate => {
    const received = frames.find(predicate);
    if (received) return Promise.resolve(received);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timer: setTimeout(() => reject(new Error('Expected websocket frame')), 5000) };
      waiters.push(waiter);
    });
  };
  socket.send(JSON.stringify({ type: 'auth', token: device.token }));
  return { socket, frames, next, ready: await next(frame => frame.type === 'ready') };
}

test('creates an encrypted invitation atomically, decorates history, and retries without another game', async () => {
  const { host, storage, path } = await room();
  const id = randomUUID();
  const text = cipher(host.keyId);
  const options = { method: 'POST', json: { clientId: id, text, game: 'gomoku' } };
  const created = await request(`${path}/messages`, host, options);
  assert.equal(created.status, 201);
  assert.equal(created.body.text, text);
  assert.equal(created.body.game.id, id);
  assert.equal(created.body.game.status, 'waiting');
  assert.equal(created.body.game.hostDeviceId, host.deviceId);
  assert.equal(Object.hasOwn(created.body.game, 'board'), false);
  await storage.exec('CREATE TABLE game_writes (revision INTEGER)');
  await storage.exec('CREATE TRIGGER count_game_writes AFTER UPDATE ON gomoku_games BEGIN INSERT INTO game_writes (revision) VALUES (NEW.revision); END');
  const retried = await request(`${path}/messages`, host, options);
  assert.equal(retried.status, 200);
  assert.deepEqual(retried.body, created.body);
  const busy = await invite(host);
  assert.equal(busy.status, 409);
  assert.equal(busy.body.error, 'game_busy');
  assert.equal(busy.body.game.id, id);
  assert.deepEqual(await storage.exec('SELECT count(*) AS count FROM messages'), [{ count: 1 }]);
  assert.deepEqual(await storage.exec('SELECT count(*) AS count FROM gomoku_games'), [{ count: 1 }]);
  assert.deepEqual(await storage.exec('SELECT count(*) AS count FROM game_writes'), [{ count: 0 }]);
  assert.deepEqual((await request(`${path}/messages`, host)).body.messages[0].game, created.body.game);
  const current = (await read(host, id)).body.game;
  assert.deepEqual(current.board, Array(225).fill(0));
  assert.equal(current.lastMove, null);
  assert.equal((await request(`${path}/messages`, host, { method: 'POST', json: { clientId: randomUUID(), text: 'plain', game: 'gomoku' } })).status, 400);
  assert.equal((await request(`${path}/messages`, host, { method: 'POST', json: { clientId: randomUUID(), text, game: 'chess' } })).status, 400);
});

test('concurrent joiners claim one seat, late joiners watch, and a device cannot play two games', async () => {
  const { host, peers } = await room(4);
  const other = await invite(peers[3]);
  const invitation = await invite(host);
  const id = invitation.body.game.id;
  const joined = await Promise.all(peers.slice(0, 3).map(peer => act(peer, id, 'join')));
  for (const result of joined) assert.equal(result.status, 200);
  const seats = new Set(joined.map(result => result.body.game.guestDeviceId));
  assert.equal(seats.size, 1);
  const winner = peers.find(peer => peer.deviceId === [...seats][0]);
  assert.equal((await act(winner, id, 'join')).body.game.revision, 2);
  assert.equal((await act(host, id, 'join')).body.game.revision, 2);
  assert.equal((await act(peers[3], id, 'join')).body.game.guestDeviceId, winner.deviceId);
  const blocked = await act(winner, other.body.game.id, 'join');
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error, 'game_busy');
  const cancelled = await act(peers[3], other.body.game.id, 'leave');
  assert.equal(cancelled.body.game.status, 'cancelled');
  assert.equal(cancelled.body.game.result, null);
  assert.equal(cancelled.body.game.canViewBoard, false);
  assert.equal(Object.hasOwn(cancelled.body.game, 'board'), false);
  assert.equal(Object.hasOwn((await read(host, other.body.game.id)).body.game, 'board'), false);
  assert.equal((await invite(peers[3])).status, 201);
});

test('concurrent invitations from one device create one message and one game', async () => {
  const { host, storage } = await room(0);
  const results = await Promise.all([invite(host), invite(host)]);
  assert.deepEqual(results.map(result => result.status).sort(), [201, 409]);
  assert.equal(results.find(result => result.status === 409).body.error, 'game_busy');
  assert.deepEqual(await storage.exec('SELECT count(*) AS count FROM messages'), [{ count: 1 }]);
  assert.deepEqual(await storage.exec('SELECT count(*) AS count FROM gomoku_games'), [{ count: 1 }]);
});

test('enforces membership, turn, occupied cells and revision while duplicate commands make one write', async () => {
  const { host, guest, spectator, game, storage } = await playing();
  const foreign = (await room(0)).host;
  assert.equal((await request(`/v1/spaces/${host.roomId}/gomoku/${game.id}`, foreign)).status, 401);
  assert.equal((await read(foreign, game.id)).body.error, 'game_not_found');
  assert.equal((await move(spectator, game, 0, 0)).body.error, 'game_not_player');
  assert.equal((await move(guest, game, 0, 0)).body.error, 'game_not_turn');
  assert.equal((await move(host, game, -1, 0)).body.error, 'game_invalid_move');
  await storage.exec('CREATE TABLE game_writes (revision INTEGER)');
  await storage.exec('CREATE TRIGGER count_game_writes AFTER UPDATE ON gomoku_games BEGIN INSERT INTO game_writes (revision) VALUES (NEW.revision); END');
  const commandId = randomUUID();
  const results = await Promise.all([move(host, game, 7, 7, commandId), move(host, game, 7, 7, commandId)]);
  assert.ok(results.every(result => result.status === 200));
  assert.deepEqual(results[0].body, results[1].body);
  assert.equal(results[0].body.game.revision, 3);
  assert.deepEqual(await storage.exec('SELECT count(*) AS count FROM game_writes'), [{ count: 1 }]);
  assert.equal((await move(guest, game, 8, 8)).body.error, 'game_conflict');
  const next = results[0].body.game;
  assert.equal((await move(guest, next, 7, 7)).body.error, 'game_invalid_move');
  const conflicting = await Promise.all([move(guest, next, 8, 8), move(guest, next, 9, 9)]);
  assert.deepEqual(conflicting.map(result => result.status).sort(), [200, 409]);
  assert.equal(conflicting.find(result => result.status === 409).body.game.revision, 4);
});

for (const [dr, dc] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
  test(`detects five along ${dr},${dc}, retains the winning board only on request and rejects further moves`, async () => {
    const { host, guest, game, storage, path } = await playing();
    const connected = await connect(guest);
    const board = Array(225).fill(0);
    let current = game;
    for (let index = 0; index < 5; index++) {
      const sent = await move(host, current, 5 + index * dr, 7 + index * dc);
      assert.equal(sent.status, 200);
      current = sent.body.game;
      board[(5 + index * dr) * 15 + 7 + index * dc] = 1;
      if (index < 4) {
        current = (await move(guest, current, 0, index * 2)).body.game;
        board[index * 2] = 2;
      }
    }
    const lastMove = { row: 5 + 4 * dr, col: 7 + 4 * dc };
    assert.equal(current.status, 'finished');
    assert.equal(current.canViewBoard, true);
    assert.equal(current.lastMove, null);
    assert.equal(Object.hasOwn(current, 'board'), false);
    assert.deepEqual(current.result, { winnerDeviceId: host.deviceId, reason: 'five', hostMoves: 5, guestMoves: 4, hostScore: 1, guestScore: 0 });
    assert.equal((await move(guest, current, 0, 14)).body.error, 'game_conflict');
    assert.deepEqual((await connected.next(frame => frame.type === 'gomoku' && frame.game.status === 'finished')).game, current);
    connected.socket.close();
    assert.deepEqual(await storage.exec('SELECT board, last_move, move_count FROM gomoku_games WHERE game_id = ?', game.id), [{ board: JSON.stringify(board), last_move: JSON.stringify(lastMove), move_count: 9 }]);
    await runtime.unsafeEvictDurableObject(workerName, 'E2eeSyncRoom', { name: host.roomId });
    assert.deepEqual((await read(guest, game.id)).body.game, { ...current, board, lastMove });
    assert.deepEqual((await request(`${path}/messages`, guest)).body.messages[0].game, current);
    const restored = await connect(guest);
    assert.deepEqual(restored.ready.messages[0].game, current);
    assert.deepEqual(restored.ready.activeGames, []);
    restored.socket.close();
  });
}

test('a guest victory scores the correct side and the winning command can be retried without changing the final board', async () => {
  const { host, guest, game } = await playing();
  let current = game;
  for (let index = 0; index < 4; index++) {
    current = (await move(host, current, 0, index * 2)).body.game;
    current = (await move(guest, current, 7, index + 4)).body.game;
  }
  current = (await move(host, current, 0, 8)).body.game;
  const commandId = randomUUID();
  const ended = await move(guest, current, 7, 8, commandId);
  assert.equal(ended.status, 200);
  assert.deepEqual(ended.body.game.result, { winnerDeviceId: guest.deviceId, reason: 'five', hostMoves: 5, guestMoves: 5, hostScore: 0, guestScore: 1 });
  const final = await read(host, game.id);
  assert.deepEqual(await move(guest, current, 7, 8, commandId), ended);
  assert.deepEqual(await read(host, game.id), final);
});

test('a full-board draw scores one point for both players and preserves the final stone on request', async () => {
  const { host, game, storage } = await playing();
  const board = Array.from({ length: 225 }, (_, index) => 1 + ((Math.floor(index / 15) + Math.floor((index % 15) / 2)) % 2));
  for (let row = 0; row < 15; row++) for (let col = 0; col < 15; col++) for (const [dr, dc] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
    if (row + 4 * dr >= 15 || col + 4 * dc < 0 || col + 4 * dc >= 15) continue;
    assert.equal(Array.from({ length: 5 }, (_, index) => board[(row + index * dr) * 15 + col + index * dc]).every(value => value === board[row * 15 + col]), false);
  }
  board[14 * 15] = 0;
  await storage.exec('UPDATE gomoku_games SET board = ?, move_count = 224 WHERE game_id = ?', JSON.stringify(board), game.id);
  const ended = await move(host, game, 14, 0);
  assert.equal(ended.status, 200);
  assert.deepEqual(ended.body.game.result, { winnerDeviceId: null, reason: 'draw', hostMoves: 113, guestMoves: 112, hostScore: 1, guestScore: 1 });
  assert.equal(Object.hasOwn(ended.body.game, 'board'), false);
  board[14 * 15] = 1;
  assert.deepEqual((await read(host, game.id)).body.game, { ...ended.body.game, board, lastMove: { row: 14, col: 0 } });
});

test('reconnects recover the same game, while spectators cannot leave for a player', async () => {
  const { host, guest, spectator, game } = await playing();
  const first = await connect(spectator);
  assert.deepEqual(first.ready.activeGames, [game]);
  assert.equal(Object.hasOwn(first.ready.messages[0].game, 'board'), false);
  const moved = (await move(host, game, 4, 4)).body.game;
  assert.deepEqual((await first.next(frame => frame.type === 'gomoku')).game, moved);
  first.socket.close();
  const restored = await connect(guest);
  assert.deepEqual(restored.ready.activeGames, [moved]);
  assert.equal((await act(spectator, game.id, 'leave')).body.error, 'game_not_player');
  const ended = (await act(guest, game.id, 'leave')).body.game;
  assert.deepEqual(ended.result, { winnerDeviceId: host.deviceId, reason: 'resigned', hostMoves: 1, guestMoves: 0, hostScore: 1, guestScore: 0 });
  assert.equal(ended.canViewBoard, true);
  assert.equal(Object.hasOwn(ended, 'board'), false);
  assert.deepEqual((await restored.next(frame => frame.type === 'gomoku' && frame.game.status === 'finished')).game, ended);
  const final = (await read(spectator, game.id)).body.game;
  assert.deepEqual(final, { ...ended, board: moved.board, lastMove: moved.lastMove });
  assert.equal((await move(host, final, 5, 5)).body.error, 'game_conflict');
  assert.equal((await move(guest, final, 5, 5)).body.error, 'game_conflict');
  assert.deepEqual((await act(spectator, game.id, 'join')).body.game, ended);
  assert.deepEqual((await act(guest, game.id, 'leave')).body.game, ended);
  assert.deepEqual((await read(host, game.id)).body.game, final);
  assert.equal((await invite(host)).status, 201);
});

test('old finished games without a stored board do not advertise a viewable position', async () => {
  const { host, guest, game, storage, path } = await playing();
  await move(host, game, 4, 4);
  await act(guest, game.id, 'leave');
  await storage.exec('UPDATE gomoku_games SET board = NULL, last_move = NULL WHERE game_id = ?', game.id);
  const final = (await read(host, game.id)).body.game;
  assert.equal(final.status, 'finished');
  assert.equal(final.canViewBoard, false);
  assert.equal(Object.hasOwn(final, 'board'), false);
  assert.equal(final.lastMove, null);
  assert.deepEqual((await request(`${path}/messages`, host)).body.messages[0].game, final);
});

test('both self-removal and authenticated key rotation finish the departing player game', async () => {
  for (const via of ['leave-space', 'key-rotation']) {
    const { host, guest, spectator, game, path } = await playing();
    if (via === 'leave-space') assert.equal((await request(`${path}/device`, guest, { method: 'DELETE' })).status, 200);
    else {
      const newKeyId = randomUUID();
      const rotated = await request(`${path}/key-rotation`, host, { method: 'POST', json: {
        rotationId: randomUUID(), newKeyId, removedDeviceId: guest.deviceId,
        grants: [host, spectator].map(device => ({ deviceId: device.deviceId, envelope: cipher(host.keyId) }))
      } });
      assert.equal(rotated.status, 200);
      host.keyId = newKeyId;
    }
    const ended = (await read(host, game.id)).body.game;
    assert.equal(ended.status, 'finished');
    assert.equal(ended.result.reason, 'device-left');
    assert.equal(ended.result.winnerDeviceId, host.deviceId);
    assert.equal((await read(guest, game.id)).status, 401);
  }
});

test('moves maintain only the requested game and reject its expired invitation without pruning unrelated history', async () => {
  const { host, guest, game, storage } = await playing();
  const connected = await connect(host);
  const oldClientId = randomUUID();
  const expiredAt = Date.now() - 7 * 24 * 60 * 60 * 1000 - 1;
  await storage.exec('INSERT INTO messages (client_id, device_id, text, created_at) VALUES (?, ?, ?, ?)', oldClientId, host.deviceId, cipher(host.keyId), expiredAt);
  const moved = await move(host, game, 5, 5);
  assert.equal(moved.status, 200);
  assert.deepEqual(await storage.exec('SELECT client_id FROM messages WHERE client_id = ?', oldClientId), [{ client_id: oldClientId }]);
  await storage.exec('UPDATE messages SET created_at = ? WHERE id = ?', expiredAt, game.messageId);
  const rejected = await move(guest, moved.body.game, 6, 6);
  assert.equal(rejected.status, 404);
  assert.equal(rejected.body.error, 'game_not_found');
  assert.deepEqual(await storage.exec('SELECT game_id FROM gomoku_games WHERE game_id = ?', game.id), []);
  assert.deepEqual(await storage.exec('SELECT client_id FROM messages WHERE client_id = ?', oldClientId), [{ client_id: oldClientId }]);
  assert.deepEqual((await connected.next(frame => frame.type === 'history')).activeGames, []);
  connected.socket.close();
});

test('clearing, seven-day expiry, capacity pruning and the 500-message cap delete final boards with their invitations', async () => {
  for (const mode of ['clear', 'expiry', 'capacity', 'count']) {
    const { host, guest, spectator, game, storage, path } = await playing();
    const moved = (await move(host, game, 4, 4)).body.game;
    await act(guest, game.id, 'leave');
    assert.deepEqual((await read(host, game.id)).body.game.board, moved.board);
    const connected = await connect(host);
    let retainedGame = null;
    if (mode === 'clear') await request(`${path}/messages`, host, { method: 'DELETE' });
    if (mode === 'expiry') {
      await storage.exec('UPDATE messages SET created_at = ? WHERE id = ?', Date.now() - 7 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000, game.messageId);
      assert.deepEqual((await read(host, game.id)).body.game.board, moved.board);
      await storage.exec('UPDATE messages SET created_at = ? WHERE id = ?', Date.now() - 7 * 24 * 60 * 60 * 1000 - 1, game.messageId);
    }
    if (mode === 'capacity') await (await runtime.getDurableObjectNamespace('E2EE_SYNC_ROOMS')).getByName(host.roomId).pruneOldest();
    if (mode === 'count') {
      retainedGame = (await invite(spectator)).body.game.id;
      for (let index = 0; index < 498; index++) await storage.exec('INSERT INTO messages (client_id, device_id, text, created_at) VALUES (?, ?, ?, ?)', randomUUID(), host.deviceId, cipher(host.keyId), Date.now());
      const posted = await request(`${path}/messages`, host, { method: 'POST', json: { clientId: randomUUID(), text: cipher(host.keyId) } });
      assert.equal(posted.status, 201);
    }
    assert.equal((await read(host, game.id)).body.error, 'game_not_found', mode);
    assert.deepEqual(await storage.exec('SELECT count(*) AS count FROM gomoku_games'), [{ count: retainedGame ? 1 : 0 }], mode);
    const frame = await connected.next(frame => ['cleared', 'history', 'message'].includes(frame.type) && frame.activeGames);
    assert.deepEqual(frame.activeGames.map(game => game.id), retainedGame ? [retainedGame] : [], mode);
    if (retainedGame) assert.equal((await read(host, retainedGame)).body.game.status, 'waiting');
    connected.socket.close();
  }
});

test('rematches require both original players, swap colors, preserve the old board and accumulate scores', async () => {
  const { host, guest, spectator, game, storage, path } = await playing();
  const finished = (await act(guest, game.id, 'leave')).body.game;
  const create = device => request(`${path}/messages`, device, { method: 'POST', json: {
    clientId: randomUUID(), text: cipher(device.keyId), game: 'gomoku', previousGameId: game.id
  } });
  for (const previousGameId of [[game.id], null, 'invalid']) {
    const rejected = await request(`${path}/messages`, host, { method: 'POST', json: {
      clientId: randomUUID(), text: cipher(host.keyId), game: 'gomoku', previousGameId
    } });
    assert.equal(rejected.status, 400);
  }
  assert.equal((await create(spectator)).status, 403);
  const attempts = await Promise.all([create(host), create(guest)]);
  assert.deepEqual(attempts.map(value => value.status).sort(), [201, 409]);
  const next = attempts.find(value => value.status === 201).body.game;
  assert.equal(next.hostDeviceId, guest.deviceId);
  assert.equal(next.guestDeviceId, host.deviceId);
  assert.equal(next.status, 'waiting');
  assert.equal((await act(spectator, next.id, 'join')).status, 403);
  const requester = next.requestedBy === host.deviceId ? host : guest;
  const opponent = requester === host ? guest : host;
  assert.equal((await act(requester, next.id, 'join')).body.game.status, 'waiting');
  const accepted = (await act(opponent, next.id, 'join')).body.game;
  assert.equal(accepted.status, 'playing');
  assert.equal(accepted.turnDeviceId, guest.deviceId);
  assert.equal(accepted.board.filter(Boolean).length, 0);
  const old = (await read(host, game.id)).body.game;
  assert.deepEqual(old.result, finished.result);
  assert.equal(old.nextGameId, next.id);
  assert.equal(old.board.length, 225);
  const ended = (await act(host, next.id, 'leave')).body.game;
  assert.equal(ended.result.hostScore, 1);
  assert.equal(ended.result.guestScore, 1);
  assert.equal((await storage.exec('SELECT count(*) AS count FROM gomoku_games'))[0].count, 2);
});

test('either rematch player can cancel and request again without overwriting a finished game', async () => {
  const { host, guest, game, path } = await playing();
  await act(guest, game.id, 'leave');
  const create = () => request(`${path}/messages`, host, { method: 'POST', json: {
    clientId: randomUUID(), text: cipher(host.keyId), game: 'gomoku', previousGameId: game.id
  } });
  const next = (await create()).body.game;
  assert.equal((await act(guest, next.id, 'leave')).body.game.status, 'cancelled');
  assert.equal((await create()).status, 201);
  assert.equal((await read(host, game.id)).body.game.status, 'finished');
});
