const { test, expect, roomId, deviceId, otherId, keyId, message, authorize, allowSyncOrigin } = require('./fixtures/sync-e2ee.cjs');
const { showSyncTools, hideSyncTools } = require('./fixtures/sync-tools.cjs');

test.use({ serviceWorkers: 'block' });

const preference = 'portfolio-sync-notification-sound';
const headers = {
    'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Sync-Key-Id',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};
const bounds = latestId => ({ generation: '1', oldestId: 1, latestId, continuationId: latestId, hasNewer: false });
const settleNotifications = page => page.evaluate(({ roomId, deviceId }) => navigator.locks.request(
    `portfolio-sync-notification:${roomId}:${deviceId}`, () => {}
), { roomId, deviceId });

const servers = new WeakMap();
const openChat = async (page, initial = [], authorizeSession = true) => {
    if (!servers.has(page.context())) servers.set(page.context(), { history: initial, sockets: 0 });
    const server = servers.get(page.context());
    if (!authorizeSession) await allowSyncOrigin(page, 'https://sync.test');
    await page.addInitScript(() => {
        window.__syncAudioStats = { attempts: 0, starts: 0, pauses: 0, playing: false };
        window.__syncAudioBlocked = false;
        class NotificationAudio extends EventTarget {
            constructor(src) { super(); this.src = src; this.currentTime = 0; this.muted = false; }
            async play() {
                if (!this.muted) window.__syncAudioStats.attempts++;
                if (window.__syncAudioBlocked) throw new DOMException('Autoplay blocked', 'NotAllowedError');
                window.__syncAudioStats.playing = true;
                if (!this.muted) {
                    window.__syncAudioStats.starts++;
                    setTimeout(() => {
                        window.__syncAudioStats.playing = false;
                        this.dispatchEvent(new Event('ended'));
                    }, 200);
                }
            }
            pause() { window.__syncAudioStats.pauses++; window.__syncAudioStats.playing = false; }
        }
        window.Audio = NotificationAudio;
    });
    await page.clock.install({ time: new Date('2026-10-25T00:00:00Z') });
    await page.clock.pauseAt(new Date('2026-10-25T00:00:01Z'));
    if (authorizeSession) await authorize(page);
    await page.route('**/portfolio/sync-config.json', route => route.fulfill({ json: { apiBase: 'https://sync.test' } }));
    await page.route('https://sync.test/**', route => route.request().method() === 'OPTIONS'
        ? route.fulfill({ status: 204, headers })
        : route.fulfill({ headers, json: { deviceId, devices: [], grants: [], hasMore: false, keyId } }));
    await page.routeWebSocket('wss://sync.test/**', socket => {
        server.connection = socket;
        server.owner = page;
        server.sockets++;
        socket.onMessage(raw => {
            if (raw === 'ping') return socket.send('pong');
            if (JSON.parse(raw).type === 'auth') socket.send(JSON.stringify({
                type: 'ready', deviceId, messages: server.history, pairing: null, readReceipts: [],
                history: bounds(server.history.at(-1)?.id ?? null), historyMode: 'replace'
            }));
        });
    });
    const open = async () => {
        await page.goto('/portfolio/');
        await page.bringToFront();
        if (await page.locator('[data-window-action="minimize"]').isVisible()) await page.locator('[data-window-action="minimize"]').click();
        if (!await page.locator('[data-sync-window]').isVisible()) await page.locator('.desktop-shortcut[data-open-sync-space]').click();
        await expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
        await hideSyncTools(page);
        await page.locator('[data-sync-input]').click();
    };
    await open();
    return {
        open,
        send: async (id, sender = otherId) => {
            const item = message(id, `Notification message ${id}`, sender);
            if (!server.history.some(message => message.id === id)) server.history.push(item);
            await expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
            server.connection.send(JSON.stringify({ type: 'message', message: item, history: bounds(id) }));
            await expect(page.locator('.sync-message-text').filter({ hasText: `Notification message ${id}` })).toHaveCount(1);
            await settleNotifications(page);
            return item;
        },
        frame: data => server.connection.send(JSON.stringify(data)),
        sockets: () => server.sockets,
        ownsSocket: () => server.owner === page,
        stats: () => page.evaluate(() => window.__syncAudioStats)
    };
};

