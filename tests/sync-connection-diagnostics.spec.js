const { test, expect } = require('@playwright/test');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

test.use({ serviceWorkers: 'block' });

test('diagnoses shared connections and reconnection without exposing identifiers or counting the owner twice', async ({ page, context }) => {
    await context.route('**/__connection-diagnostics__/**', async route => {
        const filename = new URL(route.request().url()).pathname.split('/').at(-1);
        return route.fulfill({ contentType: filename ? 'text/javascript' : 'text/html', body: filename
            ? await readFile(path.join(__dirname, '../static/portfolio/js/apps', filename)) : '<!doctype html>' });
    });
    const sockets = [];
    await context.routeWebSocket(/\/__diagnostic-socket__$/, socket => {
        sockets.push(socket);
        socket.onMessage(raw => {
            if (raw === 'ping') return socket.send('pong');
            if (JSON.parse(raw).type === 'auth') socket.send(JSON.stringify({ type: 'ready', text: 'secret-message' }));
        });
    });
    const mount = async tab => {
        await tab.goto('/__connection-diagnostics__/');
        await tab.evaluate(async () => {
            const { SharedSyncConnection } = await import('./sync-shared-connection.js');
            const { getConnectionDiagnostics } = await import('./sync-connection-diagnostics.js');
            window.diagnostics = getConnectionDiagnostics;
            window.updates = 0;
            window.addEventListener('sync-diagnostics-change', () => updates++);
            window.connection = new SharedSyncConnection({
                session: { roomId: 'secret-room', token: 'secret-token', deviceId: 'secret-device' },
                getUrl: () => `ws://${location.host}/__diagnostic-socket__`,
                receive: () => {}, onState: () => {}, onClose: () => {},
                snapshot: () => ({ type: 'ready', text: 'secret-message' })
            });
            connection.connect();
        });
        await expect.poll(() => tab.evaluate(() => diagnostics().connections.online)).toBe(1);
    };
    await mount(page);
    const follower = await context.newPage();
    await mount(follower);
    expect(sockets).toHaveLength(1);
    expect(await page.evaluate(() => diagnostics().connections)).toEqual({ online: 1, connecting: 0, offline: 0, shared: 0 });
    expect(await follower.evaluate(() => diagnostics().connections)).toEqual({ online: 1, connecting: 0, offline: 0, shared: 1 });
    sockets[0].close({ code: 1012, reason: 'secret-server-reason' });
    await expect.poll(() => sockets.length).toBe(2);
    await expect.poll(() => follower.evaluate(() => diagnostics().connections.online)).toBe(1);
    const snapshot = await follower.evaluate(() => diagnostics());
    expect(snapshot.reconnects).toBe(1);
    expect(snapshot.lastConnectedAt).toBeGreaterThan(0);
    expect(snapshot.lastConnectMs).toBeGreaterThanOrEqual(0);
    expect(snapshot.events.map(event => event.status)).toContain('offline');
    expect(JSON.stringify(snapshot)).not.toMatch(/secret|__diagnostic|token|roomId|deviceId/);
    expect(await follower.evaluate(() => updates)).toBeGreaterThan(2);
    await follower.evaluate(() => connection.close());
    expect(await follower.evaluate(() => diagnostics().connections)).toEqual({ online: 0, connecting: 0, offline: 0, shared: 0 });
    await page.evaluate(() => connection.close());
});
