const { test, expect } = require('@playwright/test');
const { readFile } = require('node:fs/promises');

const install = async (page, { iphone = false } = {}) => {
    await page.route('**/__push-test__/', route => route.fulfill({ contentType: 'text/html', body: '<button id="toggle"></button><details id="guide"><summary>Install</summary><p data-sync-install-copy></p><button id="install">Install app</button></details>' }));
    for (const name of ['sync-push', 'sync-notifications']) {
        await page.route(`**/__push-test__/${name}.js`, async route => route.fulfill({ contentType: 'text/javascript', body: await readFile(`static/portfolio/js/apps/${name}.js`, 'utf8') }));
    }
    await page.route('**/__push-test__/sync-e2ee-files.js', route => route.fulfill({ contentType: 'text/javascript', body: 'export async function prepareEncryptedFiles() { window.steps.push("worker"); return window.testWorker; }' }));
    await page.goto('/__push-test__/');
    await page.evaluate(async iphone => {
        localStorage.clear();
        sessionStorage.clear();
        window.steps = [];
        window.errors = [];
        window.delivered = [];
        window.apiCalls = [];
        window.language = 'zh-CN';
        window.sessions = [
            { roomId: '11111111-1111-4111-8111-111111111111', deviceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', token: 'token-a' },
            { roomId: '22222222-2222-4222-8222-222222222222', deviceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', token: 'token-b' }
        ];
        window.permissionRequests = 0;
        window.subscribeCalls = [];
        window.unsubscribeCalls = 0;
        window.currentSubscription = null;
        window.failPath = '';
        window.failureStatus = 503;
        window.publicKey = btoa(String.fromCharCode(4, ...new Uint8Array(64))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        Object.defineProperty(navigator, 'standalone', { configurable: true, value: !iphone });
        Object.defineProperty(window, 'PushManager', { configurable: true, value: function PushManager() {} });
        Object.defineProperty(window, 'Notification', { configurable: true, value: {
            permission: 'default',
            requestPermission: async () => { permissionRequests++; steps.push('permission'); return Notification.permission = 'granted'; }
        } });
        if (iphone) {
            delete window.Notification;
            Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' });
            Object.defineProperty(navigator, 'standalone', { configurable: true, value: false });
        }
        window.registration = {
            pushManager: {
                getSubscription: async () => currentSubscription,
                subscribe: async options => {
                    steps.push('subscribe');
                    subscribeCalls.push({ userVisibleOnly: options.userVisibleOnly, key: Array.from(options.applicationServerKey) });
                    const subscription = {
                        endpoint: `https://web.push.apple.com/test-${subscribeCalls.length}`,
                        options: {},
                        toJSON() { return { endpoint: this.endpoint, expirationTime: null, keys: { p256dh: 'test-public', auth: 'test-auth' } }; },
                        async unsubscribe() { unsubscribeCalls++; currentSubscription = null; return true; }
                    };
                    return currentSubscription = subscription;
                }
            }
        };
        window.testWorker = { postMessage(data, ports) { delivered.push(data); ports[0].postMessage({ status: 'shown', workerMs: 1 }); } };
        Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {
            controller: testWorker, getRegistration: async () => registration, addEventListener() {}
        } });
        window.api = async (path, options = {}, session) => {
            apiCalls.push({ path, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null, session });
            steps.push(options.method || 'GET');
            if (path === failPath) throw Object.assign(new Error('test_failure'), { status: failureStatus });
            return path === '/v1/push/key' ? { publicKey } : { ok: true };
        };
        const { createWebPush } = await import('./sync-push.js');
        const { createSystemNotifications } = await import('./sync-notifications.js');
        window.push = createWebPush({ api, getSessions: () => sessions, getLanguage: () => language });
        window.notifications = createSystemNotifications({
            button: document.querySelector('#toggle'), translate: key => key,
            onError: key => errors.push(key), onOpen() {}, push,
            installGuide: document.querySelector('#guide'), installButton: document.querySelector('#install')
        });
    }, iphone);
};

test('opt-in asks permission first, registers each room with its own credentials and avoids duplicate writes', async ({ page }) => {
    await install(page);
    expect(await page.evaluate(() => apiCalls)).toEqual([]);
    expect(await page.evaluate(() => permissionRequests)).toBe(0);
    await page.locator('#toggle').click();
    await expect(page.locator('#toggle')).toHaveAttribute('aria-pressed', 'true');
    const result = await page.evaluate(() => ({ steps, apiCalls, subscribeCalls, registered: sessions.map(session => push.usesPush(session)) }));
    expect(result.steps[0]).toBe('permission');
    expect(result.subscribeCalls).toHaveLength(1);
    expect(result.subscribeCalls[0].userVisibleOnly).toBe(true);
    expect(result.subscribeCalls[0].key).toHaveLength(65);
    expect(result.apiCalls[0]).toMatchObject({ path: '/v1/push/key', session: null });
    const writes = result.apiCalls.filter(call => call.method === 'PUT');
    expect(writes).toHaveLength(2);
    expect(writes.map(call => [call.path, call.session.token])).toEqual([
        ['/v1/spaces/11111111-1111-4111-8111-111111111111/push-subscription', 'token-a'],
        ['/v1/spaces/22222222-2222-4222-8222-222222222222/push-subscription', 'token-b']
    ]);
    expect(writes.every(call => call.body.language === 'zh-CN')).toBe(true);
    expect(result.registered).toEqual([true, true]);
    await page.evaluate(() => Promise.all([push.sync(), push.sync()]));
    expect(await page.evaluate(() => apiCalls.filter(call => call.method === 'PUT').length)).toBe(2);
    await page.evaluate(async () => { language = 'en'; await push.sync(); });
    expect(await page.evaluate(() => apiCalls.filter(call => call.method === 'PUT').slice(-2).map(call => call.body.language))).toEqual(['en', 'en']);
    expect(await page.evaluate(() => subscribeCalls.length)).toBe(1);
});

test('registered push prevents duplicate local notifications and opt-out unsubscribes and deletes room registrations', async ({ page }) => {
    await install(page);
    await page.locator('#toggle').click();
    await expect(page.locator('#toggle')).toHaveAttribute('aria-pressed', 'true');
    await page.evaluate(async () => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        await notifications.show({ id: 1, text: 'private message' }, sessions[0]);
    });
    expect(await page.evaluate(() => delivered)).toEqual([]);
    await page.evaluate(() => { failPath = `/v1/spaces/${sessions[0].roomId}/push-subscription`; });
    await page.locator('#toggle').click();
    await expect(page.locator('#toggle')).toHaveAttribute('aria-pressed', 'false');
    expect(await page.evaluate(() => unsubscribeCalls)).toBe(1);
    expect(await page.evaluate(() => sessions.map(session => push.usesPush(session)))).toEqual([false, false]);
    const removed = await page.evaluate(() => apiCalls.filter(call => call.method === 'DELETE'));
    expect(removed.map(call => call.session.token)).toEqual(['token-a', 'token-b']);
    expect(await page.evaluate(() => errors)).toEqual([]);
    await page.evaluate(() => push.sync());
    expect(await page.evaluate(() => subscribeCalls.length)).toBe(1);
});

