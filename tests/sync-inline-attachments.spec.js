const { test, expect, deviceId, keyId, authorize, message, file, profile, startSite } = require('./fixtures/sync-e2ee.cjs');
const { createServer } = require('node:http');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC1kAAAAASUVORK5CYII=', 'base64');
const gif = Buffer.from('R0lGODlhAQABAIAAAP8AAAAA/yH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAQABAAACAkQBACH5BAAKAAAALAAAAAABAAEAAAICTAEAOw==', 'base64');
const jpeg = Buffer.from('/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjExLjEwMAD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABMAAEBAAAAAAAAAAAAAAAAAAAABwEBAQAAAAAAAAAAAAAAAAAABQcQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAACAAIDASIAAhEAAxEA/9oADAMBAAIRAxEAPwCOAL+Kf//Z', 'base64');
const avif = Buffer.from('AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAAD5bWV0YQAAAAAAAAAvaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAFBpY3R1cmVIYW5kbGVyAAAAAA5waXRtAAAAAAABAAAAHmlsb2MAAAAARAAAAQABAAAAAQAAASEAAAAiAAAAKGlpbmYAAAAAAAEAAAAaaW5mZQIAAAAAAQAAYXYwMUNvbG9yAAAAAGppcHJwAAAAS2lwY28AAAAUaXNwZQAAAAAAAAAIAAAACAAAABBwaXhpAAAAAAMICAgAAAAMYXYxQ4EADAAAAAATY29scm5jbHgAAgACAAIAAAAAF2lwbWEAAAAAAAAAAQABBAECgwQAAAAqbWRhdAoJAAAAARfjV8gCMhUQAJeAEECCAAAQAPrtxigjB7SrLoA=', 'base64');
let site;
let server;
let apiBase;
let attachments;
let bytes;
let gets;