test('places an accessible sound switch before pairing and remembers mute across reloads and languages', async ({ page }) => {
    const chat = await openChat(page);
    await showSyncTools(page);
    const sound = page.locator('[data-sync-sound]');
    await expect(sound).toHaveAttribute('aria-pressed', 'true');
    await expect(sound.locator('img')).toHaveAttribute('alt', '');
    const position = await page.evaluate(() => {
        const sound = document.querySelector('[data-sync-sound]').getBoundingClientRect();
        const pairing = document.querySelector('[data-sync-pair]').getBoundingClientRect();
        return { fits: sound.left >= 0 && sound.right <= window.innerWidth, before: sound.bottom <= pairing.top + 1, compact: sound.width <= 32 };
    });
    expect(position).toEqual({ fits: true, before: true, compact: true });
    const enabledTitle = await sound.getAttribute('title');
    await expect(sound).toHaveAttribute('aria-label', enabledTitle);
    await sound.click();
    await expect(sound).toHaveAttribute('aria-pressed', 'false');
    await expect(sound.locator('img')).toHaveAttribute('src', /volume_off\.svg$/);
    const mutedTitle = await sound.getAttribute('title');
    expect(mutedTitle).not.toBe(enabledTitle);
    expect(await page.evaluate(key => localStorage.getItem(key), preference)).toBe('off');
    await page.locator('[data-taskbar-lang]').click();
    expect(await sound.getAttribute('title')).not.toBe(mutedTitle);
    await expect(sound).toHaveAttribute('aria-pressed', 'false');
    await chat.open();
    await expect(sound).toHaveAttribute('aria-pressed', 'false');
    await showSyncTools(page);
    await sound.focus();
    await sound.press('Space');
    await expect(sound).toHaveAttribute('aria-pressed', 'true');
    await expect(sound.locator('img')).toHaveAttribute('src', /volume_on\.svg$/);
    expect(await page.evaluate(key => localStorage.getItem(key), preference)).toBe('on');
});

test('sounds only for unique live messages from another device and finishes playback afterward', async ({ page }) => {
    const chat = await openChat(page, [message(1, 'Existing history', otherId)]);
    await page.locator('[data-sync-input]').click();
    await page.clock.runFor(1000);
    expect((await chat.stats()).starts).toBe(0);
    const incoming = await chat.send(2);
    await page.clock.runFor(1000);
    expect((await chat.stats()).starts).toBe(1);
    expect((await chat.stats()).playing).toBe(false);
    chat.frame({ type: 'message', message: incoming, history: bounds(2) });
    await chat.send(3, deviceId);
    chat.frame({ type: 'read', deviceId: otherId, messageId: 3 });
    chat.frame({ type: 'history', messages: [message(4, 'Backfilled history', otherId)], historyMode: 'append', history: bounds(4), readReceipts: [] });
    await expect(page.locator('.sync-message-text')).toHaveCount(4);
    await page.clock.runFor(1000);
    expect((await chat.stats()).starts).toBe(1);
    await page.locator('[data-sync-action="minimize"]').click();
    await chat.send(5);
    await page.clock.runFor(1000);
    expect((await chat.stats()).starts).toBe(2);
    expect((await chat.stats()).playing).toBe(false);
});

test('mutes notifications immediately and throttles a burst without suppressing later messages', async ({ page }) => {
    const chat = await openChat(page);
    await page.locator('[data-sync-input]').click();
    await chat.send(1);
    await chat.send(2);
    await chat.send(3);
    await page.clock.runFor(100);
    expect((await chat.stats()).starts).toBe(1);
    await page.clock.runFor(800);
    await chat.send(4);
    await page.clock.runFor(100);
    expect((await chat.stats()).starts).toBe(2);
    await showSyncTools(page);
    await page.locator('[data-sync-sound]').click();
    await page.clock.runFor(1000);
    await chat.send(5);
    await page.clock.runFor(1000);
    expect((await chat.stats()).starts).toBe(2);
    await showSyncTools(page);
    await page.locator('[data-sync-sound]').click();
    await chat.send(6);
    await page.clock.runFor(1000);
    expect((await chat.stats()).starts).toBe(3);
});

test('handles a browser autoplay rejection without losing chat messages or leaving playback active', async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const chat = await openChat(page);
    await page.locator('[data-sync-input]').click();
    await page.evaluate(() => { window.__syncAudioBlocked = true; });
    await chat.send(1);
    await page.clock.runFor(1000);
    expect((await chat.stats()).starts).toBe(0);
    expect((await chat.stats()).playing).toBe(false);
    expect(errors).toEqual([]);
    await page.evaluate(() => { window.__syncAudioBlocked = false; });
    await page.locator('[data-sync-input]').click();
    await chat.send(2);
    await page.clock.runFor(1000);
    expect((await chat.stats()).starts).toBe(1);
    await expect(page.locator('.sync-message-text')).toHaveCount(2);
});

test('synchronizes mute between open tabs and stops an already playing notification', async ({ page, context }) => {
    const first = await openChat(page);
    const otherPage = await context.newPage();
    const second = await openChat(otherPage, [], false);
    await first.send(1);
    await expect.poll(async () => (await first.stats()).playing || (await second.stats()).playing).toBe(true);
    await showSyncTools(otherPage);
    await otherPage.locator('[data-sync-sound]').click();
    await expect(page.locator('[data-sync-sound]')).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(async () => (await first.stats()).playing).toBe(false);
    await second.send(2);
    expect((await second.stats()).starts).toBe(0);
    await page.bringToFront();
    await showSyncTools(page);
    await page.locator('[data-sync-sound]').click();
    await expect(otherPage.locator('[data-sync-sound]')).toHaveAttribute('aria-pressed', 'true');
    await second.open();
    await expect(otherPage.locator('[data-sync-sound]')).toHaveAttribute('aria-pressed', 'true');
});

