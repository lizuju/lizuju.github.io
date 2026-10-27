const { test, expect } = require('@playwright/test');
const { readFileSync } = require('node:fs');
const source = readFileSync(require.resolve('../static/portfolio/js/apps/sync-image-resource.js'));
const heic = readFileSync(require.resolve('./fixtures/heic-gradient.heic'));

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

test('uses static thumbnails for PNG and WebP while preserving their animated variants and AVIF sequences', async ({ page }) => {
    expect(await page.evaluate(async () => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 16;
        const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        const webp = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp'));
        const pngHeader = new Uint8Array(await png.arrayBuffer());
        const actl = new Uint8Array(20);
        new DataView(actl.buffer).setUint32(0, 8);
        actl.set(new TextEncoder().encode('acTL'), 4);
        const apng = new Blob([pngHeader.slice(0, 33), actl, pngHeader.slice(33)], { type: 'image/png' });
        const animatedWebp = new Uint8Array(30);
        animatedWebp.set(new TextEncoder().encode('RIFF'), 0);
        animatedWebp.set(new TextEncoder().encode('WEBPVP8X'), 8);
        animatedWebp[20] = 2;
        const avif = brand => {
            const bytes = new Uint8Array(20);
            new DataView(bytes.buffer).setUint32(0, 20);
            bytes.set(new TextEncoder().encode(`ftyp${brand}`), 4);
            bytes.set(new TextEncoder().encode(brand), 16);
            return new Blob([bytes], { type: 'image/avif' });
        };
        const formats = [png, apng, webp, new Blob([animatedWebp], { type: 'image/webp' }), avif('avif'), avif('avis')];
        const results = [];
        for (const blob of formats) {
            window.fetch = async () => new Response(blob);
            const resource = window.createImageResource({ load: async () => ({ url: '/image' }) });
            const lease = await resource.acquire();
            results.push(lease.animated);
            lease.release();
            resource.dispose();
        }
        return results;
    })).toEqual([false, true, false, true, false, true]);
});

test('accounts for decoded pixels when retaining highly compressed idle pictures', async ({ page }) => {
    expect(await page.evaluate(async () => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 2048;
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        canvas.width = canvas.height = 0;
        window.fetch = async () => new Response(blob);
        const resources = Array.from({ length: 3 }, () => window.createImageResource({ load: async () => ({ url: '/compressed' }) }));
        for (const resource of resources) { const lease = await resource.acquire(); lease.release(); }
        const result = { fileBytes: blob.size, retained: window.created.length - window.revoked.length, oldestEvicted: window.revoked[0] === window.created[0].url };
        resources.forEach(resource => resource.dispose());
        return result;
    })).toEqual({ fileBytes: expect.any(Number), retained: 2, oldestEvicted: true });
});

test('allows high-resolution pictures while immediately releasing their oversized idle cache', async ({ page }) => {
    expect(await page.evaluate(async () => {
        const bytes = new Uint8Array(33);
        bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
        const view = new DataView(bytes.buffer);
        view.setUint32(16, 8192);
        view.setUint32(20, 8192);
        window.fetch = async () => new Response(new Blob([bytes], { type: 'image/png' }));
        const resource = window.createImageResource({ load: async () => ({ url: '/oversized' }) });
        const lease = await resource.acquire();
        const retainedWhileActive = window.created.length - window.revoked.length;
        lease.release();
        const retainedAfterRelease = window.created.length - window.revoked.length;
        resource.dispose();
        return { retainedWhileActive, retainedAfterRelease };
    })).toEqual({ retainedWhileActive: 1, retainedAfterRelease: 0 });
});

test('defers oversized or unknown images before decoding while still allowing an explicit preview', async ({ page }) => {
    expect(await page.evaluate(async () => {
        let decodes = 0;
        window.Image = class {
            decode() { decodes++; return Promise.resolve(); }
            removeAttribute() {}
        };
        const oversized = new Uint8Array(33);
        oversized.set([137, 80, 78, 71, 13, 10, 26, 10]);
        const view = new DataView(oversized.buffer);
        view.setUint32(16, 8192);
        view.setUint32(20, 8192);
        const results = [];
        for (const bytes of [oversized, new Uint8Array(16)]) {
            window.fetch = async () => new Response(new Blob([bytes]));
            const resource = window.createImageResource({ kind: 'heic', load: async () => ({ url: '/photo' }) });
            const createdBefore = window.created.length;
            const decodesBefore = decodes;
            const automatic = await resource.acquire({ automatic: true }).then(() => 'loaded', error => error.code);
            const autoCreated = window.created.length - createdBefore;
            const autoDecodes = decodes - decodesBefore;
            const manual = await resource.acquire();
            results.push({ automatic, autoCreated, autoDecodes, manual: manual.url.startsWith('blob:') });
            manual.release();
            resource.dispose();
        }
        return { results, decodes };
    })).toEqual({
        results: Array.from({ length: 2 }, () => ({ automatic: 'image_preview_deferred', autoCreated: 0, autoDecodes: 0, manual: true })),
        decodes: 2
    });
});

