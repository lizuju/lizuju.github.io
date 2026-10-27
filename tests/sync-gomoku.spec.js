const { test, expect } = require('@playwright/test');
const { Miniflare } = require('../cloudflare/sync/node_modules/miniflare');
const { createServer, request: httpRequest } = require('node:http');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { startSite } = require('./fixtures/sync-e2ee.cjs');

const root = path.resolve(__dirname, '..');
test.use({ actionTimeout: 15000 });
const wireBodies = [];
const messageBodies = [];
const upgradedSockets = new Map();
let runtime;
let runtimeOrigin;
let site;
let api;
let apiOrigin;
let beforeForward;

test.beforeEach(async () => {
    wireBodies.length = 0;
    messageBodies.length = 0;
    beforeForward = null;
    api = createServer(async (incoming, outgoing) => {
        try {
            const chunks = [];
            for await (const chunk of incoming) chunks.push(chunk);
            const body = Buffer.concat(chunks);
            if (body.length) wireBodies.push(body);
            if (incoming.method === 'POST' && /\/messages$/.test(incoming.url)) messageBodies.push(JSON.parse(body.toString()));
            await beforeForward?.(incoming);
            const response = await runtime.dispatchFetch(new URL(incoming.url, apiOrigin), {
                method: incoming.method, headers: incoming.headers,
                ...(!['GET', 'HEAD'].includes(incoming.method) ? { body } : {})
            });
            outgoing.writeHead(response.status, Object.fromEntries(response.headers));
            outgoing.end(Buffer.from(await response.arrayBuffer()));
        } catch { outgoing.destroy(); }
    });
    api.on('upgrade', (request, socket, head) => {
        const upstream = httpRequest(new URL(request.url, runtimeOrigin), { headers: request.headers });
        upstream.on('upgrade', (response, peer, upstreamHead) => {
            for (const connection of [socket, peer]) {
                upgradedSockets.set(connection, request.headers['sec-websocket-protocol'] || '');
                connection.on('close', () => upgradedSockets.delete(connection));
                connection.on('error', () => { socket.destroy(); peer.destroy(); });
            }
            socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n${Object.entries(response.headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`);
            if (head.length) peer.write(head);
            if (upstreamHead.length) socket.write(upstreamHead);
            socket.pipe(peer).pipe(socket);
        });
        upstream.on('error', () => socket.destroy());
        upstream.end();
    });
    await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
    apiOrigin = `http://127.0.0.1:${api.address().port}`;
    site = await startSite(apiOrigin);
    runtime = new Miniflare({
        host: '127.0.0.1', port: 0,
        workers: [{ config: {
            name: 'sync-gomoku-browser', compatibilityDate: '2026-10-23',
            manifest: { mainModule: 'index.js', modules: {
                'index.js': { type: 'esm', contents: await readFile(path.join(root, 'cloudflare/sync/src/index.js'), 'utf8') },
                'daily-usage.js': { type: 'esm', contents: await readFile(path.join(root, 'cloudflare/sync/src/daily-usage.js'), 'utf8') }
            } },
            env: {
                ALLOWED_ORIGINS: { type: 'text', value: site.origin },
                E2EE_PAIRING_REGISTRY: { type: 'durable-object', worker: 'sync-gomoku-browser', exportName: 'E2eePairingRegistry' },
                E2EE_SYNC_ROOMS: { type: 'durable-object', worker: 'sync-gomoku-browser', exportName: 'E2eeSyncRoom' },
                E2EE_FILE_SHARDS: { type: 'durable-object', worker: 'sync-gomoku-browser', exportName: 'E2eeFileShard' }
            },
            exports: Object.fromEntries(['E2eePairingRegistry', 'E2eeSyncRoom', 'E2eeFileShard'].map(name => [name, { type: 'durable-object', storage: 'sqlite' }]))
        } }]
    });
    runtimeOrigin = await runtime.ready;
});

test.afterEach(async () => {
    await site?.close();
    upgradedSockets.forEach((protocol, socket) => socket.destroy());
    if (api) { api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); }
    await runtime?.dispose();
});

const awaitOnline = page => expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online', { timeout: 30000 });

const readSession = page => page.evaluate(async () => {
    const descriptor = JSON.parse(localStorage.getItem('portfolio-sync-space-e2ee1'));
    const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open('gavin-sync-key-vault', 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    const saved = await new Promise((resolve, reject) => {
        const request = database.transaction('sessions').objectStore('sessions').get(descriptor.vaultId);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    database.close();
    const bytes = text => Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), byte => byte.charCodeAt(0));
    const opened = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(saved.encrypted.iv), additionalData: new TextEncoder().encode(`gavin-sync-vault-v1:${descriptor.vaultId}`) }, saved.key, bytes(saved.encrypted.ciphertext));
    return JSON.parse(new TextDecoder().decode(opened));
});

const pairDevices = async (browser, isMobile) => {
    const contexts = await Promise.all(Array.from({ length: 3 }, () => browser.newContext({
        viewport: isMobile ? { width: 320, height: 568 } : { width: 1366, height: 900 }, isMobile, hasTouch: isMobile
    })));
    try {
        if (browser.browserType().name() === 'chromium') await Promise.all(contexts.map(context => context.grantPermissions(['local-network-access'])));
        const pages = await Promise.all(contexts.map(context => context.newPage()));
        const pageErrors = [];
        pages.forEach(page => page.on('pageerror', error => pageErrors.push(error.message)));
        await Promise.all(pages.map(page => page.goto(`${site.origin}/chat/`)));
        if (isMobile) {
            await Promise.all(pages.map(async page => {
                const toggle = page.locator('[data-sync-spaces-toggle]');
                if (await toggle.getAttribute('aria-expanded') === 'true') await toggle.click();
                await expect(toggle).toHaveAttribute('aria-expanded', 'false');
            }));
        }
        const [owner, ...members] = pages;
        await owner.locator('[data-sync-create]').click();
        await awaitOnline(owner);
        await expect(owner.locator('[data-sync-pair-code]')).toHaveText(/^\d{4}$/, { timeout: 30000 });
        await owner.locator('[data-sync-pair-lock]').click();
        await expect(owner.locator('[data-sync-pair-lock]')).toHaveAttribute('aria-pressed', 'true');
        const code = await owner.locator('[data-sync-pair-code]').textContent();
        for (const member of members) {
            await member.locator('[data-sync-code]').fill(code);
            await member.locator('[data-sync-join]').click();
            await awaitOnline(member);
        }
        return { contexts, pages, pageErrors, sessions: await Promise.all(pages.map(readSession)) };
    } catch (error) {
        await Promise.all(contexts.map(context => context.close()));
        throw error;
    }
};

const gameRequest = (session, id, action = '', body) => fetch(`${apiOrigin}/v1/spaces/${session.roomId}/gomoku/${id}${action}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: site.origin, Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json', 'X-Sync-Key-Id': session.keyring.currentKeyId },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
});

const readGame = async (session, id) => {
    const response = await gameRequest(session, id);
    expect(response.status).toBe(200);
    return (await response.json()).game;
};

const clickCell = async (page, row, col, isMobile) => {
    const canvas = page.locator('[data-sync-gomoku-board]');
    const bounds = await canvas.boundingBox();
    const size = Math.min(bounds.width, bounds.height);
    const margin = Math.max(12, size / 16);
    const step = (size - margin * 2) / 14;
    await canvas[isMobile ? 'tap' : 'click']({ position: { x: margin + col * step, y: margin + row * step } });
};

const expectBlackStone = (page, row, col) => expect.poll(() => page.locator('[data-sync-gomoku-board]').evaluate((canvas, { row, col }) => {
    const size = canvas.getBoundingClientRect().width;
    const margin = Math.max(12, size / 16);
    const step = (size - margin * 2) / 14;
    const x = Math.round((margin + (col + 0.2) * step) * canvas.width / size);
    const y = Math.round((margin + row * step) * canvas.height / size);
    const color = canvas.getContext('2d').getImageData(x, y, 1, 1).data;
    return color[0] < 80 && color[1] < 80 && color[2] < 80 && color[3] === 255;
}, { row, col })).toBe(true);

test('keeps an encrypted invitation and one opponent through concurrent joins, reconnect and a nine-move win', async ({ browser, isMobile }, testInfo) => {
    test.setTimeout(120000);
    const { contexts, pages, sessions, pageErrors } = await pairDevices(browser, isMobile);
    const [owner, firstMember, secondMember] = pages;
    const [hostSession] = sessions;
    const draft = 'keep-this-private-draft-while-inviting';
    try {
        await owner.locator('[data-sync-input]').fill(draft);
        await owner.locator('[data-sync-game-share]').click();
        await expect(owner.locator('[data-sync-input]')).toHaveValue(draft);
        const ownerCard = owner.locator('[data-sync-game-card]');
        await expect(ownerCard).toHaveCount(1);
        const id = await ownerCard.getAttribute('data-sync-game-card');
        await Promise.all(pages.map(page => expect(page.locator(`[data-sync-game-card="${id}"]`)).toBeVisible()));
        expect(messageBodies).toHaveLength(1);
        expect(messageBodies[0]).toMatchObject({ game: 'gomoku', clientId: id });
        expect(messageBodies[0].text).toMatch(/^e2ee1\./);
        expect(Buffer.concat(wireBodies).includes(Buffer.from(draft))).toBe(false);
        for (const page of pages) await expect(page.locator('[data-sync-game-result]')).toBeHidden();
        await expect(owner.locator('[data-sync-gomoku-window]')).toBeVisible();
        await expect(owner.locator('[data-sync-gomoku-move-count]')).toHaveText('0');

        let joinRequests = 0;
        let releaseJoins;
        const joinsReady = new Promise(resolve => { releaseJoins = resolve; });
        beforeForward = incoming => {
            if (incoming.method !== 'POST' || incoming.url !== `/v1/spaces/${hostSession.roomId}/gomoku/${id}/join`) return;
            joinRequests += 1;
            if (joinRequests === 2) releaseJoins();
            return joinsReady;
        };
        await Promise.all([firstMember, secondMember].map(page => page.locator(`[data-sync-game-card="${id}"] [data-sync-game-join]`).click()));
        await expect.poll(() => joinRequests).toBe(2);
        beforeForward = null;
        await expect.poll(async () => (await readGame(hostSession, id)).status).toBe('playing');
        const started = await readGame(hostSession, id);
        expect(started.hostDeviceId).toBe(hostSession.deviceId);
        expect(sessions.slice(1).map(session => session.deviceId)).toContain(started.guestDeviceId);
        const guestIndex = sessions.findIndex(session => session.deviceId === started.guestDeviceId);
        const watcherIndex = guestIndex === 1 ? 2 : 1;
        const guest = pages[guestIndex];
        const watcher = pages[watcherIndex];
        const watcherSession = sessions[watcherIndex];
        await Promise.all(pages.map(page => expect(page.locator('[data-sync-gomoku-board]')).toBeVisible()));
        for (const page of pages) {
            await expect(page.locator('[data-sync-gomoku-move-count]')).toHaveText('0');
            await expect(page.locator('[data-i18n="syncGameMoveCount"]')).toHaveText('步数');
        }
        const [hostBounds, countBounds, guestBounds] = await Promise.all([
            owner.locator('[data-sync-gomoku-player="host"]').boundingBox(),
            owner.locator('[data-sync-gomoku-move-count]').locator('..').boundingBox(),
            owner.locator('[data-sync-gomoku-player="guest"]').boundingBox()
        ]);
        expect(hostBounds.x + hostBounds.width).toBeLessThanOrEqual(countBounds.x);
        expect(countBounds.x + countBounds.width).toBeLessThanOrEqual(guestBounds.x);
        expect(Math.abs(countBounds.y - hostBounds.y)).toBeLessThanOrEqual(1);
        expect(Math.abs(countBounds.y - guestBounds.y)).toBeLessThanOrEqual(1);
        await expect(watcher.locator('[data-sync-gomoku-board]')).toHaveAttribute('aria-disabled', 'true');
        expect(started.board).toEqual(Array(225).fill(0));
        expect(started.result).toBeNull();

        const forbidden = await gameRequest(watcherSession, id, '/move', { revision: started.revision, commandId: 'e0457897-2e8a-47c7-aad6-844558e0ff89', row: 0, col: 0 });
        expect(forbidden.status).toBe(403);
        expect((await readGame(hostSession, id)).board).toEqual(started.board);
        await watcher.locator('[data-sync-gomoku-action="close"]').click();
        await expect(watcher.locator('[data-sync-gomoku-window]')).toBeHidden();
        expect((await readGame(hostSession, id)).status).toBe('playing');

        const moves = [
            [owner, 7, 3], [guest, 8, 3], [owner, 7, 4], [guest, 8, 4],
            [owner, 7, 5], [guest, 8, 5], [owner, 7, 6], [guest, 8, 6], [owner, 7, 7]
        ];
        for (let index = 0; index < moves.length; index += 1) {
            const [player, row, col] = moves[index];
            await clickCell(player, row, col, isMobile);
            if (index < moves.length - 1) {
                await expect.poll(async () => (await readGame(hostSession, id)).board.filter(Boolean).length).toBe(index + 1);
                const state = await readGame(hostSession, id);
                expect(state.board[row * 15 + col]).toBe(index % 2 === 0 ? 1 : 2);
                expect(state.result).toBeNull();
                for (const page of pages) await expect(page.locator('[data-sync-game-result]')).toBeHidden();
                for (const page of [owner, guest]) await expect(page.locator('[data-sync-gomoku-move-count]')).toHaveText(String(index + 1));
            }
            if (index === 2) {
                const saved = await readGame(hostSession, id);
                await expectBlackStone(owner, 7, 3);
                await owner.screenshot({ path: testInfo.outputPath('playing-gomoku-owner.png') });
                if (!isMobile) {
                    await owner.goto(`${site.origin}/portfolio/`);
                    await owner.locator('[data-window-action="minimize"]').click();
                    await owner.locator('.desktop-shortcut[data-open-sync-space]').click();
                    await expect(owner.locator('[data-sync-gomoku-window]')).toBeVisible();
                    await owner.locator('[data-sync-gomoku-action="minimize"]').click();
                    if (!await owner.locator('[data-sync-window]').evaluate(element => element.classList.contains('is-active'))) {
                        await owner.locator('[data-sync-task]').click();
                    }
                    await expect(owner.locator('[data-sync-window]')).toBeVisible();
                    await owner.locator('[data-sync-action="close"]').click();
                    await expect(owner.locator('[data-sync-window]')).toBeHidden();
                    await owner.locator('[data-sync-gomoku-task]').click();
                    await expect(owner.locator('[data-sync-gomoku-window]')).toBeVisible();
                    await owner.reload();
                    await expect(owner.locator('[data-sync-gomoku-window]')).toBeVisible();
                    await expect(owner.locator('[data-sync-window]')).toBeHidden();
                    expect((await readGame(hostSession, id)).board).toEqual(saved.board);
                    await expect(owner.locator('[data-sync-gomoku-move-count]')).toHaveText('3');
                }
                await contexts[guestIndex].setOffline(true);
                upgradedSockets.forEach((protocol, socket) => {
                    if (protocol.includes(`auth.${sessions[guestIndex].token}`)) socket.destroy();
                });
                await expect(guest.locator('[data-sync-status]')).not.toHaveAttribute('data-state', 'online');
                await contexts[guestIndex].setOffline(false);
                await guest.reload();
                await awaitOnline(guest);
                if (!await guest.locator('[data-sync-gomoku-window]').isVisible()) {
                    await guest.locator(`[data-sync-game-card="${id}"] [data-sync-game-open]`).click();
                }
                await expect(guest.locator('[data-sync-gomoku-board]')).toBeVisible();
                await expect(guest.locator('[data-sync-gomoku-move-count]')).toHaveText('3');
                const resumed = await readGame(hostSession, id);
                expect(resumed.board).toEqual(saved.board);
                expect(resumed.guestDeviceId).toBe(started.guestDeviceId);
                await expectBlackStone(guest, 7, 3);
                await watcher.locator(`[data-sync-game-card="${id}"] [data-sync-game-watch]`).click();
                await expect(watcher.locator('[data-sync-gomoku-board]')).toBeVisible();
                await expect(watcher.locator('[data-sync-gomoku-move-count]')).toHaveText('3');
                await expectBlackStone(watcher, 7, 3);
                await watcher.screenshot({ path: testInfo.outputPath('playing-gomoku-spectator.png') });
            }
        }

        await expect.poll(async () => (await readGame(hostSession, id)).status).toBe('finished');
        const finished = await readGame(hostSession, id);
        expect(finished.result).toMatchObject({ winnerDeviceId: hostSession.deviceId, hostMoves: 5, guestMoves: 4, hostScore: 1, guestScore: 0 });
        const finalBoard = Array(225).fill(0);
        moves.forEach(([, row, col], index) => { finalBoard[row * 15 + col] = index % 2 === 0 ? 1 : 2; });
        expect(finished.board).toEqual(finalBoard);
        expect(finished.lastMove).toEqual({ row: 7, col: 7 });
        for (const page of pages) {
            await expect(page.locator('[data-sync-gomoku-window]')).toBeHidden();
            const result = page.locator(`[data-sync-game-card="${id}"] [data-sync-game-result]`);
            await expect(result).toBeVisible();
            await expect(result).toContainText('5');
            await expect(result).toContainText('4');
            await expect(page.locator(`[data-sync-game-card="${id}"] [data-sync-game-join]`)).toBeHidden();
            await expect(page.locator(`[data-sync-game-card="${id}"] [data-sync-game-watch]`)).toBeHidden();
            await expect(page.locator(`[data-sync-game-card="${id}"] [data-sync-game-view]`)).toBeVisible();
        }
        await expect(owner.locator('[data-sync-input]')).toHaveValue(draft);
        const pairingDetails = owner.locator('details.sync-pairing');
        if (await pairingDetails.getAttribute('open') !== null) await pairingDetails.locator('summary').click();
        await owner.screenshot({ path: testInfo.outputPath('finished-gomoku-in-chat.png') });
        const finishedWrites = [];
        beforeForward = incoming => {
            if (incoming.method === 'POST' && incoming.url.startsWith(`/v1/spaces/${hostSession.roomId}/gomoku/${id}/`)) finishedWrites.push(incoming.url);
        };
        for (const page of [owner, watcher]) {
            await page.locator(`[data-sync-game-card="${id}"] [data-sync-game-view]`).click();
            const gameWindow = page.locator('[data-sync-gomoku-window]');
            const board = page.locator('[data-sync-gomoku-board]');
            await expect(gameWindow).toBeVisible();
            await expect(page.locator('[data-sync-gomoku-move-count]')).toHaveText('9');
            await expect(page.locator('[data-sync-gomoku-role]')).toHaveText('终局 · 仅供查看');
            await expect(page.locator('#sync-gomoku-keyboard-help')).toHaveText('终局 · 仅供查看');
            await expect(board).toHaveAttribute('aria-disabled', 'true');
            await expect.poll(() => page.evaluate(() => JSON.parse(window.render_game_to_text()).board)).toEqual(finalBoard);
            await expectBlackStone(page, 7, 7);
            await expect(gameWindow.getByRole('button', { name: /回放|重播|上一手|下一手|Replay|Previous move|Next move/i })).toHaveCount(0);
            await expect(gameWindow.locator('input[type="range"], [role="slider"]')).toHaveCount(0);
            await clickCell(page, 0, 0, isMobile);
            await board.press('ArrowRight');
            await board.press('Enter');
            await board.press('Space');
            await expect.poll(() => page.evaluate(() => JSON.parse(window.render_game_to_text()).board)).toEqual(finalBoard);
            expect((await readGame(hostSession, id)).revision).toBe(finished.revision);
            const boardBounds = await board.boundingBox();
            const windowBounds = await gameWindow.boundingBox();
            expect(boardBounds.width).toBeGreaterThan(180);
            expect(Math.abs(boardBounds.width - boardBounds.height)).toBeLessThanOrEqual(1);
            expect(boardBounds.x).toBeGreaterThanOrEqual(windowBounds.x);
            expect(boardBounds.x + boardBounds.width).toBeLessThanOrEqual(windowBounds.x + windowBounds.width);
            expect(boardBounds.y + boardBounds.height).toBeLessThanOrEqual(windowBounds.y + windowBounds.height);
            await page.screenshot({ path: testInfo.outputPath(`finished-gomoku-${page === owner ? 'owner' : 'spectator'}-review.png`) });
            await page.locator('[data-sync-gomoku-action="close"]').click();
            await expect(gameWindow).toBeHidden();
            await expect(page.locator('[data-sync-gomoku-confirm]')).not.toBeVisible();
        }
        expect(finishedWrites).toEqual([]);
        await guest.reload();
        await awaitOnline(guest);
        await expect(guest.locator(`[data-sync-game-card="${id}"] [data-sync-game-result]`)).toBeVisible();
        await expect(guest.locator('[data-sync-gomoku-window]')).toBeHidden();
        await guest.locator(`[data-sync-game-card="${id}"] [data-sync-game-view]`).click();
        await expect(guest.locator('[data-sync-gomoku-window]')).toBeVisible();
        await expect(guest.locator('[data-sync-gomoku-move-count]')).toHaveText('9');
        await expect.poll(() => guest.evaluate(() => JSON.parse(window.render_game_to_text()).board)).toEqual(finalBoard);
        await expectBlackStone(guest, 7, 7);
        await guest.locator('[data-taskbar-lang]').click();
        await expect(guest.locator('[data-sync-gomoku-role]')).toHaveText('Final position · Read only');
        await expect(guest.locator('#sync-gomoku-keyboard-help')).toHaveText('Final position · Read only');
        await expect(guest.locator('[data-i18n="syncGameMoveCount"]')).toHaveText('Moves');
        await expect(guest.locator('[data-sync-gomoku-move-count]')).toHaveText('9');
        expect(finishedWrites).toEqual([]);
        const cleared = await fetch(`${apiOrigin}/v1/spaces/${hostSession.roomId}/messages`, {
            method: 'DELETE',
            headers: { Origin: site.origin, Authorization: `Bearer ${hostSession.token}`, 'X-Sync-Key-Id': hostSession.keyring.currentKeyId }
        });
        expect(cleared.status).toBe(200);
        await expect(guest.locator('[data-sync-gomoku-window]')).toBeHidden();
        for (const page of pages) await expect(page.locator(`[data-sync-game-card="${id}"]`)).toHaveCount(0);
        expect(pageErrors).toEqual([]);
    } finally {
        await Promise.all(contexts.map(context => context.close()));
    }
});
