const { test, expect, deviceId, otherId, keyId, message, authorize } = require('./fixtures/sync-e2ee.cjs');

const preference = 'portfolio-sync-notification-sound';
const headers = {
    'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Sync-Key-Id',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};
const bounds = latestId => ({ generation: '1', oldestId: 1, latestId, continuationId: latestId, hasNewer: false });

const openChat = async (page, initial = []) => {
    await page.addInitScript(() => {
        window.__syncAudioStats = { starts: 0, pauses: 0, playing: false };
        window.__syncAudioBlocked = false;
        class NotificationAudio extends EventTarget {
            constructor(src) { super(); this.src = src; this.currentTime = 0; this.muted = false; }
            async play() {
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
    await page.clock.install();
    await authorize(page);
    await page.route('**/portfolio/sync-config.json', route => route.fulfill({ json: { apiBase: 'https://sync.test' } }));
    await page.route('https://sync.test/**', route => route.request().method() === 'OPTIONS'
        ? route.fulfill({ status: 204, headers })
        : route.fulfill({ headers, json: { deviceId, devices: [], grants: [], hasMore: false, keyId } }));
    let connection;
    await page.routeWebSocket('wss://sync.test/**', socket => {
        connection = socket;
        socket.onMessage(raw => {
            if (raw === 'ping') return socket.send('pong');
            if (JSON.parse(raw).type === 'auth') socket.send(JSON.stringify({
                type: 'ready', deviceId, messages: initial, pairing: null, readReceipts: [],
                history: bounds(initial.at(-1)?.id ?? null), historyMode: 'replace'
            }));
        });
    });
    const open = async () => {
        await page.goto('/portfolio/');
        await page.bringToFront();
        if (await page.locator('[data-window-action="minimize"]').isVisible()) await page.locator('[data-window-action="minimize"]').click();
        if (!await page.locator('[data-sync-window]').isVisible()) await page.locator('.desktop-shortcut[data-open-sync-space]').click();
        await expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
    };
    await open();
    return {
        open,
        send: async (id, sender = otherId) => {
            const item = message(id, `Notification message ${id}`, sender);
            connection.send(JSON.stringify({ type: 'message', message: item, history: bounds(id) }));
            await expect(page.locator('.sync-message-text').filter({ hasText: `Notification message ${id}` })).toHaveCount(1);
            return item;
        },
        frame: data => connection.send(JSON.stringify(data)),
        stats: () => page.evaluate(() => window.__syncAudioStats)
    };
};

test('places an accessible sound switch before pairing and remembers mute across reloads and languages', async ({ page }) => {
    const chat = await openChat(page);
    const sound = page.locator('[data-sync-sound]');
    await expect(sound).toHaveAttribute('aria-pressed', 'true');
    await expect(sound.locator('img')).toHaveAttribute('alt', '');
    const position = await page.evaluate(() => {
        const sound = document.querySelector('[data-sync-sound]').getBoundingClientRect();
        const pairing = document.querySelector('[data-sync-pair]').getBoundingClientRect();
        return { fits: sound.left >= 0 && sound.right <= window.innerWidth, before: sound.right <= pairing.left + 1, compact: sound.width <= 32 };
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
    await page.locator('[data-sync-sound]').click();
    await page.clock.runFor(1000);
    await chat.send(5);
    await page.clock.runFor(1000);
    expect((await chat.stats()).starts).toBe(2);
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
