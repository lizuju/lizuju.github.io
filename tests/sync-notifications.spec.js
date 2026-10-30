const { test, expect } = require('@playwright/test');
const { readFile } = require('node:fs/promises');
const vm = require('node:vm');

const install = async page => {
    await page.route('**/__notification-test__/', route => route.fulfill({ contentType: 'text/html', body: '<button id="toggle"></button>' }));
    await page.route('**/__notification-test__/sync-notifications.js', async route => route.fulfill({ contentType: 'text/javascript', body: await readFile('static/portfolio/js/apps/sync-notifications.js', 'utf8') }));
    await page.route('**/__notification-test__/sync-e2ee-files.js', route => route.fulfill({ contentType: 'text/javascript', body: `export async function prepareEncryptedFiles() { return { postMessage(data, ports) { window.delivered.push(data); ports[0].postMessage(true); } }; }` }));
    await page.goto('/__notification-test__/');
    await page.evaluate(async () => {
        window.delivered = [];
        window.permissionRequests = 0;
        window.errors = [];
        window.Notification = { permission: 'default', requestPermission: async () => { permissionRequests++; return Notification.permission = 'granted'; } };
        const { createSystemNotifications } = await import('./sync-notifications.js');
        window.notifications = createSystemNotifications({ button: document.querySelector('#toggle'), translate: key => key === 'syncNotificationMessage' ? '有新消息' : key, onError: key => errors.push(key), onOpen() {} });
    });
};

test('asks permission on opt-in, hides contents, deduplicates background notifications and respects opt-out', async ({ page }) => {
    await install(page);
    expect(await page.evaluate(() => permissionRequests)).toBe(0);
    await page.locator('#toggle').click();
    await expect(page.locator('#toggle')).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => permissionRequests)).toBe(1);
    await page.evaluate(async () => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        const message = { id: 1, text: 'private plaintext', attachment: { key: 'private-key' } };
        const session = { roomId: 'room', deviceId: 'device', token: 'private-token' };
        await Promise.all([notifications.show(message, session), notifications.show(message, session)]);
    });
    const delivered = await page.evaluate(() => delivered);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].body).toBe('有新消息');
    expect(JSON.stringify(delivered)).not.toContain('private');
    await page.locator('#toggle').click();
    await page.evaluate(() => notifications.show({ id: 2 }, { roomId: 'room', deviceId: 'device' }));
    expect(await page.evaluate(() => delivered.length)).toBe(1);
});

test('denied permission remains off and a foreground tab does not notify', async ({ page }) => {
    await install(page);
    await page.evaluate(() => { Notification.requestPermission = async () => Notification.permission = 'denied'; });
    await page.locator('#toggle').click();
    await expect(page.locator('#toggle')).toHaveAttribute('aria-pressed', 'false');
    expect(await page.evaluate(() => errors)).toEqual(['syncNotificationsDenied']);
    await page.evaluate(async () => {
        Notification.permission = 'granted';
        localStorage.setItem('portfolio-sync-system-notifications', 'on');
        Object.defineProperty(document, 'hidden', { configurable: true, value: false });
        document.hasFocus = () => true;
        await notifications.show({ id: 1 }, { roomId: 'room', deviceId: 'device' });
    });
    expect(await page.evaluate(() => delivered.length)).toBe(0);
});

test('the service worker suppresses notifications when another tab is focused and opens the original room on click', async () => {
    const handlers = new Map();
    const shown = [];
    const posted = [];
    let focused = true;
    let activated = false;
    const client = { id: 'client', type: 'window', url: 'https://example.test/chat/', focus: async () => { activated = true; }, postMessage: value => posted.push(value) };
    const worker = { location: new URL('https://example.test/chat/sync-e2ee-worker.js'),
        registration: { scope: 'https://example.test/chat/', showNotification: async (title, options) => shown.push({ title, ...options }) },
        clients: { matchAll: async () => [{ focused, visibilityState: 'visible' }], get: async () => client },
        addEventListener(name, handler) { handlers.set(name, [...(handlers.get(name) || []), handler]); }
    };
    vm.runInNewContext(await readFile('static/portfolio/sync-e2ee-worker.js', 'utf8'), { self: worker, URL, Map, Set, Date });
    const deliver = async () => {
        const waits = [];
        for (const handler of handlers.get('message')) handler({ source: client, data: { source: 'gavin-sync-notification', type: 'show', roomId: 'room', title: '联络站', body: '有新消息' }, ports: [{ postMessage() {} }], waitUntil: promise => waits.push(promise) });
        await Promise.all(waits);
    };
    await deliver();
    expect(shown).toHaveLength(0);
    focused = false;
    await deliver();
    expect(shown).toHaveLength(1);
    expect(shown[0].body).toBe('有新消息');
    let clicked;
    handlers.get('notificationclick')[0]({ notification: { data: shown[0].data, close() {} }, waitUntil: promise => { clicked = promise; } });
    await clicked;
    expect(activated).toBe(true);
    expect(posted).toEqual([{ source: 'gavin-sync-notification', roomId: 'room' }]);
});