const row = (page, name) => page.locator('.sync-message').filter({ has: page.locator('.sync-attachment-name', { hasText: name }) });
const openChat = async (page, mobile = false, iframe = false) => {
    await authorize(page, `${site.origin}/portfolio/`);
    let chat = page;
    if (iframe) {
        await page.route(`${site.origin}/shell`, route => route.fulfill({ contentType: 'text/html', body: '<meta name="viewport" content="width=device-width, initial-scale=1"><iframe src="/portfolio/" style="border:0;position:fixed;inset:0;width:100%;height:100%"></iframe>' }));
        await page.goto(`${site.origin}/shell`);
        await expect(page.locator('iframe')).toBeVisible();
        await expect.poll(() => page.frames().length).toBe(2);
        chat = page.frames().find(frame => frame !== page.mainFrame());
    } else await page.goto(`${site.origin}/portfolio/${mobile ? 'chat/' : ''}`);
    if (!mobile || iframe) {
        if (await chat.locator('[data-window-action="minimize"]').isVisible()) await chat.locator('[data-window-action="minimize"]').click();
        await chat.locator('.desktop-shortcut[data-open-sync-space]').click();
    }
    await expect(chat.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
    return chat;
};

test.beforeEach(async ({ page }) => {
    bytes = [Buffer.concat([gif, Buffer.alloc(1536 * 1024 - gif.length)]), png, jpeg,
        await readFile(path.join(__dirname, '../static/portfolio/assets/project-vision-480.webp')), avif,
        await readFile(path.join(__dirname, 'fixtures/heic-gradient.heic')),
        await readFile(path.join(__dirname, '../static/portfolio/assets/li-zuju-resume.pdf')),
        await readFile(path.join(__dirname, '../static/textures/monitor/video/base-static.mp4'))];
    attachments = [
        file('reaction-1.5MB.gif', 'image/gif', bytes[0]), file('pixel.png', 'application/octet-stream', bytes[1]),
        file('camera.jpg', 'image/jpeg', bytes[2]), file('project.webp', 'image/webp', bytes[3]),
        file('blue.avif', 'image/avif', bytes[4]), file('camera.HEIC', 'application/octet-stream', bytes[5]),
        file('paper.pdf', 'application/pdf', bytes[6]), file('clip.mp4', 'video/mp4', bytes[7])
    ];
    gets = new Map();
    const headers = {
        'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Sync-Key-Id, Range',
        'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS', 'Access-Control-Expose-Headers': 'Content-Range, Content-Length'
    };
    server = createServer((request, response) => {
        const pathname = new URL(request.url, 'http://localhost').pathname;
        const json = value => { response.writeHead(200, { ...headers, 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
        if (request.method === 'OPTIONS') { response.writeHead(204, headers); response.end(); return; }
        if (pathname.endsWith('/key-grants')) return json({ grants: [], hasMore: false, keyId });
        if (pathname.endsWith('/devices')) return json({ deviceId, devices: [profile()] });
        if (pathname.endsWith('/download')) return json({ ticket: pathname.split('/').at(-2).padStart(64, '0'), expiresAt: Date.now() + 86400000 });
        const id = Number(pathname.split('/').at(-1));
        const encrypted = attachments[id - 1]?.bytes;
        if (!encrypted) { response.writeHead(404, headers); response.end(); return; }
        if (request.method === 'GET') gets.set(id, (gets.get(id) || 0) + 1);
        const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range || '');
        const start = range ? Number(range[1]) : 0;
        const end = range ? Math.min(Number(range[2]), encrypted.length - 1) : encrypted.length - 1;
        const body = encrypted.subarray(start, end + 1);
        response.writeHead(range ? 206 : 200, { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length),
            ...(range ? { 'Content-Range': `bytes ${start}-${end}/${encrypted.length}` } : {}) });
        response.end(request.method === 'HEAD' ? undefined : body);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    apiBase = `http://127.0.0.1:${server.address().port}`;
    site = await startSite(apiBase);
    await page.addInitScript(() => {
        window.inlineImageUrls = [];
        window.revokedInlineImageUrls = [];
        const create = URL.createObjectURL.bind(URL);
        const revoke = URL.revokeObjectURL.bind(URL);
        URL.createObjectURL = blob => {
            const url = create(blob);
            if (blob.type.startsWith('image/')) window.inlineImageUrls.push(url);
            return url;
        };
        URL.revokeObjectURL = url => { window.revokedInlineImageUrls.push(url); revoke(url); };
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copiedInlineText = text; } } });
    });
    await page.routeWebSocket(`${apiBase.replace('http:', 'ws:')}/**`, socket => socket.onMessage(raw => {
        if (raw === 'ping') return socket.send('pong');
        if (JSON.parse(raw).type === 'auth') socket.send(JSON.stringify({
            type: 'ready', deviceId, pairing: null,
            messages: attachments.map((attachment, index) => message(index + 1, index === 0 ? 'Animated image caption' : '', deviceId, attachment.metadata))
        }));
    }));
});

test.afterEach(async () => {
    await site?.close();
    site = null;
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); server = null; }
});

