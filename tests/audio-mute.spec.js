const { test, expect } = require('@playwright/test');

const sampleRate = 8000;
const sampleBytes = sampleRate * 20 * 2;
const wav = Buffer.alloc(44 + sampleBytes);
wav.write('RIFF', 0);
wav.writeUInt32LE(36 + sampleBytes, 4);
wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(sampleRate, 24);
wav.writeUInt32LE(sampleRate * 2, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write('data', 36);
wav.writeUInt32LE(sampleBytes, 40);

test.beforeEach(async ({ page, isMobile }) => {
    test.skip(isMobile, 'the mobile shell does not create the scene audio engine');
    test.setTimeout(60000);
    await page.addInitScript(() => {
        const NativeAudioContext = window.AudioContext || window.webkitAudioContext;
        window.__sceneAudio = { contexts: [], sources: [], errors: [] };
        window.addEventListener('unhandledrejection', (event) => {
            window.__sceneAudio.errors.push(String(event.reason));
        });
        const observedContext = new Proxy(NativeAudioContext, {
            construct(target, args) {
                const context = Reflect.construct(target, args);
                window.__sceneAudio.contexts.push(context);
                const createBufferSource = context.createBufferSource.bind(context);
                context.createBufferSource = () => {
                    const node = createBufferSource();
                    const record = { node, starts: [], stops: 0 };
                    window.__sceneAudio.sources.push(record);
                    const start = node.start.bind(node);
                    const stop = node.stop.bind(node);
                    node.start = (...parameters) => {
                        record.starts.push(parameters);
                        return start(...parameters);
                    };
                    node.stop = (...parameters) => {
                        record.stops += 1;
                        return stop(...parameters);
                    };
                    return node;
                };
                return context;
            },
        });
        window.AudioContext = observedContext;
        if (window.webkitAudioContext) window.webkitAudioContext = observedContext;
    });
    await page.route('**/audio/**/*.mp3', (route) => route.fulfill({
        contentType: 'audio/wav', body: wav,
    }));
});

async function startScene(page) {
    await page.goto('/');
    await expect(page.locator('[data-start-scene]')).toBeVisible({ timeout: 45000 });
    await page.locator('[data-start-scene]').click();
    await expect.poll(() => page.evaluate(() => (
        window.__sceneAudio.sources.filter(({ node }) => node.loop).length
    ))).toBe(1);
    await expect.poll(() => page.evaluate(() => window.__sceneAudio.contexts[0].state)).toBe('running');
}

test('suspends the real scene engine and resumes its existing loop without queuing muted input', async ({ page }) => {
    await startScene(page);
    const taskbarAudio = page.frameLocator('#computer-screen').locator('[data-audio-toggle]');
    await expect(taskbarAudio).toBeVisible();
    const shotIndex = await page.evaluate(() => {
        const index = window.__sceneAudio.sources.length;
        const event = new KeyboardEvent('keydown', { key: 'a' });
        event.inComputer = true;
        document.dispatchEvent(event);
        return index;
    });
    await expect.poll(() => page.evaluate((index) => (
        window.__sceneAudio.sources[index]?.starts.length
    ), shotIndex)).toBe(1);

    await taskbarAudio.evaluate((button) => button.click());
    await expect(taskbarAudio).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => page.evaluate(() => window.__sceneAudio.contexts[0].state)).toBe('suspended');
    expect(await page.evaluate((index) => window.__sceneAudio.sources[index].stops, shotIndex)).toBe(1);
    const paused = await page.evaluate(() => ({
        time: window.__sceneAudio.contexts[0].currentTime,
        sourceCount: window.__sceneAudio.sources.length,
    }));
    await page.evaluate(() => {
        for (const key of ['b', 'c', 'd']) {
            for (const type of ['keydown', 'keyup']) {
                const event = new KeyboardEvent(type, { key });
                event.inComputer = true;
                document.dispatchEvent(event);
            }
        }
        for (const type of ['mousedown', 'mouseup']) {
            const event = new MouseEvent(type);
            event.inComputer = true;
            document.dispatchEvent(event);
        }
    });
    await page.waitForTimeout(250);
    const stillPaused = await page.evaluate(() => ({
        time: window.__sceneAudio.contexts[0].currentTime,
        sourceCount: window.__sceneAudio.sources.length,
    }));
    expect(stillPaused.time - paused.time).toBeLessThan(0.02);
    expect(stillPaused.sourceCount).toBe(paused.sourceCount);

    await taskbarAudio.evaluate((button) => button.click());
    await expect.poll(() => page.evaluate(() => window.__sceneAudio.contexts[0].state)).toBe('running');
    await expect.poll(() => page.evaluate(() => window.__sceneAudio.contexts[0].currentTime)).toBeGreaterThan(paused.time + 0.1);
    const state = await page.evaluate(() => ({
        contexts: window.__sceneAudio.contexts.length,
        loops: window.__sceneAudio.sources.filter(({ node }) => node.loop).map(({ starts, stops }) => ({ starts: starts.length, stops })),
        errors: window.__sceneAudio.errors,
    }));
    expect(state.contexts).toBe(1);
    expect(state.loops).toEqual([{ starts: 1, stops: 0 }]);
    expect(state.errors).toEqual([]);
});

