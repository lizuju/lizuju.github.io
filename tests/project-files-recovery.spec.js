const { test, expect } = require('@playwright/test');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

test.use({ serviceWorkers: 'block' });
const openFolder = async page => {
    await page.goto('/portfolio/');
    if (await page.locator('[data-window-action="minimize"]').isVisible()) await page.locator('[data-window-action="minimize"]').click();
    await page.locator('.desktop-shortcut[data-open-project-folder]').click();
};

test('retries a failed paper page directly and when reopening without reloading successful pages', async ({ page }) => {
    let requests = 0;
    await page.route('**/math-modeling-papers/national/page-01.webp', route => {
        requests++;
        return requests <= 2 ? route.abort() : route.continue();
    });
    await openFolder(page);
    await page.locator('[data-folder="papers"]').click();
    const paper = page.locator('[data-modeling-paper]').first();
    await paper.click();
    const first = page.locator('.paper-preview-page').first();
    await expect(first.locator('[data-paper-retry]')).toBeVisible();
    await first.locator('[data-paper-retry]').click();
    await expect.poll(() => requests).toBe(2);
    await expect(first.locator('[data-paper-retry]')).toBeVisible();
    await page.locator('[data-taskbar-lang]').click();
    await expect(first.locator('[data-paper-retry]')).toHaveText('Reload this page');
    await page.locator('[data-paper-preview-action="close"]').click();
    await paper.click();
    await expect.poll(() => first.locator('img').evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
    await expect(first.locator('[data-paper-retry]')).toBeHidden();
    expect(requests).toBe(3);
    await page.locator('[data-paper-preview-action="close"]').click();
    await paper.click();
    await expect.poll(() => first.locator('img').evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
    expect(requests).toBe(3);
});

test('keeps the previewed photo independent of folder selection when changing language and restoring the session', async ({ page }) => {
    await openFolder(page);
    await page.locator('[data-folder="photos"]').click();
    const photos = page.locator('[data-robomaster-image]');
    await photos.first().click();
    const source = await page.locator('[data-image-preview-image]').getAttribute('src');
    await page.locator('[data-image-preview-action="minimize"]').click();
    await photos.first().focus();
    await page.keyboard.press('ArrowDown');
    const selected = await page.locator('[data-robomaster-image].is-selected').getAttribute('data-image-src');
    expect(selected).not.toBe(source);
    await page.locator('[data-taskbar-lang]').click();
    await page.locator('[data-image-preview-task]').click();
    await expect(page.locator('[data-image-preview-title]')).toHaveText('Image Preview - 01 Match.jpg');
    await expect(page.locator('[data-image-preview-image]')).toHaveAttribute('src', source);
    await expect(page.locator('[data-image-preview-image]')).toHaveAttribute('alt', 'Multiple RoboMaster robots in match action');
    await page.reload();
    await expect(page.locator('[data-image-preview-title]')).toHaveText('Image Preview - 01 Match.jpg');
    await expect(page.locator('[data-image-preview-image]')).toHaveAttribute('src', source);
    await expect(page.locator('[data-robomaster-image].is-selected')).toHaveAttribute('data-image-src', selected);
});

test('searches the current folder in either language and keeps filtered keyboard navigation on matching files', async ({ page }) => {
    await openFolder(page);
    const search = page.locator('[data-project-folder-search]');
    await search.fill('music');
    await expect(page.locator('[data-project-folder-root] [data-folder]:visible')).toHaveCount(1);
    await expect(page.locator('[data-folder="music"]')).toBeVisible();
    await page.locator('[data-taskbar-lang]').click();
    await expect(search).toHaveValue('music');
    await expect(search).toHaveAttribute('placeholder', 'Search this folder');
    await search.fill('数学');
    await expect(page.locator('[data-folder="papers"]')).toBeVisible();
    await page.locator('[data-folder="papers"]').click();
    await expect(search).toHaveValue('');
    await search.fill('国赛');
    await expect(page.locator('[data-modeling-paper]:visible')).toHaveCount(1);
    await search.fill('no match here');
    await expect(page.locator('[data-project-folder-empty]')).toBeVisible();
    await expect(page.locator('[data-modeling-paper]:visible')).toHaveCount(0);
    await page.locator('[data-window-menu="folder-file"]').click();
    await page.locator('[data-menu-action="folder-open"]').click();
    await expect(page.locator('[data-paper-preview-window]')).toBeHidden();
    await page.locator('[data-project-folder-back]').click();
    await page.locator('[data-folder="photos"]').click();
    await search.fill('service');
    const matching = page.locator('[data-robomaster-image]:visible');
    await expect(matching).toHaveCount(2);
    await matching.first().focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-image-preview-image]')).toHaveAttribute('src', /(?:05-no4-infantry-service|12-team-trackside-service)\.jpg$/);
    const bounds = await search.boundingBox();
    expect(bounds.width).toBeGreaterThan(100);
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.viewportSize().width);
});

