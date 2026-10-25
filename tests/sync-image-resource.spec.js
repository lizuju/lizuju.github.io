const { test, expect } = require('@playwright/test');
const { readFileSync } = require('node:fs');
const source = readFileSync(require.resolve('../static/portfolio/js/apps/sync-image-resource.js'));

test.beforeEach(async ({ page }) => {
    await page.route('http://image-resource.test/**', route => route.fulfill(route.request().url().endsWith('/resource.js')
        ? { contentType: 'application/javascript', body: source }
        : { contentType: 'text/html', body: '<script type="module">import {createImageResource} from "./resource.js"; window.createImageResource=createImageResource;</script>' }));
    await page.goto('http://image-resource.test/');
    await page.waitForFunction(() => typeof window.createImageResource === 'function');
    await page.evaluate(() => {
        window.created = [];
        window.revoked = [];
        window.nativeFetch = window.fetch.bind(window);
        const create = URL.createObjectURL.bind(URL);
        const revoke = URL.revokeObjectURL.bind(URL);
        URL.createObjectURL = blob => { const url = create(blob); window.created.push({ url, size: blob.size }); return url; };
        URL.revokeObjectURL = url => { window.revoked.push(url); revoke(url); };
        window.fetch = async () => new Response(new Blob(['image'], { type: 'image/gif' }));
    });
});

test('shares the decrypted Blob between inline and preview, and keeps an active preview pinned on pause', async ({ page }) => {
    expect(await page.evaluate(async () => {
        let loads = 0;
        let closes = 0;
        const resource = window.createImageResource({ load: async () => { loads++; return { url: '/image', dispose: () => closes++ }; } });
        const [inline, preview] = await Promise.all([resource.acquire(), resource.acquire()]);
        inline.release();
        resource.clear();
        const alive = (await window.nativeFetch(preview.url)).ok;
        const beforeClose = window.revoked.length;
        preview.release();
        return { loads, closes, same: inline.url === preview.url, animated: inline.animated, alive, beforeClose, revoked: window.revoked };
    })).toMatchObject({ loads: 1, closes: 1, same: true, animated: true, alive: true, beforeClose: 0, revoked: [expect.stringMatching(/^blob:/)] });
});

test('aborting one consumer does not cancel another consumer or its cached image', async ({ page }) => {
    expect(await page.evaluate(async () => {
        let loads = 0;
        const resource = window.createImageResource({ name: 'reaction.gif', load: async () => { loads++; return { url: '/image' }; } });
        const controller = new AbortController();
        const pending = resource.acquire({ signal: controller.signal }).then(() => 'loaded', error => error.name);
        const preview = resource.acquire();
        controller.abort();
        const lease = await preview;
        const failure = await pending;
        lease.release();
        const again = await resource.acquire();
        const same = again.url === lease.url;
        again.release();
        resource.dispose();
        return { loads, failure, same, revoked: window.revoked.length };
    })).toEqual({ loads: 1, failure: 'AbortError', same: true, revoked: 1 });
});

test('disposes a pending request promptly and releases a late capability', async ({ page }) => {
    await page.evaluate(() => {
        window.capabilityCloses = 0;
        window.resource = window.createImageResource({ load: () => new Promise(resolve => { window.finishLoad = resolve; }) });
        window.pending = window.resource.acquire().then(() => 'loaded', error => error.name);
    });
    await page.waitForFunction(() => typeof window.finishLoad === 'function');
    expect(await page.evaluate(async () => { window.resource.dispose(); return window.pending; })).toBe('AbortError');
    await page.evaluate(() => window.finishLoad({ url: '/late', dispose: () => window.capabilityCloses++ }));
    await expect.poll(() => page.evaluate(() => window.capabilityCloses)).toBe(1);
    expect(await page.evaluate(() => window.created.length)).toBe(0);
});

test('keeps a failed load retryable and preserves its real error', async ({ page }) => {
    expect(await page.evaluate(async () => {
        let loads = 0;
        const resource = window.createImageResource({ load: async () => { if (++loads === 1) throw new Error('offline'); return { url: '/image' }; } });
        const failure = await resource.acquire().then(() => '', error => error.message);
        const lease = await resource.acquire();
        resource.clear();
        lease.release();
        return { failure, loads, revoked: window.revoked.length };
    })).toEqual({ failure: 'offline', loads: 2, revoked: 1 });
});

test('preserves animation-capable formats and treats JPEG thumbnails as static', async ({ page }) => {
    expect(await page.evaluate(async () => {
        const formats = [
            ['image/png', 'picture.png'], ['image/apng', 'animation.apng'], ['image/webp', 'animation.webp'],
            ['image/avif', 'animation.avif'], ['application/octet-stream', 'reaction.GIF'], ['image/jpeg', 'picture.jpg']
        ];
        const results = [];
        for (const [type, name] of formats) {
            window.fetch = async () => new Response(new Blob(['image'], { type }));
            const resource = window.createImageResource({ name, load: async () => ({ url: '/image' }) });
            const lease = await resource.acquire();
            results.push(lease.animated);
            lease.release();
            resource.dispose();
        }
        return results;
    })).toEqual([true, true, true, true, true, false]);
});

test('bounds idle images to twelve entries and refreshes evicted images', async ({ page }) => {
    expect(await page.evaluate(async () => {
        let loads = 0;
        const resources = Array.from({ length: 13 }, () => window.createImageResource({ load: async () => { loads++; return { url: '/image' }; } }));
        for (const resource of resources) { const lease = await resource.acquire(); lease.release(); }
        const afterThirteen = window.created.length - window.revoked.length;
        const oldestEvicted = window.revoked[0] === window.created[0].url;
        const lease = await resources[0].acquire();
        lease.release();
        resources.forEach(resource => resource.dispose());
        return { afterThirteen, oldestEvicted, loads, remaining: window.created.length - window.revoked.length };
    })).toEqual({ afterThirteen: 12, oldestEvicted: true, loads: 14, remaining: 0 });
});

test('bounds idle Blob storage to thirty-two MiB while allowing an active preview to stay pinned', async ({ page }) => {
    expect(await page.evaluate(async () => {
        window.fetch = async () => new Response(new Blob([new Uint8Array(17 * 1024 * 1024)], { type: 'image/gif' }));
        const resources = Array.from({ length: 3 }, () => window.createImageResource({ load: async () => ({ url: '/large' }) }));
        const pinned = await resources[0].acquire();
        for (const resource of resources.slice(1)) { const lease = await resource.acquire(); lease.release(); }
        const alive = window.created.filter(item => !window.revoked.includes(item.url));
        const pinnedAlive = alive.some(item => item.url === pinned.url);
        const idleBytes = alive.filter(item => item.url !== pinned.url).reduce((total, item) => total + item.size, 0);
        resources.forEach(resource => resource.clear());
        const stillPinned = !window.revoked.includes(pinned.url);
        pinned.release();
        resources.forEach(resource => resource.dispose());
        return { pinnedAlive, idleBytes, stillPinned, remaining: window.created.length - window.revoked.length };
    })).toEqual({ pinnedAlive: true, idleBytes: 17 * 1024 * 1024, stillPinned: true, remaining: 0 });
});