test('a partial room registration failure rolls back the browser subscription and keeps notifications off', async ({ page }) => {
    await install(page);
    await page.evaluate(() => { failPath = `/v1/spaces/${sessions[1].roomId}/push-subscription`; });
    await page.locator('#toggle').click();
    await expect.poll(() => page.evaluate(() => errors)).toEqual(['syncPushUnavailable']);
    await expect(page.locator('#toggle')).toHaveAttribute('aria-pressed', 'false');
    expect(await page.evaluate(() => unsubscribeCalls)).toBe(1);
    expect(await page.evaluate(() => sessions.map(session => push.usesPush(session)))).toEqual([false, false]);
    expect(await page.evaluate(() => localStorage.getItem('portfolio-sync-system-notifications'))).not.toBe('on');
    await page.evaluate(() => { failPath = ''; });
    await page.locator('#toggle').click();
    await expect(page.locator('#toggle')).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => subscribeCalls.length)).toBe(2);
});

test('opt-out publishes its preference before another tab can resume a queued push sync', async ({ page }) => {
    await install(page);
    await page.locator('#toggle').click();
    await expect(page.locator('#toggle')).toHaveAttribute('aria-pressed', 'true');
    const result = await page.evaluate(async () => {
        const { createWebPush } = await import('./sync-push.js');
        const otherTab = createWebPush({ api, getSessions: () => sessions, getLanguage: () => language });
        let releaseUnsubscribe;
        let reachedUnsubscribe;
        const held = new Promise(resolve => { releaseUnsubscribe = resolve; });
        const started = new Promise(resolve => { reachedUnsubscribe = resolve; });
        const originalUnsubscribe = currentSubscription.unsubscribe.bind(currentSubscription);
        currentSubscription.unsubscribe = async () => {
            reachedUnsubscribe();
            await held;
            return originalUnsubscribe();
        };
        const disable = push.disable();
        await started;
        const pendingSync = otherTab.sync();
        releaseUnsubscribe();
        await Promise.all([disable, pendingSync]);
        return {
            preference: localStorage.getItem('portfolio-sync-system-notifications'),
            subscribed: currentSubscription !== null,
            subscribes: subscribeCalls.length,
            writes: apiCalls.filter(call => call.method === 'PUT').length,
            removed: apiCalls.filter(call => call.method === 'DELETE').length
        };
    });
    expect(result).toEqual({ preference: 'off', subscribed: false, subscribes: 1, writes: 2, removed: 2 });
});

