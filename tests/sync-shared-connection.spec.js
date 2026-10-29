const { test, expect } = require('@playwright/test');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

test.use({ serviceWorkers: 'block' });

test('shares ordered frames and reads, isolates rooms, reconnects and transfers the socket when its owner closes', async ({ page, context }) => {
    await context.route('**/__shared-connection__/**', async route => {
        const filename = new URL(route.request().url()).pathname.split('/').at(-1);
        if (!filename) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Shared connection</title>' });
        return route.fulfill({ contentType: 'text/javascript', body: await readFile(path.join(__dirname, '../static/portfolio/js/apps', filename)) });
    });
    const sockets = [];
    const reads = [];
    let number = 0;
    await context.routeWebSocket('ws://127.0.0.1:3090/__socket__/**', socket => {
        const entry = { socket, room: new URL(socket.url()).pathname.split('/').at(-1), number: ++number };
        sockets.push(entry);
        socket.onMessage(raw => {
            if (raw === 'ping') return socket.send('pong');
            const frame = JSON.parse(raw);
            if (frame.type === 'auth') socket.send(JSON.stringify({ type: 'ready', messages: [entry.number] }));
            else reads.push({ room: entry.room, ...frame });
        });
    });
    const mount = async (page, room = 'room') => {
        await page.goto('/__shared-connection__/');
        await page.evaluate(async room => {
            const { SharedSyncConnection } = await import('./sync-shared-connection.js');
            window.received = [];
            window.connection = new SharedSyncConnection({
                session: { roomId: room, token: 'same-device' },
                getUrl: () => `ws://${location.host}/__socket__/${room}`,
                receive: async (data, current) => {
                    if (window.stallNext) {
                        window.stallNext = false;
                        await new Promise(resolve => { window.releaseStalled = resolve; });
                    }
                    if (!current()) return;
                    if (data.type === 'ready') window.received = data.messages;
                    else window.received.push(data.id);
                },
                snapshot: () => ({ type: 'ready', messages: window.received }),
                onState: state => { window.connectionState = state; },
                onClose: () => {},
                onError: error => { window.error = error.message; }
            });
            window.connection.connect();
        }, room);
        await expect.poll(() => page.evaluate(() => window.connectionState)).toBe('online');
    };
    await mount(page);
    const follower = await context.newPage();
    await mount(follower);
    expect(sockets).toHaveLength(1);
    await expect.poll(() => follower.evaluate(() => window.received)).toEqual([1]);
    sockets[0].socket.send(JSON.stringify({ type: 'message', id: 10 }));
    sockets[0].socket.send(JSON.stringify({ type: 'message', id: 11 }));
    await expect.poll(() => follower.evaluate(() => window.received)).toEqual([1, 10, 11]);
    await follower.evaluate(() => window.connection.socket.send(JSON.stringify({ type: 'read', messageId: 11 })));
    await expect.poll(() => reads).toEqual([{ room: 'room', type: 'read', messageId: 11 }]);
    const otherRoom = await context.newPage();
    await mount(otherRoom, 'other-room');
    expect(sockets).toHaveLength(2);
    await follower.evaluate(() => { window.stallNext = true; });
    sockets[0].socket.send(JSON.stringify({ type: 'message', id: 12 }));
    await follower.waitForFunction(() => typeof window.releaseStalled === 'function');
    expect(await otherRoom.evaluate(() => window.received)).toEqual([2]);
    await follower.evaluate(() => window.connection.socket.close());
    await expect.poll(() => sockets.length).toBe(3);
    await expect.poll(() => follower.evaluate(() => window.received)).toEqual([3]);
    await follower.evaluate(() => window.releaseStalled());
    expect(await follower.evaluate(() => window.received)).toEqual([3]);
    await page.close();
    await expect.poll(() => sockets.length).toBe(4);
    await expect.poll(() => follower.evaluate(() => window.connectionState)).toBe('online');
    sockets[3].socket.send(JSON.stringify({ type: 'message', id: 20 }));
    await expect.poll(() => follower.evaluate(() => window.received)).toEqual([4, 20]);
    expect(await follower.evaluate(() => window.error)).toBeUndefined();
    expect(await otherRoom.evaluate(() => window.received)).toEqual([2]);
});