test('renders encrypted GIF PNG JPEG WebP AVIF and HEIC inline and retains loaded images while scrolling', async ({ page, isMobile }) => {
    const chat = await openChat(page, isMobile);
    const loaded = [];
    for (const attachment of attachments.slice(0, 6)) {
        const imageRow = row(chat, attachment.metadata.name);
        await imageRow.scrollIntoViewIfNeeded();
        const image = imageRow.locator('.sync-message-image img');
        await expect(image).toBeVisible();
        await expect.poll(() => image.evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
        loaded.push(await image.getAttribute('src'));
    }
    expect(loaded.every(url => url.startsWith('blob:'))).toBe(true);
    await chat.locator('[data-sync-feed]').evaluate(feed => { feed.scrollTop = feed.scrollHeight; });
    for (const attachment of attachments.slice(0, 6))
        await expect.poll(() => row(chat, attachment.metadata.name).locator('.sync-message-image img').evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
    const gifRow = row(chat, attachments[0].metadata.name);
    const gifGets = gets.get(1);
    await gifRow.scrollIntoViewIfNeeded();
    await expect(gifRow.locator('.sync-message-image img')).toHaveJSProperty('naturalWidth', 1);
    expect(gets.get(1)).toBe(gifGets);
    await gifRow.locator('.sync-message-image').click();
    const viewer = chat.locator('[data-sync-preview-window]');
    await expect(viewer.locator('img')).toHaveJSProperty('naturalWidth', 1);
    expect(gets.get(1)).toBe(gifGets);
    await viewer.locator('[data-sync-preview-action="close"]').click();
    await expect(gifRow.locator('.sync-message-image img')).toHaveJSProperty('naturalWidth', 1);
    if (isMobile) await chat.locator('[data-retro-desktop]').evaluate(element => { element.inert = true; });
    else await chat.locator('[data-sync-action="close"]').click();
    await expect(chat.locator('.sync-message-image img[src]')).toHaveCount(0);
    await expect.poll(() => chat.evaluate(() => window.inlineImageUrls.every(url => window.revokedInlineImageUrls.includes(url)))).toBe(true);
});

test('opens image cards with mouse Enter and Space while copying and downloading never open the viewer', async ({ page, isMobile }) => {
    const chat = await openChat(page, isMobile);
    const gifRow = row(chat, attachments[0].metadata.name);
    await gifRow.scrollIntoViewIfNeeded();
    await expect(gifRow.locator('.sync-message-image img')).toHaveJSProperty('naturalWidth', 1);
    await expect(chat.locator('.sync-attachment-preview')).toHaveCount(0);
    const card = gifRow.locator('[data-sync-preview-file]');
    await card.locator('.sync-attachment-name').click();
    const viewer = chat.locator('[data-sync-preview-window]');
    await expect(viewer.locator('img')).toHaveJSProperty('naturalWidth', 1);
    await viewer.locator('[data-sync-preview-action="close"]').click();
    for (const key of ['Enter', 'Space']) {
        await card.focus();
        await card.press(key);
        await expect(viewer).toBeVisible();
        await viewer.locator('[data-sync-preview-action="close"]').click();
    }
    await gifRow.locator('.sync-message-text').click();
    await expect(viewer).toBeVisible();
    await viewer.locator('[data-sync-preview-action="close"]').click();
    await gifRow.locator('[data-sync-copy-message]').click();
    expect(await chat.evaluate(() => window.copiedInlineText)).toBe('Animated image caption');
    await expect(viewer).toBeHidden();
    const downloaded = page.waitForEvent('download');
    await gifRow.locator('[data-sync-download-file]').click();
    const download = await downloaded;
    expect(download.suggestedFilename()).toBe(attachments[0].metadata.name);
    expect(await readFile(await download.path())).toEqual(bytes[0]);
    await expect(viewer).toBeHidden();
});

test('opens PDF and video cards directly without a separate preview button', async ({ page, isMobile }) => {
    const chat = await openChat(page, isMobile);
    const viewer = chat.locator('[data-sync-preview-window]');
    const pdf = row(chat, 'paper.pdf').locator('[data-sync-preview-file]');
    await pdf.scrollIntoViewIfNeeded();
    await pdf.focus();
    await pdf.press('Enter');
    await expect(viewer.locator('.sync-preview-page canvas').first()).toBeVisible();
    await viewer.locator('[data-sync-preview-action="close"]').click();
    await row(chat, 'clip.mp4').locator('.sync-attachment-name').click();
    await expect.poll(() => viewer.locator('video').evaluate(video => video.videoWidth)).toBeGreaterThan(0);
    await expect(chat.locator('.sync-attachment-preview')).toHaveCount(0);
});

test('loads encrypted inline images inside the desktop iframe and reuses their bytes for the viewer', async ({ page }) => {
    const chat = await openChat(page, false, true);
    const imageRow = row(chat, 'camera.HEIC');
    await imageRow.scrollIntoViewIfNeeded();
    const image = imageRow.locator('.sync-message-image img');
    await expect(image).toHaveJSProperty('naturalWidth', 64);
    await imageRow.locator('.sync-attachment-name').click();
    await expect(chat.locator('[data-sync-preview-window] img')).toHaveJSProperty('naturalWidth', 64);
    expect(gets.get(6)).toBe(1);
    await chat.locator('[data-sync-preview-action="close"]').click();
    await expect(image).toHaveJSProperty('naturalWidth', 64);
});
