const { test, expect } = require('@playwright/test');
const { readFileSync } = require('node:fs');

const source = readFileSync(require.resolve('../static/portfolio/js/apps/sync-inline-image.js'));
const gif = 'data:image/gif;base64,R0lGODlhAQABAIAAAP8AAAAA/yH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAQABAAACAkQBACH5BAAKAAAALAAAAAABAAEAAAICTAEAOw==';

test.beforeEach(async ({ page }) => {
    await page.route('http://inline-gif.test/**', route => route.fulfill(route.request().url().endsWith('/inline.js')
        ? { contentType: 'application/javascript', body: source }
        : { contentType: 'text/html', body: '<script type="module">import {createInlineGif} from "./inline.js"; window.createInlineGif = createInlineGif;</script>' }));
    await page.goto('http://inline-gif.test/');
    await page.waitForFunction(() => typeof window.createInlineGif === 'function');
});

test('displays the original animated GIF, opens preview by keyboard, and releases its capability', async ({ page }) => {
    await page.evaluate(url => {
        window.openCount = 0;
        window.closeCount = 0;
        window.previewCount = 0;
        window.loadedCount = 0;
        window.inlineGif = window.createInlineGif({
            name: 'hello.gif',
            load: async () => { window.openCount++; return { url, dispose: () => window.closeCount++ }; },
            onPreview: button => { if (button === window.inlineGif.element) window.previewCount++; },
            onLoad: () => window.loadedCount++
        });
        document.body.append(window.inlineGif.element);
        window.inlineGif.start();
        window.inlineGif.start();
    }, gif);
    const button = page.getByRole('button', { name: 'hello.gif' });
    await expect(button).toBeVisible();
    await expect(button.locator('img')).toHaveJSProperty('naturalWidth', 1);
    await expect(button.locator('img')).toHaveAttribute('src', gif);
    await button.focus();
    await button.press('Enter');
    expect(await page.evaluate(() => [window.openCount, window.previewCount, window.loadedCount])).toEqual([1, 1, 1]);
    await page.evaluate(() => window.inlineGif.dispose());
    await expect(button).toBeHidden();
    await expect(page.locator('.sync-message-gif img')).not.toHaveAttribute('src');
    expect(await page.evaluate(() => window.closeCount)).toBe(1);
});

test('removing a pending GIF releases its eventual capability without displaying it', async ({ page }) => {
    const state = await page.evaluate(async url => {
        let resolve;
        let closed = 0;
        const inline = window.createInlineGif({
            name: 'pending.gif',
            load: () => new Promise(done => { resolve = done; }),
            onPreview: () => {}
        });
        document.body.append(inline.element);
        const started = inline.start();
        inline.dispose();
        resolve({ url, dispose: () => closed++ });
        await started;
        return { closed, hidden: inline.element.hidden, src: inline.element.firstElementChild.getAttribute('src') };
    }, gif);
    expect(state).toEqual({ closed: 1, hidden: true, src: null });
});

test('a failed image releases the capability and leaves inline content hidden', async ({ page }) => {
    await page.evaluate(() => {
        window.failedCount = 0;
        window.closeCount = 0;
        window.inlineGif = window.createInlineGif({
            name: 'broken.gif',
            load: async () => ({ url: 'data:image/gif;base64,AA==', dispose: () => window.closeCount++ }),
            onPreview: () => {},
            onError: () => window.failedCount++
        });
        document.body.append(window.inlineGif.element);
        window.inlineGif.start();
    });
    await expect.poll(() => page.evaluate(() => [window.failedCount, window.closeCount])).toEqual([1, 1]);
    await expect(page.locator('.sync-message-gif')).toBeHidden();
});
