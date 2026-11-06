const { test, expect, authorize, startSite, profile, deviceId, keyId } = require('./fixtures/sync-e2ee.cjs');
const { createServer } = require('node:http');

test.use({ serviceWorkers: 'block' });

for (const [code, storageFirst] of [[4001, false], [4004, false], [4004, true]]) {
    test(`shared tabs distinguish room expiry from device removal (${code}, storage first: ${storageFirst})`, async ({ page, context, browserName }) => {
        const server = createServer((request, response) => {
            response.writeHead(request.method === 'OPTIONS' ? 204 : 200, {
                'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Sync-Key-Id'
            });
            response.end(request.method === 'OPTIONS' ? '' : JSON.stringify({ deviceId, devices: [profile()], keyId, grants: [], hasMore: false, requests: [] }));
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const apiBase = `http://127.0.0.1:${server.address().port}`;
        const site = await startSite(apiBase);
        const sockets = [];
        if (browserName === 'chromium') await context.grantPermissions(['local-network-access']);
        await context.routeWebSocket(`${apiBase.replace('http:', 'ws:')}/**`, socket => {
            sockets.push(socket);
            socket.onMessage(raw => {
                if (raw === 'ping') return socket.send('pong');
                if (JSON.parse(raw).type === 'auth') socket.send(JSON.stringify({ type: 'ready', deviceId, messages: [], pairing: null }));
            });
        });
        try {
            await authorize(page, `${site.origin}/chat/`);
            await page.reload();
            await expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
            const follower = await context.newPage();
            if (storageFirst) await follower.addInitScript(() => {
                const NativeChannel = window.BroadcastChannel;
                window.BroadcastChannel = class extends NativeChannel {
                    set onmessage(listener) {
                        super.onmessage = event => {
                            if (event.data?.type !== 'closed') listener.call(this, event);
                        };
                    }
                };
            });
            await follower.goto(`${site.origin}/chat/`);
            await expect(follower.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
            expect(sockets).toHaveLength(1);
            await sockets[0].close({ code, reason: code === 4004 ? 'Space expired' : 'Device removed' });
            for (const tab of [page, follower]) {
                await expect(tab.locator('[data-sync-setup]')).toBeVisible();
                await expect(tab.locator('[data-sync-notice]')).toHaveAttribute('data-i18n', code === 4004 ? 'syncSpaceExpired' : 'syncRejoin');
            }
        } finally {
            await context.close();
            await site.close();
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        }
    });
}
