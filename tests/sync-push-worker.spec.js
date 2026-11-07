const { test, expect } = require('@playwright/test');
const { readFile } = require('node:fs/promises');
const { webcrypto } = require('node:crypto');
const vm = require('node:vm');

const roomId = '11111111-1111-4111-8111-111111111111';
const installWorker = async () => {
    const handlers = new Map();
    const notifications = [];
    const opened = [];
    const focused = [];
    const posted = [];
    const clients = [];
    const cacheEntries = new Map();
    const worker = {
        location: new URL('https://example.test/sync-e2ee-worker.js'),
        registration: {
            scope: 'https://example.test/',
            showNotification: async (title, options) => notifications.push({ title, ...options })
        },
        clients: {
            matchAll: async () => clients,
            get: async id => clients.find(client => client.id === id),
            openWindow: async url => opened.push(url)
        },
        addEventListener(name, handler) { handlers.set(name, [...(handlers.get(name) || []), handler]); }
    };
    vm.runInNewContext(await readFile('static/portfolio/sync-e2ee-worker.js', 'utf8'), {
        self: worker, URL, URLSearchParams, Map, Set, Date, Response, crypto: webcrypto,
        caches: { open: async () => ({ match: async key => cacheEntries.get(key)?.clone(), put: async (key, response) => cacheEntries.set(key, response) }) }
    });
    const push = async payload => {
        const waits = [];
        handlers.get('push')[0]({ data: payload === undefined ? null : { json: () => JSON.parse(payload) }, waitUntil: promise => waits.push(promise) });
        await Promise.all(waits);
    };
    const click = async notification => {
        let closed = false;
        let pending;
        handlers.get('notificationclick')[0]({ notification: { ...notification, close() { closed = true; } }, waitUntil: promise => { pending = promise; } });
        await pending;
        expect(closed).toBe(true);
    };
    const addClient = (id, url, active = false) => {
        clients.push({ id, url, type: 'window', focused: active, visibilityState: 'visible',
            focus: async () => focused.push(id), postMessage: data => posted.push({ id, data }) });
    };
    return { push, click, addClient, clients, notifications, opened, focused, posted, cacheEntries, worker };
};

test('push always displays a fixed, private notification in either language, including with a foreground app', async () => {
    const worker = await installWorker();
    worker.addClient('foreground', 'https://example.test/chat/', true);
    await worker.push(JSON.stringify({ roomId, messageId: 1, language: 'zh-CN' }));
    await worker.push(JSON.stringify({ roomId, messageId: 2, language: 'en' }));
    expect(worker.notifications.map(item => [item.title, item.body])).toEqual([
        ['联络站', '有新消息'], ['Contact Hub', 'You have a new message']
    ]);
    expect(worker.notifications[0].tag).toBe(`sync:${roomId}`);
    expect(worker.notifications[1].tag).toBe(worker.notifications[0].tag);
    expect(worker.notifications[0].icon).toBe('https://example.test/portfolio/assets/sync-icon-192.png');
    expect(worker.notifications[0].data).toEqual({ roomId });
    expect(worker.notifications[0].silent).toBeUndefined();
});

test('empty, malformed and untrusted push fields only produce a generic notification', async () => {
    const worker = await installWorker();
    const invalid = [undefined, '{', 'null', '[]',
        JSON.stringify({ roomId: 'https://evil.test/', messageId: 1, language: 'en' }),
        JSON.stringify({ roomId, messageId: 0, language: 'en' }),
        JSON.stringify({ roomId, messageId: 1, language: 'invalid' }),
        JSON.stringify({ roomId, messageId: 1, language: 'en', body: 'private message', token: 'secret-key' })];
    for (const payload of invalid) await worker.push(payload);
    expect(worker.notifications).toHaveLength(invalid.length);
    for (const notification of worker.notifications) {
        expect(notification.title).toBe('联络站');
        expect(notification.body).toBe('有新消息');
        expect(notification.data).toEqual({});
    }
    await worker.click(worker.notifications.at(-1));
    expect(worker.opened).toEqual(['https://example.test/chat/']);
    expect(JSON.stringify(worker.notifications)).not.toContain('private message');
    expect(JSON.stringify(worker.notifications)).not.toContain('secret-key');
});

test('push clicks prefer a trusted chat app, reuse the desktop, or open the original room', async () => {
    const worker = await installWorker();
    worker.addClient('foreign', 'https://evil.test/chat/');
    worker.addClient('home', 'https://example.test/');
    worker.addClient('desktop', 'https://example.test/portfolio/');
    worker.addClient('chat', 'https://example.test/chat/');
    await worker.push(JSON.stringify({ roomId, messageId: 1, language: 'en' }));
    const notification = worker.notifications[0];
    await worker.click(notification);
    expect(worker.focused).toEqual(['chat']);
    expect(worker.posted.filter(item => item.data.source === 'gavin-sync-notification')).toEqual([{ id: 'chat', data: { source: 'gavin-sync-notification', roomId } }]);
    worker.clients.pop();
    await worker.click(notification);
    expect(worker.focused).toEqual(['chat', 'desktop']);
    worker.clients.pop();
    await worker.click(notification);
    expect(worker.opened).toEqual([`https://example.test/chat/#space=${roomId}`]);
});

test('the chat installation manifest opens the hub with its own identity and app icons', async () => {
    const html = await readFile('static/chat/index.html', 'utf8');
    expect(html).toContain('rel="manifest" href="manifest.webmanifest"');
    expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"');
    expect(html).toContain('rel="apple-touch-icon" sizes="180x180" href="../portfolio/assets/sync-app-icon-180.png"');
    const appleIcon = await readFile('static/portfolio/assets/sync-app-icon-180.png');
    expect([appleIcon.readUInt32BE(16), appleIcon.readUInt32BE(20)]).toEqual([180, 180]);
    expect(appleIcon[25]).toBe(2);
    const manifest = JSON.parse(await readFile('static/chat/manifest.webmanifest', 'utf8'));
    expect(manifest.id).toBe('/chat/');
    expect(manifest.start_url).toBe('/chat/');
    expect(manifest.scope).toBe('/chat/');
    expect(manifest.display).toBe('standalone');
    for (const icon of manifest.icons) {
        expect(icon.purpose).toBe('any maskable');
        expect(icon.src).toContain('/sync-app-icon-');
        const data = await readFile(new URL(icon.src, new URL('../static/chat/manifest.webmanifest', `file://${__filename}`)));
        expect(`${data.readUInt32BE(16)}x${data.readUInt32BE(20)}`).toBe(icon.sizes);
        expect(data[25]).toBe(2);
    }
});


test('push diagnostics persist only timing and results and report showNotification failures', async () => {
    const worker = await installWorker();
    await worker.push(JSON.stringify({ roomId, messageId: 1, language: 'en' }));
    worker.worker.registration.showNotification = async () => { throw new Error('denied'); };
    await worker.push(JSON.stringify({ roomId, messageId: 2, language: 'en' }));
    const entries = await worker.cacheEntries.get('https://example.test/__sync-push-diagnostics__').clone().json();
    expect(entries.map(entry => entry.status)).toEqual(['shown', 'error']);
    for (const entry of entries) {
        expect(entry.source).toBe('push');
        expect(entry.submittedAt).toBeGreaterThanOrEqual(entry.at);
        expect(entry.completedAt).toBeGreaterThanOrEqual(entry.submittedAt);
        expect(entry.totalMs).toBeGreaterThanOrEqual(0);
    }
    expect(JSON.stringify(entries)).not.toContain(roomId);
    expect(JSON.stringify(entries)).not.toContain('messageId');
});
