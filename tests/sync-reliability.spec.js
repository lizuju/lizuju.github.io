const { test, expect } = require('./fixtures/sync-e2ee.cjs');

const { roomId, deviceId, keyId, authorize, message } = require('./fixtures/sync-e2ee.cjs');
const headers = {
    'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Sync-Key-Id',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Access-Control-Expose-Headers': 'Retry-After'
};
const bounds = (latestId, continuationId = latestId, hasNewer = false) => ({ generation: '1', oldestId: 1, latestId, continuationId, hasNewer });
const prepare = async (page) => {
    await authorize(page);
    await page.route('**/portfolio/sync-config.json', route => route.fulfill({ json: { apiBase: 'https://sync.test' } }));
};
const open = async (page) => {
    await page.goto('/portfolio/');
    await page.locator('[data-window-action="minimize"]').click();
    await page.locator('.desktop-shortcut[data-open-sync-space]').click();
    await expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
};
const routeDefault = (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    return route.fulfill({ headers, json: { deviceId, devices: [], grants: [], hasMore: false, keyId } });
};

test('confirms a text send from HTTP before a delayed socket echo and keeps the next draft', async ({ page, isMobile }) => {
    test.skip(isMobile, 'the sync application is a desktop window');
    await prepare(page);
    let release;
    let sent;
    let socket;
    await page.route('https://sync.test/**', async route => {
        if (route.request().method() === 'OPTIONS') return routeDefault(route);
        if (route.request().url().endsWith('/messages')) {
            const body = route.request().postDataJSON();
            sent = { id: 1, deviceId, clientId: body.clientId, text: body.text, createdAt: Date.now() };
            await new Promise(resolve => { release = resolve; });
            return route.fulfill({ headers, json: sent });
        }
        return routeDefault(route);
    });
    await page.routeWebSocket('wss://sync.test/**', connection => {
        socket = connection;
        connection.onMessage(data => {
            if (data === 'ping') return connection.send('pong');
            connection.send(JSON.stringify({ type: 'ready', deviceId, messages: [], pairing: null, history: bounds(null), historyMode: 'replace' }));
        });
    });
    await open(page);
    await page.locator('[data-sync-input]').fill('First message');
    await page.locator('[data-sync-send]').click();
    await expect.poll(() => !!release).toBe(true);
    await page.locator('[data-sync-input]').fill('Next draft');
    release();
    await expect(page.locator('.sync-message-text')).toHaveText('First message');
    await expect(page.locator('[data-sync-input]')).toHaveValue('Next draft');
    socket.send(JSON.stringify({ type: 'message', message: sent, history: bounds(1) }));
    await expect(page.locator('.sync-message')).toHaveCount(1);
});

test('searches retained earlier messages and ignores a cancelled history response', async ({ page, isMobile }) => {
    test.skip(isMobile, 'the sync application is a desktop window');
    await prepare(page);
    let olderRequests = 0;
    let release;
    let defer = false;
    let connection;
    await page.route('https://sync.test/**', async route => {
        if (route.request().method() === 'OPTIONS') return routeDefault(route);
        const url = new URL(route.request().url());
        if (url.pathname.endsWith('/messages')) {
            olderRequests++;
            if (defer) await new Promise(resolve => { release = resolve; });
            const before = Number(url.searchParams.get('before'));
            const start = Math.max(1, before - 50);
            const rows = Array.from({ length: before - start }, (_, index) => message(start + index, start + index === 1 ? 'Old needle' : `Message ${start + index}`));
            return route.fulfill({ headers, json: { messages: rows, history: bounds(150), historyMode: 'prepend' } });
        }
        return routeDefault(route);
    });
    await page.routeWebSocket('wss://sync.test/**', socket => {
        connection = socket;
        socket.onMessage(data => {
            if (data === 'ping') return socket.send('pong');
            socket.send(JSON.stringify({ type: 'ready', deviceId, pairing: null, messages: Array.from({ length: 50 }, (_, i) => message(i + 101)), history: bounds(150), historyMode: 'replace' }));
        });
    });
    await open(page);
    await page.locator('[data-sync-feed]').evaluate(feed => { feed.scrollTop = 0; });
    const anchor = page.getByText('Message 101', { exact: true });
    const before = await anchor.boundingBox();
    defer = true;
    await page.locator('[data-sync-search]').fill('needle');
    await expect.poll(() => !!release).toBe(true);
    await page.locator('[data-sync-search]').fill('');
    release();
    await expect(page.locator('.sync-message')).toHaveCount(50);
    expect(Math.abs((await anchor.boundingBox()).y - before.y)).toBeLessThan(2);
    defer = false;
    await page.locator('[data-sync-search]').fill('needle');
    await expect(page.locator('.sync-message:visible')).toHaveCount(1);
    await expect(page.locator('.sync-message:visible')).toContainText('Old needle');
    expect(olderRequests).toBe(3);
    await expect(page.locator('[data-sync-history-more]')).toBeHidden();
    await page.locator('[data-sync-search]').fill('');
    defer = true;
    release = null;
    connection.send(JSON.stringify({ type: 'history', messages: Array.from({ length: 50 }, (_, i) => message(i + 101)), history: bounds(150), historyMode: 'replace' }));
    await expect(page.locator('.sync-message')).toHaveCount(50);
    await page.locator('[data-sync-history-more]').click();
    await expect.poll(() => !!release).toBe(true);
    connection.send(JSON.stringify({ type: 'cleared', history: { generation: '2', oldestId: null, latestId: null } }));
    await expect(page.locator('.sync-message')).toHaveCount(0);
    release();
    await expect(page.locator('.sync-message')).toHaveCount(0);
    await expect(page.locator('[data-sync-history-more]')).toBeHidden();
});