test('an unavailable push service does not enable notifications or create a browser subscription', async ({ page }) => {
    await install(page);
    await page.evaluate(() => { failPath = '/v1/push/key'; });
    await page.locator('#toggle').click();
    await expect.poll(() => page.evaluate(() => errors)).toEqual(['syncPushUnavailable']);
    await expect(page.locator('#toggle')).toHaveAttribute('aria-pressed', 'false');
    expect(await page.evaluate(() => subscribeCalls)).toEqual([]);
    expect(await page.evaluate(() => localStorage.getItem('portfolio-sync-system-notifications'))).not.toBe('on');
});

test('a stored subscription with a different VAPID key length is replaced before room registration', async ({ page }) => {
    await install(page);
    await page.evaluate(() => {
        currentSubscription = {
            endpoint: 'https://web.push.apple.com/old-key',
            options: { applicationServerKey: new Uint8Array([4]).buffer },
            toJSON() { return { endpoint: this.endpoint }; },
            async unsubscribe() { unsubscribeCalls++; currentSubscription = null; return true; }
        };
    });
    await page.locator('#toggle').click();
    await expect(page.locator('#toggle')).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => unsubscribeCalls)).toBe(1);
    expect(await page.evaluate(() => subscribeCalls.length)).toBe(1);
    expect(await page.evaluate(() => apiCalls.filter(call => call.method === 'PUT').map(call => call.body.subscription.endpoint)))
        .toEqual(['https://web.push.apple.com/test-1', 'https://web.push.apple.com/test-1']);
});

test('new spaces register independently and revoked spaces do not suppress local notification delivery', async ({ page }) => {
    await install(page);
    await page.locator('#toggle').click();
    await expect(page.locator('#toggle')).toHaveAttribute('aria-pressed', 'true');
    await page.evaluate(async () => {
        sessions.push({ roomId: '33333333-3333-4333-8333-333333333333', deviceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', token: 'token-c' });
        failPath = `/v1/spaces/${sessions[2].roomId}/push-subscription`;
        failureStatus = 401;
        await push.sync();
    });
    expect(await page.evaluate(() => apiCalls.filter(call => call.method === 'PUT').length)).toBe(3);
    expect(await page.evaluate(() => sessions.map(session => push.usesPush(session)))).toEqual([true, true, false]);
    await page.evaluate(async () => { failPath = ''; await push.sync(); });
    expect(await page.evaluate(() => sessions.map(session => push.usesPush(session)))).toEqual([true, true, true]);
    expect(await page.evaluate(() => apiCalls.filter(call => call.method === 'PUT').length)).toBe(4);
});

test('regular iPhone Safari opens the sidebar installation steps without requesting unsupported notification permission', async ({ page }) => {
    await install(page, { iphone: true });
    await expect(page.locator('#toggle')).toBeEnabled();
    await expect(page.locator('#toggle')).toHaveText('syncNotificationsInstallRequired');
    await expect(page.locator('#guide')).toBeVisible();
    expect(await page.locator('#guide').evaluate(element => element.open)).toBe(false);
    await page.locator('#toggle').click();
    expect(await page.locator('#guide').evaluate(element => element.open)).toBe(true);
    await expect(page.locator('[data-sync-install-copy]')).toHaveText('syncInstallIphone');
    expect(await page.evaluate(() => permissionRequests)).toBe(0);
    expect(await page.evaluate(() => apiCalls)).toEqual([]);
    expect(await page.evaluate(() => errors)).toEqual([]);
});
