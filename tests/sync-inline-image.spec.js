const { test, expect } = require('@playwright/test');
const { readFileSync } = require('node:fs');

const source = readFileSync(require.resolve('../static/portfolio/js/apps/sync-inline-image.js'));
const resourceSource = readFileSync(require.resolve('../static/portfolio/js/apps/sync-image-resource.js'));
const gif = 'data:image/gif;base64,R0lGODlhAQABAIAAAP8AAAAA/yH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAQABAAACAkQBACH5BAAKAAAALAAAAAABAAEAAAICTAEAOw==';

test.beforeEach(async ({ page }) => {
    await page.route('http://inline-gif.test/**', route => route.fulfill(route.request().url().endsWith('/inline.js')
        ? { contentType: 'application/javascript', body: source }
        : route.request().url().endsWith('/resource.js') ? { contentType: 'application/javascript', body: resourceSource }
            : { contentType: 'text/html', body: '<script type="module">import {createInlineImage} from "./inline.js"; import {createImageResource} from "./resource.js"; window.createInlineImage = createInlineImage; window.createImageResource = createImageResource;</script>' }));
    await page.goto('http://inline-gif.test/');
    await page.waitForFunction(() => typeof window.createInlineImage === 'function');
    await page.evaluate(() => {
        const viewport = document.createElement('div');
        viewport.style.cssText = 'height:180px;width:280px;overflow:auto';
        viewport.id = 'viewport';
        document.body.append(viewport);
        window.mountGif = options => {
            const target = document.createElement('div');
            target.style.minHeight = '260px';
            viewport.append(target);
            const resource = window.createImageResource({ name: options.name, load: options.load });
            const inline = window.createInlineImage({ retryLabel: () => 'Retry send', ...options, resource, viewport, target });
            target.append(inline.element);
            inline.element.style.width = '160px';
            const pause = inline.pause;
            inline.pause = () => { pause(); resource.clear(); };
            const dispose = inline.dispose;
            inline.dispose = () => { dispose(); resource.dispose(); };
            inline.start();
            return inline;
        };
    });
});

test('displays the original animated GIF, opens preview by keyboard, and releases its capability', async ({ page }) => {
    await page.evaluate(url => {
        window.openCount = 0;
        window.closeCount = 0;
        window.previewCount = 0;
        window.loadedCount = 0;
        window.inlineGif = window.mountGif({
            name: 'hello.gif',
            load: async () => { window.openCount++; return { url, dispose: () => window.closeCount++ }; },
            onPreview: button => { if (button === window.inlineGif.element) window.previewCount++; },
            onLoad: () => window.loadedCount++
        });
        window.inlineGif.start();
    }, gif);
    const button = page.getByRole('button', { name: 'hello.gif', exact: true });
    await expect(button).toBeVisible();
    await expect(button.locator('img')).toHaveJSProperty('naturalWidth', 1);
    await expect(button.locator('img')).toHaveAttribute('src', /^blob:/);
    await button.focus();
    await button.press('Enter');
    expect(await page.evaluate(() => [window.openCount, window.previewCount, window.loadedCount])).toEqual([1, 1, 1]);
    const placeholder = await page.evaluate(() => {
        document.querySelector('#viewport').style.display = 'none';
        window.inlineGif.pause();
        return window.inlineGif.element.style.aspectRatio;
    });
    expect(placeholder).toBe('1 / 1');
    await page.evaluate(() => { document.querySelector('#viewport').style.display = ''; window.inlineGif.start(); });
    await expect.poll(() => page.evaluate(() => window.loadedCount)).toBe(2);
    await page.evaluate(() => window.inlineGif.dispose());
    await expect(button).toBeHidden();
    await expect(page.locator('.sync-message-image img')).not.toHaveAttribute('src');
    expect(await page.evaluate(() => window.closeCount)).toBe(2);
});

test('replaces a static PNG with its small poster and does not reload it on scrolling', async ({ page }) => {
    await page.evaluate(async () => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 512;
        const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        const source = URL.createObjectURL(png);
        const create = URL.createObjectURL.bind(URL);
        window.originalImageUrl = null;
        URL.createObjectURL = blob => {
            const url = create(blob);
            if (blob.type === 'image/png' && !window.originalImageUrl) window.originalImageUrl = url;
            return url;
        };
        window.pngLoads = 0;
        window.inlinePng = window.mountGif({ name: 'static.png', load: async () => { window.pngLoads++; return { url: source }; }, onPreview() {} });
    });
    const image = page.getByRole('button', { name: 'static.png', exact: true }).locator('img');
    await expect(image).toHaveJSProperty('naturalWidth', 200);
    expect(await image.getAttribute('src')).not.toBe(await page.evaluate(() => window.originalImageUrl));
    await page.locator('#viewport').evaluate(viewport => { viewport.scrollTop = viewport.scrollHeight; });
    await page.locator('#viewport').evaluate(viewport => { viewport.scrollTop = 0; });
    expect(await page.evaluate(() => window.pngLoads)).toBe(1);
    await page.evaluate(() => window.inlinePng.dispose());
});

test('removing a pending GIF releases its eventual capability without displaying it', async ({ page }) => {
    await page.evaluate(() => {
        window.closedCount = 0;
        window.inlineGif = window.mountGif({
            name: 'pending.gif',
            load: () => new Promise(resolve => { window.resolveGif = resolve; }),
            onPreview: () => {}
        });
    });
    await page.waitForFunction(() => typeof window.resolveGif === 'function');
    await page.evaluate(url => {
        window.inlineGif.dispose();
        window.resolveGif({ url, dispose: () => window.closedCount++ });
    }, gif);
    await expect.poll(() => page.evaluate(() => window.closedCount)).toBe(1);
    await expect(page.locator('.sync-message-image')).toBeHidden();
    await expect(page.locator('.sync-message-image img')).not.toHaveAttribute('src');
});