test('coordinates concurrent notifications and burst throttling across tabs without keeping a closed owner', async ({ page, context }) => {
    const first = await openChat(page);
    const otherPage = await context.newPage();
    const second = await openChat(otherPage, [], false);
    expect(first.sockets()).toBe(1);
    const starts = async () => (await first.stats()).starts + (await second.stats()).starts;
    await Promise.all([first.send(1), second.send(1)]);
    await settleNotifications(page);
    await expect.poll(starts).toBe(1);
    await Promise.all([first.send(2), second.send(2)]);
    await settleNotifications(page);
    expect(await starts()).toBe(1);
    await page.clock.runFor(1000);
    await otherPage.clock.runFor(1000);
    await Promise.all([first.send(3), second.send(3)]);
    await expect.poll(starts).toBe(2);
    const firstStarted = (await first.stats()).starts > 0;
    const survivor = firstStarted ? second : first;
    const survivorPage = firstStarted ? otherPage : page;
    const baseline = (await survivor.stats()).starts;
    const nextSockets = first.sockets() + ((firstStarted ? first : second).ownsSocket() ? 1 : 0);
    await (firstStarted ? page : otherPage).close();
    await expect.poll(first.sockets).toBe(nextSockets);
    await expect(survivorPage.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
    await survivorPage.bringToFront();
    await survivorPage.clock.runFor(1000);
    await survivor.send(4);
    await expect.poll(async () => (await survivor.stats()).starts).toBe(baseline + 1);
});

test('lets another tab notify after autoplay rejection and preserves deduplication after reload', async ({ page, context }) => {
    const first = await openChat(page);
    const otherPage = await context.newPage();
    const second = await openChat(otherPage, [], false);
    await page.evaluate(() => { window.__syncAudioBlocked = true; });
    await first.send(1);
    await expect.poll(async () => (await second.stats()).starts).toBe(1);
    await second.send(1);
    await expect.poll(async () => (await second.stats()).starts).toBe(1);
    await first.open();
    await first.send(1);
    await settleNotifications(page);
    await expect(page.locator('.sync-message-text')).toHaveCount(1);
    expect((await first.stats()).starts).toBe(0);
    const nextSockets = first.sockets() + (second.ownsSocket() ? 1 : 0);
    await otherPage.close();
    await expect.poll(first.sockets).toBe(nextSockets);
    await expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
    await page.clock.runFor(1000);
    await first.send(2);
    await expect.poll(async () => (await first.stats()).starts).toBe(1);
});

test('discards a queued notification when the page leaves and resumes notifications after restoration', async ({ page, context }) => {
    const first = await openChat(page);
    const otherPage = await context.newPage();
    await openChat(otherPage, [], false);
    const key = `portfolio-sync-notification:${roomId}:${deviceId}`;
    await otherPage.evaluate(key => {
        window.__heldNotification = navigator.locks.request(key, () => new Promise(resolve => { window.__releaseNotification = resolve; }));
    }, key);
    await otherPage.waitForFunction(() => typeof window.__releaseNotification === 'function');
    first.frame({ type: 'message', message: message(1, 'Queued notification', otherId), history: bounds(1) });
    await expect(page.locator('.sync-message-text')).toHaveText('Queued notification');
    await expect.poll(() => page.evaluate(async key => (await navigator.locks.query()).pending.some(lock => lock.name === key), key)).toBe(true);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
    await otherPage.evaluate(() => window.__releaseNotification());
    await otherPage.evaluate(key => navigator.locks.request(key, () => {}), key);
    expect((await first.stats()).starts).toBe(0);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow')));
    await expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
    await otherPage.evaluate(() => { window.__syncAudioBlocked = true; });
    await page.clock.runFor(1000);
    await otherPage.clock.runFor(1000);
    await first.send(2);
    await expect.poll(async () => (await first.stats()).starts).toBe(1);
});


test('plays the new-message sound once when server retention trims the oldest message', async ({ page }) => {
    const chat = await openChat(page, Array.from({ length: 500 }, (_, index) => message(index + 1, `History ${index + 1}`, otherId)));
    await page.clock.runFor(1000);
    const incoming = message(501, 'Live message after retention', otherId);
    const frame = { type: 'message', message: incoming, history: { ...bounds(501), generation: '2', oldestId: 2 } };
    chat.frame(frame);
    await expect(page.locator('.sync-message-text').last()).toHaveText('Live message after retention');
    await settleNotifications(page);
    await page.clock.runFor(1000);
    expect((await chat.stats()).starts).toBe(1);
    await expect(page.locator('.sync-message')).toHaveCount(500);
    await expect(page.locator('.sync-message-text').first()).toHaveText('History 2');
    chat.frame(frame);
    await settleNotifications(page);
    await page.clock.runFor(1000);
    expect((await chat.stats()).starts).toBe(1);
});
