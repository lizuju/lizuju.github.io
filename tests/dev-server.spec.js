const { test, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

test('serves development pages and reloads them when static assets or the shell template change', async ({ page, isMobile }) => {
    test.skip(isMobile, 'the development server runs once per desktop browser engine');
    test.setTimeout(60000);

    const rootDirectory = path.resolve(__dirname, '..');
    const marker = `dev-server-regression-${randomUUID()}`;
    const assetName = `${marker}.txt`;
    const assetPath = path.join(rootDirectory, 'static', assetName);
    const templatePath = path.join(rootDirectory, 'src', 'index.html');
    const originalTemplate = await fs.readFile(templatePath);
    let assetCreated = false;
    let templateChanged = false;
    let serverOutput = '';
    const server = spawn(process.execPath, ['scripts/dev-server.cjs'], {
        cwd: rootDirectory,
        env: { ...process.env, CI: '1' },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    const serverStopped = new Promise((resolve) => server.once('close', resolve));

    try {
        const address = await new Promise((resolve, reject) => {
            const startupTimer = setTimeout(() => {
                reject(new Error(`Development server did not start:\n${serverOutput.slice(-2000)}`));
            }, 15000);
            server.stdout.on('data', (chunk) => {
                serverOutput += chunk.toString();
                const match = serverOutput.match(/http:\/\/127\.0\.0\.1:\d+/);
                if (match) {
                    clearTimeout(startupTimer);
                    resolve(match[0]);
                }
            });
            server.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });
            server.once('error', (error) => {
                clearTimeout(startupTimer);
                reject(error);
            });
            server.once('exit', (code) => {
                clearTimeout(startupTimer);
                reject(new Error(`Development server exited with ${code}:\n${serverOutput.slice(-2000)}`));
            });
        });

        for (const route of ['/', '/portfolio/']) {
            const response = await page.request.get(`${address}${route}`);
            expect(response.status()).toBe(200);
            const html = await response.text();
            expect(html).toContain('/__webpack_hmr');
            expect(html).toContain('reload-all');
        }
        const invalidHost = await page.request.get(`${address}/`, {
            headers: { Host: 'invalid.example' }
        });
        expect(invalidHost.status()).toBe(403);
        const missing = await page.request.get(`${address}/${marker}-missing`);
        expect(missing.status()).toBe(404);

        await page.addInitScript(() => {
            window.EventSource = new Proxy(window.EventSource, {
                construct(Source, args) {
                    const source = new Source(...args);
                    window.__devReloadSource = source;
                    return source;
                }
            });
        });
        await page.goto(`${address}/portfolio/`);
        await expect(page.locator('[data-app-window]')).toBeVisible();
        await expect.poll(() => page.evaluate(() => (
            window.__devReloadSource?.readyState === EventSource.OPEN
        ))).toBe(true);

        const assetReload = page.waitForEvent('framenavigated', {
            predicate: (frame) => frame === page.mainFrame(),
            timeout: 15000
        });
        await fs.writeFile(assetPath, marker, { flag: 'wx' });
        assetCreated = true;
        await assetReload;
        await expect(page.locator('[data-app-window]')).toBeVisible();
        expect(await page.evaluate(() => performance.getEntriesByType('navigation')[0].type)).toBe('reload');
        const asset = await page.request.get(`${address}/${assetName}`);
        expect(asset.status()).toBe(200);
        expect(await asset.text()).toBe(marker);

        await expect.poll(() => page.evaluate(() => (
            window.__devReloadSource?.readyState === EventSource.OPEN
        ))).toBe(true);
        const templateReload = page.waitForEvent('framenavigated', {
            predicate: (frame) => frame === page.mainFrame(),
            timeout: 15000
        });
        const comment = `<!--! ${marker} -->`;
        templateChanged = true;
        await fs.writeFile(templatePath, originalTemplate.toString().replace('</body>', `${comment}</body>`));
        await templateReload;
        await expect(page.locator('[data-app-window]')).toBeVisible();
        expect(await page.evaluate(() => performance.getEntriesByType('navigation')[0].type)).toBe('reload');
        const updatedShell = await page.request.get(`${address}/`);
        expect(updatedShell.status()).toBe(200);
        expect(await updatedShell.text()).toContain(comment);
    } finally {
        await page.close();
        if (server.pid && server.exitCode === null && server.signalCode === null) {
            server.kill('SIGTERM');
            const forceKillTimer = setTimeout(() => server.kill('SIGKILL'), 3000);
            await serverStopped;
            clearTimeout(forceKillTimer);
        }
        if (templateChanged) await fs.writeFile(templatePath, originalTemplate);
        if (assetCreated) await fs.rm(assetPath);
    }
});