test('catches up bounded reconnect pages without skipping a concurrent live message', async ({ page, isMobile }) => {
    test.skip(isMobile, 'the sync application is a desktop window');
    await prepare(page);
    let connections = 0;
    let firstSocket;
    let firstAfter;
    const cursors = [];
    await page.route('https://sync.test/**', route => {
        if (route.request().method() === 'OPTIONS') return routeDefault(route);
        const url = new URL(route.request().url());
        if (url.pathname.endsWith('/messages')) {
            const after = Number(url.searchParams.get('after'));
            cursors.push(after);
            const end = Math.min(160, after + 50);
            return route.fulfill({ headers, json: {
                messages: Array.from({ length: end - after }, (_, i) => message(after + i + 1)),
                history: bounds(160, end, end < 160), historyMode: 'append'
            } });
        }
        return routeDefault(route);
    });
    await page.routeWebSocket('wss://sync.test/**', socket => {
        connections++;
        const number = connections;
        if (number === 1) firstSocket = socket;
        else firstAfter = new URL(socket.url()).searchParams.get('after');
        socket.onMessage(data => {
            if (data === 'ping') return socket.send('pong');
            socket.send(JSON.stringify({ type: 'ready', deviceId, pairing: null,
                messages: Array.from({ length: 50 }, (_, i) => message(i + (number === 1 ? 1 : 51))),
                history: number === 1 ? bounds(50) : bounds(160, 100, true), historyMode: number === 1 ? 'replace' : 'append'
            }));
            if (number !== 1) socket.send(JSON.stringify({ type: 'message', message: message(160), history: bounds(160) }));
        });
    });
    await open(page);
    firstSocket.close({ code: 1012, reason: 'Reconnect test' });
    await expect(page.locator('.sync-message')).toHaveCount(160);
    expect(firstAfter).toBe('50');
    expect(cursors).toEqual([100, 150]);
    await expect(page.locator('.sync-message-text').last()).toHaveText('Message 160');
});

