const { test } = require('node:test');
const assert = require('node:assert/strict');
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
            showNotification: async (title, options) => notifications.push(structuredClone({ title, ...options }))
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
        assert.equal(closed, true);
    };
    const addClient = (id, url, active = false) => {
        clients.push({ id, url, type: 'window', focused: active, visibilityState: 'visible',
            focus: async () => focused.push(id), postMessage: data => posted.push(structuredClone({ id, data })) });
    };
    return { push, click, addClient, clients, notifications, opened, focused, posted, cacheEntries, worker };
};

test('push always displays a fixed, private notification in either language, including with a foreground app', async () => {
    const worker = await installWorker();
    worker.addClient('foreground', 'https://example.test/chat/', true);
    await worker.push(JSON.stringify({ roomId, messageId: 1, language: 'zh-CN' }));
    await worker.push(JSON.stringify({ roomId, messageId: 2, language: 'en' }));
    assert.deepEqual(worker.notifications.map(item => [item.title, item.body]), [
        ['联络站', '有新消息'], ['Contact Hub', 'You have a new message']
    ]);
    assert.equal(worker.notifications[0].tag, `sync:${roomId}`);
    assert.equal(worker.notifications[1].tag, worker.notifications[0].tag);
    assert.equal(worker.notifications[0].icon, 'https://example.test/portfolio/assets/sync-icon-192.png');
    assert.deepEqual(worker.notifications[0].data, { roomId });
    assert.equal(worker.notifications[0].silent, undefined);
});

test('empty, malformed and untrusted push fields only produce a generic notification', async () => {
    const worker = await installWorker();
    const invalid = [undefined, '{', 'null', '[]',
        JSON.stringify({ roomId: 'https://evil.test/', messageId: 1, language: 'en' }),
        JSON.stringify({ roomId, messageId: 0, language: 'en' }),
        JSON.stringify({ roomId, messageId: 1, language: 'invalid' }),
        JSON.stringify({ roomId, messageId: 1, language: 'en', body: 'private message', token: 'secret-key' })];
    for (const payload of invalid) await worker.push(payload);
    assert.equal((worker.notifications).length, invalid.length);
    for (const notification of worker.notifications) {
        assert.equal(notification.title, '联络站');
        assert.equal(notification.body, '有新消息');
        assert.deepEqual(notification.data, {});
    }
    await worker.click(worker.notifications.at(-1));
    assert.deepEqual(worker.opened, ['https://example.test/chat/']);
    assert.ok(!(JSON.stringify(worker.notifications)).includes('private message'));
    assert.ok(!(JSON.stringify(worker.notifications)).includes('secret-key'));
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
    assert.deepEqual(worker.focused, ['chat']);
    assert.deepEqual(worker.posted.filter(item => item.data.source === 'gavin-sync-notification'), [{ id: 'chat', data: { source: 'gavin-sync-notification', roomId } }]);
    worker.clients.pop();
    await worker.click(notification);
    assert.deepEqual(worker.focused, ['chat', 'desktop']);
    worker.clients.pop();
    await worker.click(notification);
    assert.deepEqual(worker.opened, [`https://example.test/chat/#space=${roomId}`]);
});

test('the chat installation manifest opens the hub with its own identity and app icons', async () => {
    const html = await readFile('static/chat/index.html', 'utf8');
    assert.ok((html).includes('rel="manifest" href="manifest.webmanifest"'));
    assert.ok((html).includes('name="apple-mobile-web-app-capable" content="yes"'));
    assert.ok((html).includes('rel="apple-touch-icon" sizes="180x180" href="../portfolio/assets/sync-app-icon-180.png"'));
    const appleIcon = await readFile('static/portfolio/assets/sync-app-icon-180.png');
    assert.deepEqual([appleIcon.readUInt32BE(16), appleIcon.readUInt32BE(20)], [180, 180]);
    assert.equal(appleIcon[25], 2);
    const manifest = JSON.parse(await readFile('static/chat/manifest.webmanifest', 'utf8'));
    assert.equal(manifest.id, '/chat/');
    assert.equal(manifest.start_url, '/chat/');
    assert.equal(manifest.scope, '/chat/');
    assert.equal(manifest.display, 'standalone');
    for (const icon of manifest.icons) {
        assert.equal(icon.purpose, 'any maskable');
        assert.ok((icon.src).includes('/sync-app-icon-'));
        const data = await readFile(new URL(icon.src, new URL('../../static/chat/manifest.webmanifest', `file://${__filename}`)));
        assert.equal(`${data.readUInt32BE(16)}x${data.readUInt32BE(20)}`, icon.sizes);
        assert.equal(data[25], 2);
    }
});


test('push diagnostics persist only timing and results and report showNotification failures', async () => {
    const worker = await installWorker();
    await worker.push(JSON.stringify({ roomId, messageId: 1, language: 'en' }));
    worker.worker.registration.showNotification = async () => { throw new Error('denied'); };
    await worker.push(JSON.stringify({ roomId, messageId: 2, language: 'en' }));
    const entries = await worker.cacheEntries.get('https://example.test/__sync-push-diagnostics__').clone().json();
    assert.deepEqual(entries.map(entry => entry.status), ['shown', 'error']);
    for (const entry of entries) {
        assert.equal(entry.source, 'push');
        assert.ok(entry.submittedAt >= entry.at);
        assert.ok(entry.completedAt >= entry.submittedAt);
        assert.ok(entry.totalMs >= 0);
    }
    assert.ok(!(JSON.stringify(entries)).includes(roomId));
    assert.ok(!(JSON.stringify(entries)).includes('messageId'));
});
