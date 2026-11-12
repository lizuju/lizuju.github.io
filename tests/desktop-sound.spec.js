const { test, expect } = require('@playwright/test');

// Adds two looping desktop players and starts them with a real click.
const startMedia = async (page) => {
    await page.locator('body').evaluate((body) => {
        for (const name of ['first', 'second']) {
            const audio = document.createElement('audio');
            audio.dataset.testMedia = name;
            audio.src = '/audio/atmosphere/office.mp3';
            audio.loop = true;
            audio.volume = 0.4;
            body.append(audio);
        }
        const button = document.createElement('button');
        button.dataset.testMediaStart = '';
        button.textContent = 'play';
        button.style.cssText = 'position:fixed;left:400px;top:8px;z-index:99';
        button.addEventListener('click', () => document.querySelectorAll('[data-test-media]').forEach((audio) => audio.play()));
        body.append(button);
    });
    await page.locator('[data-test-media-start]').click();
    for (const name of ['first', 'second']) {
        await expect.poll(() => media(page, name, 'currentTime')).toBeGreaterThan(0);
    }
};
const media = (page, name, property) => page.locator(`[data-test-media="${name}"]`)
    .evaluate((audio, key) => audio[key], property);

test('silences desktop media with the system mute without pausing it or changing its volume', async ({ page, isMobile }) => {
    test.skip(isMobile, 'media autoplay in the phone layout is covered by the chat media tests');
    await page.goto('/portfolio/');
    await page.locator('[data-window-action="minimize"]').click();
    await startMedia(page);
    // A player the person muted themselves stays muted after the system mute is lifted.
    await page.locator('[data-test-media="second"]').evaluate((audio) => { audio.muted = true; });

    const toggle = page.locator('[data-audio-toggle]');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => media(page, 'first', 'muted')).toBe(true);
    const time = await media(page, 'first', 'currentTime');
    await expect.poll(() => media(page, 'first', 'currentTime')).toBeGreaterThan(time + 0.1);
    expect(await media(page, 'first', 'volume')).toBeCloseTo(0.4);
    expect(await media(page, 'first', 'paused')).toBe(false);

    // Unmuting from the player's own controls does not override the system mute.
    await page.locator('[data-test-media="first"]').evaluate((audio) => { audio.muted = false; });
    await expect.poll(() => media(page, 'first', 'muted')).toBe(true);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => media(page, 'first', 'muted')).toBe(false);
    expect(await media(page, 'second', 'muted')).toBe(true);
    expect(await media(page, 'first', 'volume')).toBeCloseTo(0.4);
});