test('keeps a simultaneous manual preview alive when its oversized automatic preview is deferred', async ({ page }) => {
    expect(await page.evaluate(async () => {
        const bytes = new Uint8Array(33);
        bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
        const view = new DataView(bytes.buffer);
        view.setUint32(16, 8192);
        view.setUint32(20, 8192);
        let loads = 0;
        let decodes = 0;
        window.Image = class { decode() { decodes++; return Promise.resolve(); } removeAttribute() {} };
        window.fetch = async () => new Response(new Blob([bytes]));
        const resource = window.createImageResource({ kind: 'heic', load: async () => { loads++; return { url: '/photo' }; } });
        const automatic = resource.acquire({ automatic: true }).then(() => 'loaded', error => error.code);
        const manual = await resource.acquire();
        const failure = await automatic;
        const alive = (await window.nativeFetch(manual.url)).ok;
        manual.release();
        resource.dispose();
        return { loads, decodes, failure, alive, remaining: window.created.length - window.revoked.length };
    })).toEqual({ loads: 1, decodes: 1, failure: 'image_preview_deferred', alive: true, remaining: 0 });
});

test('reuses a deferred high-resolution image without downloading or decoding it before a manual preview', async ({ page }) => {
    expect(await page.evaluate(async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 4000;
        canvas.height = 3000;
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        canvas.width = canvas.height = 0;
        let downloads = 0;
        window.fetch = async () => { downloads++; return new Response(blob); };
        const resource = window.createImageResource({ load: async () => ({ url: '/photo' }) });
        const deferred = await resource.acquire({ automatic: true }).then(() => '', error => error.code);
        const beforeManual = { downloads, urls: window.created.length };
        const lease = await resource.acquire();
        const image = new Image();
        image.src = lease.url;
        await image.decode();
        const dimensions = [image.naturalWidth, image.naturalHeight];
        image.removeAttribute('src');
        lease.release();
        resource.dispose();
        return { deferred, beforeManual, downloads, dimensions, remaining: window.created.length - window.revoked.length };
    })).toEqual({ deferred: 'image_preview_deferred', beforeManual: { downloads: 1, urls: 0 }, downloads: 1,
        dimensions: [4000, 3000], remaining: 0 });
});

test('counts deferred compressed Blobs against the shared cache limit', async ({ page }) => {
    expect(await page.evaluate(async () => {
        const header = new Uint8Array(33);
        header.set([137, 80, 78, 71, 13, 10, 26, 10]);
        const view = new DataView(header.buffer);
        view.setUint32(16, 8192);
        view.setUint32(20, 8192);
        const blob = new Blob([header, new Uint8Array(17 * 1024 * 1024)]);
        let downloads = 0;
        window.fetch = async () => { downloads++; return new Response(blob); };
        const resources = Array.from({ length: 2 }, () => window.createImageResource({ load: async () => ({ url: '/photo' }) }));
        for (const resource of resources) await resource.acquire({ automatic: true }).catch(() => {});
        const afterTwo = downloads;
        await resources[0].acquire({ automatic: true }).catch(() => {});
        resources.forEach(resource => resource.dispose());
        return { afterTwo, downloads, decoded: window.created.length };
    })).toEqual({ afterTwo: 2, downloads: 3, decoded: 0 });
});

test('permits ordinary HEIC dimensions through the automatic gate', async ({ page }) => {
    expect(await page.evaluate(async bytes => {
        let decodes = 0;
        window.Image = class { decode() { decodes++; return Promise.resolve(); } removeAttribute() {} };
        window.fetch = async () => new Response(new Blob([Uint8Array.from(bytes)], { type: 'image/heic' }));
        const resource = window.createImageResource({ kind: 'heic', load: async () => ({ url: '/photo' }) });
        const lease = await resource.acquire({ automatic: true });
        const url = lease.url;
        lease.release();
        resource.dispose();
        return { decodes, created: window.created.length, revoked: window.revoked.includes(url) };
    }, Array.from(heic))).toEqual({ decodes: 1, created: 1, revoked: true });
});

test('handles truncated format headers without reading outside their bytes', async ({ page }) => {
    expect(await page.evaluate(async () => {
        const headers = [
            [137, 80, 78, 71, 13, 10, 26, 10],
            [71, 73, 70, 56, 57, 97],
            [255, 216, 255, 192, 0, 1],
            [...new Uint8Array(16)]
        ];
        headers[3].splice(0, 8, 0, 0, 0, 1, 102, 116, 121, 112);
        const results = [];
        for (const bytes of headers) {
            window.fetch = async () => new Response(new Blob([Uint8Array.from(bytes)]));
            const resource = window.createImageResource({ load: async () => ({ url: '/truncated' }) });
            const lease = await resource.acquire();
            results.push(lease.animated);
            lease.release();
            resource.dispose();
        }
        return results;
    })).toEqual([false, false, false, false]);
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