test('reports in-flight chunk progress and cancels the active XHR without retrying', async ({ page, isMobile }) => {
    test.skip(isMobile, 'the sync application is a desktop window');
    await prepare(page);
    await page.addInitScript(() => {
        const send = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.send = function (body) {
            send.call(this, body);
            if (body instanceof ArrayBuffer) setTimeout(() => this.upload.dispatchEvent(new ProgressEvent('progress', { loaded: 512, total: body.byteLength, lengthComputable: true })), 200);
        };
    });
    let chunkRequests = 0;
    let release;
    let deletes = 0;
    await page.route('https://sync.test/**', async route => {
        if (route.request().method() === 'OPTIONS') return routeDefault(route);
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith('/uploads')) return route.fulfill({ headers, json: { uploadId: 'test-upload', receivedBytes: 0, chunkSize: 8 * 1024 * 1024 } });
        if (path.includes('/chunks/')) {
            chunkRequests++;
            await new Promise(resolve => { release = resolve; });
            return route.fulfill({ headers, json: { receivedBytes: 1024 } });
        }
        if (route.request().method() === 'DELETE') { deletes++; return route.fulfill({ headers, json: { ok: true } }); }
        return routeDefault(route);
    });
    await page.routeWebSocket('wss://sync.test/**', socket => socket.onMessage(data => {
        if (data === 'ping') return socket.send('pong');
        socket.send(JSON.stringify({ type: 'ready', deviceId, messages: [], pairing: null, history: bounds(null), historyMode: 'replace' }));
    }));
    await open(page);
    await page.locator('[data-sync-file-input]').setInputFiles({ name: 'progress.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(1024) });
    await page.locator('[data-sync-send]').click();
    await expect(page.locator('[data-sync-upload-progress]')).toHaveJSProperty('value', 50);
    await expect(page.locator('[data-sync-upload-status]')).toContainText('/s');
    await page.locator('[data-sync-cancel-upload]').click();
    await expect(page.locator('[data-sync-selected-file]')).toBeHidden();
    release();
    expect(chunkRequests).toBe(1);
    expect(deletes).toBe(1);
});

test('rejects a resumed file with matching metadata but different content', async ({ page, isMobile }) => {
    test.skip(isMobile, 'the sync application is a desktop window');
    await prepare(page);
    const uploads = [];
    let chunks = 0;
    await page.route('https://sync.test/**', route => {
        if (route.request().method() === 'OPTIONS') return routeDefault(route);
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith('/uploads')) {
            uploads.push(route.request().postDataJSON());
            return route.fulfill({ headers, json: { uploadId: 'test-upload', receivedBytes: 0, chunkSize: 8 * 1024 * 1024 } });
        }
        if (path.includes('/chunks/')) { chunks++; return route.fulfill({ status: 400, headers, json: { error: 'upload_expired' } }); }
        return routeDefault(route);
    });
    await page.routeWebSocket('wss://sync.test/**', socket => socket.onMessage(data => {
        if (data === 'ping') return socket.send('pong');
        socket.send(JSON.stringify({ type: 'ready', deviceId, messages: [], pairing: null, history: bounds(null), historyMode: 'replace' }));
    }));
    await open(page);
    const choose = async (contents) => page.locator('[data-sync-file-input]').evaluate((input, contents) => {
        const data = new DataTransfer();
        data.items.add(new File([contents], 'same.txt', { type: 'text/plain', lastModified: 12345 }));
        input.files = data.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }, contents);
    await choose('AAAA');
    await page.locator('[data-sync-send]').click();
    await expect(page.locator('[data-sync-notice]')).toHaveAttribute('data-i18n', 'syncUploadFailed');
    expect(uploads[0].fingerprint).toMatch(/^[0-9a-f]{64}$/);
    await page.reload();
    await expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
    await choose('BBBB');
    await page.locator('[data-sync-send]').click();
    await expect(page.locator('[data-sync-notice]')).toHaveAttribute('data-i18n', 'syncUploadConflict');
    expect(uploads).toHaveLength(1);
    expect(chunks).toBe(1);
    await expect(page.locator('[data-sync-selected-file]')).toBeVisible();
    await expect(page.locator('[data-sync-send]')).toBeEnabled();
    await page.locator('[data-sync-send]').click();
    await expect.poll(() => uploads.length).toBe(2);
    expect(uploads[1].clientId).not.toBe(uploads[0].clientId);
    expect(uploads[1].fingerprint).not.toBe(uploads[0].fingerprint);
});

test('ignores a plaintext legacy draft after enabling encrypted sessions', async ({ page, isMobile }) => {
    test.skip(isMobile, 'the sync application is a desktop window');
    await prepare(page);
    const previousClientId = 'c5a99e5b-639c-42a4-a65d-acf89b5b9493';
    await page.addInitScript(({ roomId, previousClientId }) => sessionStorage.setItem(`portfolio-sync-draft:${roomId}`, JSON.stringify({
        text: '', upload: { clientId: previousClientId, uploadId: 'old-upload', text: '', receivedBytes: 2,
            file: { name: 'same.txt', type: 'text/plain', size: 4, lastModified: 12345 } }
    })), { roomId, previousClientId });
    let uploaded;
    const deleted = [];
    await page.route('https://sync.test/**', route => {
        if (route.request().method() === 'OPTIONS') return routeDefault(route);
        const path = new URL(route.request().url()).pathname;
        if (route.request().method() === 'DELETE') { deleted.push(path); return route.fulfill({ headers, json: { ok: true } }); }
        if (path.endsWith('/uploads')) {
            uploaded = route.request().postDataJSON();
            return route.fulfill({ headers, json: { uploadId: 'new-upload', receivedBytes: 0, chunkSize: 8 * 1024 * 1024 } });
        }
        if (path.includes('/chunks/')) return route.fulfill({ status: 400, headers, json: { error: 'upload_expired' } });
        return routeDefault(route);
    });
    await page.routeWebSocket('wss://sync.test/**', socket => socket.onMessage(data => {
        if (data === 'ping') return socket.send('pong');
        socket.send(JSON.stringify({ type: 'ready', deviceId, messages: [], pairing: null, history: bounds(null), historyMode: 'replace' }));
    }));
    await open(page);
    await page.locator('[data-sync-file-input]').evaluate(input => {
        const data = new DataTransfer();
        data.items.add(new File(['AAAA'], 'same.txt', { type: 'text/plain', lastModified: 12345 }));
        input.files = data.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.locator('[data-sync-send]').click();
    await expect.poll(() => uploaded?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(uploaded.clientId).not.toBe(previousClientId);
    expect(deleted).toEqual([]);
});