test('a failed image offers a localized retry and recovers without reopening the chat', async ({ page }) => {
    await page.evaluate(url => {
        window.failedCount = 0;
        window.openCount = 0;
        window.closeCount = 0;
        window.retryText = 'Retry send';
        window.inlineGif = window.mountGif({
            name: 'recover.gif', retryLabel: () => window.retryText,
            load: async () => ({ url: ++window.openCount === 1 ? 'data:image/gif;base64,AA==' : url, dispose: () => window.closeCount++ }),
            onPreview: () => {}, onError: () => window.failedCount++
        });
    }, gif);
    await expect.poll(() => page.evaluate(() => [window.failedCount, window.closeCount])).toEqual([1, 1]);
    await expect(page.getByRole('button', { name: 'recover.gif · Retry send' })).toBeVisible();
    await page.evaluate(() => { window.retryText = '重试发送'; window.inlineGif.start(); });
    await page.getByRole('button', { name: 'recover.gif · 重试发送' }).click();
    await expect(page.getByRole('button', { name: 'recover.gif', exact: true }).locator('img')).toHaveJSProperty('naturalWidth', 1);
    expect(await page.evaluate(() => window.openCount)).toBe(2);
});

test('loads nearby images once, retains their source while scrolling, and releases them when paused', async ({ page }) => {
    await page.evaluate(url => {
        window.openedGifs = [];
        window.closedGifs = [];
        window.gifs = Array.from({ length: 20 }, (_, index) => window.mountGif({
            name: `reaction-${index}.gif`,
            load: async () => { window.openedGifs.push(index); return { url, dispose: () => window.closedGifs.push(index) }; },
            onPreview: () => {}
        }));
    }, gif);
    await expect(page.locator('.sync-message-image img[src]')).toHaveCount(2);
    expect(await page.evaluate(() => [...window.openedGifs].sort())).toEqual([0, 1]);
    await page.locator('#viewport').evaluate(viewport => { viewport.scrollTop = viewport.scrollHeight; });
    await expect(page.locator('.sync-message-image img[src]')).toHaveCount(3);
    await expect(page.locator('.sync-message-image img[src]').first()).toHaveJSProperty('naturalWidth', 1);
    await page.locator('#viewport').evaluate(viewport => { viewport.scrollTop = 0; });
    await expect(page.locator('.sync-message-image img[src]')).toHaveCount(3);
    expect(await page.evaluate(() => window.openedGifs.length)).toBe(3);
    await page.locator('#viewport').evaluate(viewport => { viewport.scrollTop = viewport.scrollHeight; });
    await page.evaluate(() => window.gifs.forEach(gif => gif.pause()));
    await expect(page.locator('.sync-message-image img[src]')).toHaveCount(0);
    expect(await page.evaluate(() => window.openedGifs.length - window.closedGifs.length)).toBe(0);
    await page.evaluate(() => window.gifs.forEach(gif => gif.start()));
    await expect(page.locator('.sync-message-image img[src]')).toHaveCount(1);
    expect(await page.evaluate(() => window.openedGifs.length)).toBe(4);
});

test('keeps concurrent GIF loads to three and drops queued work when paused', async ({ page }) => {
    await page.evaluate(() => {
        document.querySelector('#viewport').style.height = '1300px';
        window.openCount = 0;
        window.releaseGifs = [];
        window.gifs = Array.from({ length: 20 }, (_, index) => window.mountGif({
            name: `queued-${index}.gif`,
            load: () => { window.openCount++; return new Promise(resolve => window.releaseGifs.push(resolve)); },
            onPreview: () => {}
        }));
    });
    await expect.poll(() => page.evaluate(() => window.openCount)).toBe(3);
    await page.evaluate(url => {
        window.gifs.forEach(gif => gif.pause());
        window.releaseGifs.forEach(resolve => resolve({ url, dispose() {} }));
    }, gif);
    await expect(page.locator('.sync-message-image img[src]')).toHaveCount(0);
    expect(await page.evaluate(() => window.openCount)).toBe(3);
});

test('pausing and reopening while a capability is pending cannot display the stale response', async ({ page }) => {
    await page.evaluate(() => {
        window.pendingLoads = [];
        window.closedLoads = [];
        window.imageLoads = 0;
        window.inlineGif = window.mountGif({
            name: 'reopened.gif',
            load: () => new Promise(resolve => window.pendingLoads.push(resolve)),
            onPreview: () => {}, onLoad: () => window.imageLoads++
        });
    });
    await expect.poll(() => page.evaluate(() => window.pendingLoads.length)).toBe(1);
    await page.evaluate(url => {
        window.inlineGif.pause();
        window.inlineGif.start();
        window.pendingLoads[0]({ url, dispose: () => window.closedLoads.push('old') });
    }, gif);
    await expect.poll(() => page.evaluate(() => window.pendingLoads.length)).toBe(2);
    expect(await page.evaluate(() => window.closedLoads)).toEqual(['old']);
    expect(await page.evaluate(() => window.imageLoads)).toBe(0);
    await page.evaluate(url => window.pendingLoads[1]({ url, dispose: () => window.closedLoads.push('new') }), gif);
    await expect(page.getByRole('button', { name: 'reopened.gif', exact: true }).locator('img')).toHaveJSProperty('naturalWidth', 1);
    await expect.poll(() => page.evaluate(() => window.imageLoads)).toBe(1);
    await page.evaluate(() => window.inlineGif.pause());
    expect(await page.evaluate(() => window.closedLoads)).toEqual(['old', 'new']);
});
