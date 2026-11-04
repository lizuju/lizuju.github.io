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