test('starts deferred ambience once after unmuting and honors rapid final mute state', async ({ page }) => {
    let releaseOffice;
    const officeReady = new Promise((resolve) => { releaseOffice = resolve; });
    let officeRequested = false;
    await page.route('**/audio/atmosphere/office.mp3', async (route) => {
        officeRequested = true;
        await officeReady;
        await route.fulfill({ contentType: 'audio/wav', body: wav });
    });
    await page.goto('/');
    await expect(page.locator('[data-start-scene]')).toBeVisible({ timeout: 45000 });
    const taskbarAudio = page.frameLocator('#computer-screen').locator('[data-audio-toggle]');
    await expect(taskbarAudio).toBeVisible();
    await taskbarAudio.evaluate((button) => button.click());
    await expect(taskbarAudio).toHaveAttribute('aria-pressed', 'true');
    await page.locator('[data-start-scene]').click();
    await expect.poll(() => officeRequested).toBe(true);
    const officeResponse = page.waitForResponse('**/audio/atmosphere/office.mp3');
    releaseOffice();
    await officeResponse;
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => window.__sceneAudio.sources.length)).toBe(0);
    expect(await page.evaluate(() => window.__sceneAudio.contexts[0].state)).toBe('suspended');

    await taskbarAudio.evaluate((button) => button.click());
    await expect.poll(() => page.evaluate(() => window.__sceneAudio.contexts[0].state)).toBe('running');
    await expect.poll(() => page.evaluate(() => window.__sceneAudio.sources.filter(({ node }) => node.loop).length)).toBe(1);
    await taskbarAudio.evaluate((button) => {
        for (let index = 0; index < 7; index += 1) button.click();
    });
    await expect(taskbarAudio).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => page.evaluate(() => window.__sceneAudio.contexts[0].state)).toBe('suspended');
    await taskbarAudio.evaluate((button) => {
        for (let index = 0; index < 7; index += 1) button.click();
    });
    await expect(taskbarAudio).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => page.evaluate(() => window.__sceneAudio.contexts[0].state)).toBe('running');
    expect(await page.evaluate(() => window.__sceneAudio.sources.filter(({ node }) => node.loop).length)).toBe(1);
    expect(await page.evaluate(() => window.__sceneAudio.errors)).toEqual([]);
});

test('keeps native media playback and volume independent of both background mute controls', async ({ page }) => {
    await startScene(page);
    await page.keyboard.press('Shift');
    const sceneAudio = page.locator('[data-audio-mute-toggle]');
    await expect(sceneAudio).toBeVisible({ timeout: 15000 });
    await expect(sceneAudio).toBeEnabled();
    const desktop = page.frameLocator('#computer-screen');
    const mediaUrl = `data:audio/wav;base64,${wav.toString('base64')}`;
    await desktop.locator('body').evaluate(async (body, url) => {
        const audio = document.createElement('audio');
        audio.dataset.testIndependentAudio = '';
        audio.src = url;
        audio.volume = 0.35;
        audio.loop = true;
        const video = document.createElement('video');
        video.dataset.testIndependentVideo = '';
        video.src = 'assets/music-portfolio/last-christmas-solo.mp4';
        video.volume = 0.65;
        video.loop = true;
        video.muted = true;
        video.playsInline = true;
        const button = document.createElement('button');
        button.dataset.testMediaStart = '';
        button.addEventListener('click', () => {
            audio.play();
            video.play();
        });
        body.append(audio, video, button);
        button.focus();
    }, mediaUrl);
    await page.keyboard.press('Enter');
    await expect.poll(() => desktop.locator('[data-test-independent-audio]').evaluate((audio) => audio.currentTime)).toBeGreaterThan(0);
    await expect.poll(() => desktop.locator('[data-test-independent-video]').evaluate((video) => video.currentTime)).toBeGreaterThan(0);
    const mediaBefore = await desktop.locator('body').evaluate((body) => (
        [...body.querySelectorAll('[data-test-independent-audio], [data-test-independent-video]')].map((media) => ({
            time: media.currentTime, volume: media.volume, muted: media.muted, paused: media.paused,
        }))
    ));

    await sceneAudio.evaluate((button) => button.click());
    await expect.poll(() => page.evaluate(() => window.__sceneAudio.contexts[0].state)).toBe('suspended');
    const taskbarAudio = desktop.locator('[data-audio-toggle]');
    await expect(taskbarAudio).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => desktop.locator('[data-test-independent-audio]').evaluate((audio) => audio.currentTime)).toBeGreaterThan(mediaBefore[0].time + 0.1);
    await taskbarAudio.evaluate((button) => button.click());
    await expect(sceneAudio).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => page.evaluate(() => window.__sceneAudio.contexts[0].state)).toBe('running');
    const mediaAfter = await desktop.locator('body').evaluate((body) => (
        [...body.querySelectorAll('[data-test-independent-audio], [data-test-independent-video]')].map((media) => ({
            time: media.currentTime, volume: media.volume, muted: media.muted, paused: media.paused,
        }))
    ));
    for (let index = 0; index < mediaBefore.length; index += 1) {
        expect(mediaAfter[index].time).toBeGreaterThan(mediaBefore[index].time);
        expect(mediaAfter[index].volume).toBe(mediaBefore[index].volume);
        expect(mediaAfter[index].muted).toBe(mediaBefore[index].muted);
        expect(mediaAfter[index].paused).toBe(false);
    }
    expect(await page.evaluate(() => window.__sceneAudio.errors)).toEqual([]);
});