test('resumes the project video after closing or refreshing without autoplaying it', async ({ page }) => {
    const bytes = await readFile(path.join(__dirname, '../static/portfolio/assets/music-portfolio/last-christmas-solo.mp4'));
    await page.route('**/last-christmas-solo.mp4', route => {
        const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range || '');
        const start = range ? Number(range[1]) : 0;
        const end = range?.[2] ? Number(range[2]) : bytes.length - 1;
        return route.fulfill({ status: range ? 206 : 200, contentType: 'video/mp4', body: bytes.subarray(start, end + 1),
            headers: { 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {}) } });
    });
    await openFolder(page);
    await page.locator('[data-folder="music"]').click();
    await page.locator('[data-music-video]').click();
    const video = page.locator('[data-music-player]');
    await expect.poll(() => video.evaluate(video => video.duration)).toBeGreaterThan(20);
    await video.evaluate(video => { video.currentTime = 12; });
    await expect.poll(() => video.evaluate(video => video.seeking)).toBe(false);
    await expect.poll(() => video.evaluate(video => video.currentTime)).toBeCloseTo(12, 0);
    await page.locator('[data-video-preview-action="close"]').click();
    await page.locator('[data-music-video]').click();
    await expect.poll(() => video.evaluate(video => video.currentTime)).toBeCloseTo(12, 0);
    await expect(video).toHaveJSProperty('paused', true);
    await video.evaluate(video => { video.currentTime = 18; });
    await expect.poll(() => video.evaluate(video => video.seeking)).toBe(false);
    await page.reload();
    await expect.poll(() => video.evaluate(video => video.currentTime)).toBeCloseTo(18, 0);
    await expect(video).toHaveJSProperty('paused', true);
});

test('photo focus, search selection and opening refer to the same file', async ({ page }) => {
    await openFolder(page);
    await page.locator('[data-folder="photos"]').click();
    const photos = page.locator('[data-robomaster-image]');
    await photos.first().click();
    await page.locator('[data-image-preview-action="close"]').click();
    const search = page.locator('[data-project-folder-search]');
    await search.fill('02');
    await expect(photos.nth(1)).toHaveClass(/is-selected/);
    await expect(page.locator('[data-project-folder-status]')).toHaveText('1 / 13 个对象');
    await search.fill('');
    await page.locator('[data-window-menu="folder-file"]').click();
    await page.locator('[data-menu-action="folder-open"]').click();
    await expect(page.locator('[data-image-preview-title]')).toContainText('02');
    await page.locator('[data-image-preview-action="close"]').click();
    await photos.nth(2).focus();
    await expect(photos.nth(2)).toHaveClass(/is-selected/);
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-image-preview-title]')).toContainText('03');
});

test('photo preview keeps its filtered sequence when the folder changes and supports navigation controls', async ({ page }) => {
    await openFolder(page);
    await page.locator('[data-folder="photos"]').click();
    await page.locator('[data-project-folder-search]').fill('service');
    await page.locator('[data-robomaster-image]:visible').first().click();
    await expect(page.locator('[data-image-counter]')).toHaveText('1 / 2');
    await expect(page.locator('[data-image-previous]')).toBeDisabled();
    await page.locator('[data-image-preview-action="minimize"]').click();
    await page.locator('[data-project-folder-back]').click();
    await page.locator('[data-image-preview-task]').click();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('[data-image-counter]')).toHaveText('2 / 2');
    await expect(page.locator('[data-image-preview-title]')).toContainText('12');
    await expect(page.locator('[data-image-next]')).toBeDisabled();
    await page.locator('[data-image-previous]').click();
    await expect(page.locator('[data-image-preview-title]')).toContainText('05');
    await page.locator('[data-image-next]').click();
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('[data-image-counter]')).toHaveText('1 / 2');
    await page.locator('[data-taskbar-lang]').click();
    await expect(page.locator('[data-image-previous]')).toHaveAttribute('aria-label', 'Previous image');
    await expect(page.locator('[data-image-counter]')).toHaveText('1 / 2');
    const toolbar = await page.locator('[data-image-preview-toolbar]').evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth }));
    expect(toolbar.scroll).toBeLessThanOrEqual(toolbar.width + 1);
});

test('photo errors expose a bilingual retry and successful reopen does not reset zoom', async ({ page }) => {
    let fail = true;
    let requests = 0;
    await page.route('**/previews/01-match-multi-robot.*', route => {
        requests++;
        return fail ? route.abort() : route.continue();
    });
    await openFolder(page);
    await page.locator('[data-folder="photos"]').click();
    await page.locator('[data-robomaster-image]').first().click();
    const error = page.locator('[data-image-error]');
    await expect(error).toBeVisible();
    await page.locator('[data-taskbar-lang]').click();
    await expect(error).toContainText('Image could not be loaded');
    fail = false;
    await error.getByRole('button', { name: 'Reload image' }).click();
    await expect(error).toBeHidden();
    await expect.poll(() => page.locator('[data-image-preview-image]').evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
    expect(requests).toBeGreaterThan(1);
    await page.locator('[data-image-preview-toolbar] [data-preview-zoom-in]').click();
    await page.locator('[data-image-preview-action="close"]').click();
    await page.locator('[data-robomaster-image]').first().click();
    await expect(page.locator('[data-image-preview-toolbar] [data-preview-zoom-value]')).toHaveText('125%');
});
