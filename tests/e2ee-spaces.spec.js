const setupSyncIntegration = require('./fixtures/sync-integration.cjs');
const harness = setupSyncIntegration();
const { test, expect, siteOrigin, apiOrigin, wireBodies, text, png, openApp, awaitOnline, sendText, readSession, watchSpaceConnections, expandSpaces, selectSpace } = harness;
const { showSyncTools } = require('./fixtures/sync-tools.cjs');

test('switches saved spaces without mixing history, drafts, replies or selected files and restores the active space', async ({ page, isMobile, browserName }, testInfo) => {
    test.setTimeout(60000);
    // Keep this state-isolation test independent of the initial responsive ResizeObserver pass.
    await page.addInitScript(() => localStorage.setItem('portfolio-sync-spaces-collapsed', 'true'));
    const connections = watchSpaceConnections(page);
    const historyRequests = [];
    page.on('request', request => {
        if (request.method() === 'GET' && /\/messages$/.test(new URL(request.url()).pathname)) historyRequests.push(request.url());
    });
    if (browserName === 'chromium') await page.context().grantPermissions(['local-network-access']);
    await page.goto(`${siteOrigin}/chat/`);
    await page.locator('[data-sync-create]').focus();
    await page.locator('[data-sync-create]').press('Enter');
    await awaitOnline(page);
    const first = await readSession(page);
    await page.evaluate(() => localStorage.removeItem('portfolio-sync-spaces-e2ee1'));
    await page.reload();
    await awaitOnline(page);
    expect((await readSession(page)).vaultId).toBe(first.vaultId);
    await expandSpaces(page);
    await expect(page.locator('[data-sync-space-list] [data-sync-space-id]')).toHaveCount(1);
    await expect(page.locator(`[data-sync-space-id="${first.roomId}"]`)).toHaveCount(1);
    await page.locator('[data-sync-spaces-toggle]').click();
    const firstText = 'first-space-private-message';
    const firstDraft = 'first-space-unsent-draft';
    const secondText = 'second-space-private-message';
    const secondDraft = 'second-space-unsent-draft';
    const selected = { name: 'first-space-selected.txt', mimeType: 'text/plain', buffer: Buffer.from('first-space-only-file') };
    await sendText(page, firstText);
    const firstMessage = page.locator('.sync-message').filter({ hasText: firstText });
    await expect(firstMessage).toHaveCount(1);
    await firstMessage.locator('[data-sync-reply-message]').click();
    await page.locator('[data-sync-input]').fill(firstDraft);
    await page.locator('[data-sync-file-input]').setInputFiles(selected);

    await expandSpaces(page);
    await page.locator('[data-sync-add-space]').click();
    await expect(page.locator('[data-sync-setup]')).toBeVisible();
    await page.locator('[data-sync-back-space]').click();
    await expect(page.locator('[data-sync-input]')).toHaveValue(firstDraft);
    await expect(page.locator('[data-sync-reply-text]')).toHaveText(firstText);
    await expect(page.locator('[data-sync-file-name]')).toHaveText(selected.name);
    await expandSpaces(page);
    await page.locator('[data-sync-add-space]').click();
    await page.locator('[data-sync-create]').focus();
    await page.locator('[data-sync-create]').press('Enter');
    await expect.poll(async () => (await readSession(page)).roomId).not.toBe(first.roomId);
    await awaitOnline(page);
    const second = await readSession(page);
    expect(second.roomId).not.toBe(first.roomId);
    expect(second.vaultId).not.toBe(first.vaultId);
    await expect(page.locator('[data-sync-messages]')).not.toContainText(firstText);
    await expect(page.locator('[data-sync-input]')).toHaveValue('');
    await expect(page.locator('[data-sync-reply]')).toBeHidden();
    await expect(page.locator('[data-sync-selected-file]')).toBeHidden();
    await sendText(page, secondText);
    await expect(page.locator('[data-sync-messages]')).toContainText(secondText);
    await page.locator('[data-sync-input]').fill(secondDraft);
    const connected = connections.map(({ roomId, auth, ready }) => ({ roomId, auth, ready }));
    const firstConnection = connections.filter(connection => connection.roomId === first.roomId).at(-1);
    const secondConnection = connections.find(connection => connection.roomId === second.roomId);
    const historyReads = historyRequests.length;
    expect(firstConnection.socket.isClosed()).toBe(false);

    await selectSpace(page, first.roomId);
    expect((await readSession(page)).deviceId).toBe(first.deviceId);
    await expect(page.locator('[data-sync-messages]')).toContainText(firstText);
    await expect(page.locator('[data-sync-messages]')).not.toContainText(secondText);
    await expect(page.locator('[data-sync-input]')).toHaveValue(firstDraft);
    await expect(page.locator('[data-sync-reply-text]')).toHaveText(firstText);
    await expect(page.locator('[data-sync-file-name]')).toHaveText(selected.name);
    await page.locator('[data-sync-remove-file]').click();
    await page.locator('[data-sync-send]').click();
    await expect(page.locator('[data-sync-input]')).toHaveValue('');
    await expect(page.locator('.sync-message').filter({ hasText: firstDraft }).locator('.sync-message-quote-text')).toContainText(firstText);

    await selectSpace(page, second.roomId);
    await expect(page.locator('[data-sync-input]')).toHaveValue(secondDraft);
    await expect(page.locator('[data-sync-messages]')).toContainText(secondText);
    await expect(page.locator('[data-sync-messages]')).not.toContainText(firstDraft);
    expect(connections.map(({ roomId, auth, ready }) => ({ roomId, auth, ready }))).toEqual(connected);
    expect(historyRequests).toHaveLength(historyReads);
    expect(firstConnection.socket.isClosed()).toBe(false);
    expect(secondConnection.socket.isClosed()).toBe(false);
    await page.reload();
    await awaitOnline(page);
    expect((await readSession(page)).roomId).toBe(second.roomId);
    await expect(page.locator('[data-sync-input]')).toHaveValue(secondDraft);
    await expandSpaces(page);
    await expect(page.locator('[data-sync-space-list] [data-sync-space-id]')).toHaveCount(2);
    await expect(page.locator(`[data-sync-space-id="${second.roomId}"]`)).toHaveAttribute('aria-current', 'true');
    await page.screenshot({ path: testInfo.outputPath(`spaces-${isMobile ? 'mobile' : 'desktop'}.png`) });
    const windowBounds = await page.locator('[data-sync-window]').boundingBox();
    const sidebarBounds = await page.locator('[data-sync-spaces-panel]').boundingBox();
    expect(sidebarBounds.x + sidebarBounds.width).toBeLessThanOrEqual(windowBounds.x + windowBounds.width + 1);
    await page.locator('[data-sync-spaces-toggle]').click();
    await expect(page.locator('[data-sync-spaces-toggle]')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('[data-sync-spaces-panel]')).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath(`spaces-collapsed-${isMobile ? 'mobile' : 'desktop'}.png`) });
    const otherTab = await page.context().newPage();
    try {
        await otherTab.goto(`${siteOrigin}/chat/`);
        await awaitOnline(otherTab);
        expect((await readSession(otherTab)).roomId).toBe(second.roomId);
        await selectSpace(page, first.roomId);
        await expect(otherTab.locator('[data-sync-messages]')).toContainText(firstText);
        await expect(otherTab.locator('[data-sync-messages]')).not.toContainText(secondText);
        await selectSpace(page, second.roomId);
        await expect(otherTab.locator('[data-sync-messages]')).toContainText(secondText);
        await expect(page.locator('[data-sync-input]')).toHaveValue(secondDraft);
    } finally { await otherTab.close(); }
    const unchanged = await fetch(`${apiOrigin}/v1/spaces/${first.roomId}/devices`, { headers: { Origin: siteOrigin, Authorization: `Bearer ${first.token}` } });
    expect(unchanged.status).toBe(200);
    for (const secret of [firstDraft, secondDraft, firstText, secondText]) expect(Buffer.concat(wireBodies).includes(Buffer.from(secret))).toBe(false);
});

test('keeps background spaces paired and synchronized through key rotation, clearing and connection loss, then revokes only their own connection', async ({ browser, isMobile }) => {
    test.setTimeout(90000);
    const contexts = await Promise.all(Array.from({ length: 2 }, () => browser.newContext({
        viewport: isMobile ? { width: 320, height: 568 } : { width: 1366, height: 900 }, isMobile, hasTouch: isMobile
    })));
    if (browser.browserType().name() === 'chromium') await Promise.all(contexts.map(context => context.grantPermissions(['local-network-access'])));
    const [owner, peer] = await Promise.all(contexts.map(context => context.newPage()));
    const connections = watchSpaceConnections(owner);
    await owner.addInitScript(() => {
        window.testSpaceSockets = [];
        window.WebSocket = new Proxy(window.WebSocket, {
            construct(Target, args) {
                const socket = Reflect.construct(Target, args);
                window.testSpaceSockets.push(socket);
                return socket;
            }
        });
    });
    try {
        await Promise.all([owner, peer].map(page => page.goto(`${siteOrigin}/chat/`)));
        await owner.locator('[data-sync-create]').click();
        await awaitOnline(owner);
        await expect(owner.locator('[data-sync-pair-code]')).toHaveText(/^\d{4}$/);
        const code = await owner.locator('[data-sync-pair-code]').textContent();
        const first = await readSession(owner);
        await sendText(owner, 'first-space-before-background');
        await expect(owner.locator('.sync-message[data-state="sent"]')).toContainText('first-space-before-background');
        await expandSpaces(owner);
        await owner.locator('[data-sync-add-space]').click();
        await owner.locator('[data-sync-create]').click();
        await expect.poll(async () => (await readSession(owner)).roomId).not.toBe(first.roomId);
        await awaitOnline(owner);
        const second = await readSession(owner);
        await sendText(owner, 'second-space-remains-active');
        await expect(owner.locator('.sync-message[data-state="sent"]')).toContainText('second-space-remains-active');
        const firstConnection = connections.find(connection => connection.roomId === first.roomId);
        const secondConnection = connections.find(connection => connection.roomId === second.roomId);
        const connected = connections.map(({ roomId, auth, ready }) => ({ roomId, auth, ready }));
        expect(firstConnection.socket.isClosed()).toBe(false);

        await peer.locator('[data-sync-code]').fill(code);
        await peer.locator('[data-sync-join]').click();
        await awaitOnline(peer);
        const joined = await readSession(peer);
        expect(joined.roomId).toBe(first.roomId);
        expect(joined.keyring.currentKeyId).not.toBe(first.keyring.currentKeyId);
        await expect.poll(async () => (await readSession(owner, first.roomId)).keyring.currentKeyId).toBe(joined.keyring.currentKeyId);
        expect((await readSession(owner)).roomId).toBe(second.roomId);

        let messageCount = firstConnection.frames.filter(frame => frame.type === 'message').length;
        await sendText(peer, 'first-space-background-message');
        await expect.poll(() => firstConnection.frames.filter(frame => frame.type === 'message').length).toBeGreaterThan(messageCount);
        await expect(owner.locator('[data-sync-messages]')).not.toContainText('first-space-background-message');
        await expect(owner.locator('[data-sync-messages]')).toContainText('second-space-remains-active');
        const backgroundMessageId = firstConnection.frames.filter(frame => frame.type === 'message').at(-1).message.id;
        expect(firstConnection.sent.some(frame => frame.type === 'read' && frame.messageId >= backgroundMessageId)).toBe(false);
        await selectSpace(owner, first.roomId);
        await expect(owner.locator('[data-sync-messages]')).toContainText('first-space-background-message');
        await expect(owner.locator('[data-sync-messages]')).not.toContainText('second-space-remains-active');
        await selectSpace(owner, second.roomId);

        await showSyncTools(peer);
        await peer.locator('[data-sync-clear]').click();
        await peer.locator('[data-sync-confirm-accept]').click();
        await expect.poll(() => firstConnection.frames.some(frame => frame.type === 'cleared')).toBe(true);
        messageCount = firstConnection.frames.filter(frame => frame.type === 'message').length;
        await sendText(peer, 'first-space-after-background-clear');
        await expect.poll(() => firstConnection.frames.filter(frame => frame.type === 'message').length).toBeGreaterThan(messageCount);
        await expect(owner.locator('[data-sync-messages]')).toContainText('second-space-remains-active');
        await expect(owner.locator('[data-sync-messages]')).not.toContainText('first-space-after-background-clear');
        await selectSpace(owner, first.roomId);
        await expect(owner.locator('.sync-message-text')).toHaveText('first-space-after-background-clear');
        expect(connections.map(({ roomId, auth, ready }) => ({ roomId, auth, ready }))).toEqual(connected);
        expect(firstConnection.socket.isClosed()).toBe(false);
        expect(secondConnection.socket.isClosed()).toBe(false);

        await selectSpace(owner, second.roomId);
        await owner.evaluate(roomId => {
            const socket = window.testSpaceSockets.find(socket => new URL(socket.url).pathname === `/v1/spaces/${roomId}/socket`
                && socket.readyState === WebSocket.OPEN);
            socket.close();
        }, first.roomId);
        await expect.poll(() => firstConnection.socket.isClosed()).toBe(true);
        await expect.poll(() => connections.filter(connection => connection.roomId === first.roomId).length).toBe(2);
        const recovered = connections.filter(connection => connection.roomId === first.roomId).at(-1);
        await expect.poll(() => recovered.ready).toBe(1);
        await awaitOnline(owner);
        expect((await readSession(owner)).roomId).toBe(second.roomId);
        expect(connections.filter(connection => connection.roomId === second.roomId)).toHaveLength(1);
        expect(secondConnection.socket.isClosed()).toBe(false);

        await sendText(peer, 'first-space-after-background-reconnect');
        await expect.poll(() => recovered.frames.some(frame => frame.type === 'message')).toBe(true);
        const unreadMessageId = recovered.frames.filter(frame => frame.type === 'message').at(-1).message.id;
        await owner.bringToFront();
        await owner.locator('[data-sync-input]').fill('second-space-unsent-during-background-reconnect');
        await expect(owner.locator('[data-sync-input]')).toHaveValue('second-space-unsent-during-background-reconnect');
        await expect(owner.locator('[data-sync-messages]')).not.toContainText('first-space-after-background-reconnect');
        expect(recovered.sent.some(frame => frame.type === 'read' && frame.messageId >= unreadMessageId)).toBe(false);
        await expect(recovered.socket.waitForEvent('framesent', {
            predicate: ({ payload }) => {
                if (payload.toString() === 'ping') return false;
                const frame = JSON.parse(payload.toString());
                return frame.type === 'read' && frame.messageId >= unreadMessageId;
            },
            timeout: 1000
        })).rejects.toThrow(/Timeout/);
        const reconnected = connections.map(({ roomId, auth, ready }) => ({ roomId, auth, ready }));
        await selectSpace(owner, first.roomId);
        await expect(owner.locator('.sync-message-text')).toHaveText(['first-space-after-background-clear', 'first-space-after-background-reconnect']);
        expect(connections.map(({ roomId, auth, ready }) => ({ roomId, auth, ready }))).toEqual(reconnected);
        expect(recovered.socket.isClosed()).toBe(false);
        await selectSpace(owner, second.roomId);
        await expect(owner.locator('[data-sync-input]')).toHaveValue('second-space-unsent-during-background-reconnect');
        await showSyncTools(peer);
        await peer.locator('[data-sync-devices]').click();
        const ownerDevice = peer.locator(`[data-sync-devices-list] [data-device-id="${first.deviceId}"]`);
        await ownerDevice.locator('[data-sync-device-remove]').click();
        await peer.locator('[data-sync-confirm-accept]').click();
        await expect(ownerDevice).toHaveCount(0, { timeout: 30000 });
        await expect(owner.locator(`[data-sync-space-id="${first.roomId}"]`)).toHaveCount(0);
        await expect(owner.locator(`[data-sync-space-id="${second.roomId}"]`)).toHaveCount(1);
        expect((await readSession(owner)).roomId).toBe(second.roomId);
        await awaitOnline(owner);
        await expect.poll(() => recovered.socket.isClosed()).toBe(true);
        expect(secondConnection.socket.isClosed()).toBe(false);
        expect(connections.map(({ roomId, auth, ready }) => ({ roomId, auth, ready }))).toEqual(reconnected);
        await sendText(owner, 'second-space-after-background-revocation');
        await expect(owner.locator('.sync-message[data-state="sent"]')).toContainText(['second-space-remains-active', 'second-space-after-background-revocation']);
    } finally { await Promise.all(contexts.map(context => context.close())); }
});

test('clears a background space green dot after foreground scrolling and keeps it cleared after switching and reload', async ({ browser, isMobile }) => {
    test.setTimeout(90000);
    const contexts = await Promise.all(Array.from({ length: 2 }, () => browser.newContext({
        viewport: isMobile ? { width: 320, height: 568 } : { width: 1366, height: 900 }, isMobile, hasTouch: isMobile
    })));
    if (browser.browserType().name() === 'chromium') await Promise.all(contexts.map(context => context.grantPermissions(['local-network-access'])));
    const [owner, peer] = await Promise.all(contexts.map(context => context.newPage()));
    const dot = roomId => owner.locator(`[data-sync-space-id="${roomId}"] [data-sync-space-unread]`);
    try {
        await Promise.all([owner, peer].map(page => page.goto(`${siteOrigin}/chat/`)));
        await owner.locator('[data-sync-create]').click();
        await awaitOnline(owner);
        await expect(owner.locator('[data-sync-pair-code]')).toHaveText(/^\d{4}$/);
        const code = await owner.locator('[data-sync-pair-code]').textContent();
        const first = await readSession(owner);
        await expandSpaces(owner);
        await owner.locator('[data-sync-add-space]').click();
        await owner.locator('[data-sync-create]').click();
        await expect.poll(async () => (await readSession(owner)).roomId).not.toBe(first.roomId);
        await awaitOnline(owner);
        const second = await readSession(owner);

        await peer.locator('[data-sync-code]').fill(code);
        await peer.locator('[data-sync-join]').click();
        await awaitOnline(peer);
        await expandSpaces(owner);
        await expect(dot(first.roomId)).toBeHidden();
        await expect(owner.locator('[data-sync-spaces-toggle]')).not.toHaveClass(/has-unread/);

        await sendText(peer, 'background-space-unread');
        await expect(dot(first.roomId)).toBeVisible();
        await expect(dot(second.roomId)).toBeHidden();
        await expect(owner.locator(`[data-sync-space-id="${first.roomId}"]`)).toHaveAttribute('title', /新消息|new messages/);
        await expect(owner.locator('[data-sync-spaces-toggle]')).toHaveClass(/has-unread/);

        await selectSpace(owner, first.roomId);
        await expect(owner.locator('[data-sync-messages]')).toContainText('background-space-unread');
        await owner.bringToFront();
        if (await owner.locator('[data-sync-spaces-toggle]').getAttribute('aria-expanded') === 'true') await owner.locator('[data-sync-spaces-toggle]').click();
        await owner.locator('[data-sync-feed]').focus();
        await owner.locator('[data-sync-feed]').press('ArrowUp');
        await expect(peer.locator('.sync-message.is-own .sync-message-read')).toHaveAttribute('data-state', 'read');
        await selectSpace(owner, second.roomId);
        await expandSpaces(owner);
        await expect(dot(first.roomId)).toBeHidden();
        await expect(dot(second.roomId)).toBeHidden();
        await expect(owner.locator('[data-sync-spaces-toggle]')).not.toHaveClass(/has-unread/);
        await owner.reload();
        await awaitOnline(owner);
        await expandSpaces(owner);
        await expect(dot(first.roomId)).toBeHidden();
        await sendText(peer, 'new-unread-after-scroll');
        await expect(dot(first.roomId)).toBeVisible();
    } finally { await Promise.all(contexts.map(context => context.close())); }
});

test('restores every retained space connection after closing and reopening the app without losing the active draft', async ({ browser, isMobile }) => {
    test.setTimeout(60000);
    const contexts = await Promise.all(Array.from({ length: 2 }, () => browser.newContext({
        viewport: isMobile ? { width: 320, height: 568 } : { width: 1366, height: 900 }, isMobile, hasTouch: isMobile
    })));
    if (browser.browserType().name() === 'chromium') await Promise.all(contexts.map(context => context.grantPermissions(['local-network-access'])));
    const [owner, peer] = await Promise.all(contexts.map(context => context.newPage()));
    const connections = watchSpaceConnections(owner);
    const draft = 'second-space-draft-survives-app-close';
    try {
        await Promise.all([openApp(owner), peer.goto(`${siteOrigin}/chat/`)]);
        await owner.locator('[data-sync-create]').click();
        await awaitOnline(owner);
        await expect(owner.locator('[data-sync-pair-code]')).toHaveText(/^\d{4}$/);
        await peer.locator('[data-sync-code]').fill(await owner.locator('[data-sync-pair-code]').textContent());
        await peer.locator('[data-sync-join]').click();
        await awaitOnline(peer);
        const joined = await readSession(peer);
        await expect.poll(async () => (await readSession(owner)).keyring.currentKeyId).toBe(joined.keyring.currentKeyId);
        const first = await readSession(owner);
        await sendText(peer, 'first-space-before-app-close');
        await expect(owner.locator('[data-sync-messages]')).toContainText('first-space-before-app-close');
        await expandSpaces(owner);
        await owner.locator('[data-sync-add-space]').click();
        await owner.locator('[data-sync-create]').click();
        await expect.poll(async () => (await readSession(owner)).roomId).not.toBe(first.roomId);
        await awaitOnline(owner);
        const second = await readSession(owner);
        await sendText(owner, 'second-space-before-app-close');
        await expect(owner.locator('.sync-message[data-state="sent"]')).toContainText('second-space-before-app-close');
        await owner.locator('[data-sync-input]').fill(draft);
        expect(connections).toHaveLength(2);
        const originalConnections = [...connections];

        await owner.locator('[data-sync-action="close"]').click();
        await expect(owner.locator('[data-sync-window]')).toBeHidden();
        await expect.poll(() => originalConnections.every(connection => connection.socket.isClosed())).toBe(true);
        await sendText(peer, 'first-space-during-app-close');
        await expect(peer.locator('.sync-message[data-state="sent"] .sync-message-text')).toHaveText([
            'first-space-before-app-close', 'first-space-during-app-close'
        ]);

        await owner.locator('.desktop-shortcut[data-open-sync-space]').click();
        await awaitOnline(owner);
        await expect.poll(() => connections.filter(connection => connection.roomId === first.roomId).length).toBe(2);
        await expect.poll(() => connections.filter(connection => connection.roomId === second.roomId).length).toBe(2);
        const resumedFirst = connections.filter(connection => connection.roomId === first.roomId).at(-1);
        const resumedSecond = connections.filter(connection => connection.roomId === second.roomId).at(-1);
        await expect.poll(() => resumedFirst.ready).toBe(1);
        await expect.poll(() => resumedSecond.ready).toBe(1);
        expect(resumedFirst.auth).toBe(1);
        expect(resumedSecond.auth).toBe(1);
        expect((await readSession(owner)).roomId).toBe(second.roomId);
        await expect(owner.locator('[data-sync-input]')).toHaveValue(draft);
        await expect(owner.locator('.sync-message-text')).toHaveText('second-space-before-app-close');

        await sendText(peer, 'first-space-after-app-reopen');
        await expect.poll(() => resumedFirst.frames.some(frame => frame.type === 'message')).toBe(true);
        await expect(owner.locator('[data-sync-messages]')).not.toContainText('first-space-after-app-reopen');
        await selectSpace(owner, first.roomId);
        await expect(owner.locator('.sync-message-text')).toHaveText([
            'first-space-before-app-close', 'first-space-during-app-close', 'first-space-after-app-reopen'
        ]);
        await selectSpace(owner, second.roomId);
        await expect(owner.locator('[data-sync-input]')).toHaveValue(draft);
        await expect(owner.locator('.sync-message-text')).toHaveText('second-space-before-app-close');
        expect(connections).toHaveLength(4);
        expect(resumedFirst.socket.isClosed()).toBe(false);
        expect(resumedSecond.socket.isClosed()).toBe(false);
    } finally { await Promise.all(contexts.map(context => context.close())); }
});

test('keeps both spaces created concurrently by two empty tabs and follows their shared active selection', async ({ page, browserName }) => {
    test.setTimeout(60000);
    if (browserName === 'chromium') await page.context().grantPermissions(['local-network-access']);
    const other = await page.context().newPage();
    const created = [];
    let requests = 0;
    let releaseRequests;
    const ready = new Promise(resolve => { releaseRequests = resolve; });
    harness.interceptApi = async (request, forward) => {
        if (request.method !== 'POST' || new URL(request.url).pathname !== '/v1/spaces') return;
        requests++;
        if (requests === 2) releaseRequests();
        await ready;
        const response = await forward();
        created.push(await response.clone().json());
        return response;
    };
    try {
        await Promise.all([page, other].map(tab => tab.goto(`${siteOrigin}/chat/`)));
        await Promise.all([page, other].map(tab => tab.locator('[data-sync-create]').click()));
        await expect.poll(() => created.length).toBe(2);
        const roomIds = created.map(session => session.roomId).sort();
        expect(new Set(roomIds).size).toBe(2);
        await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('portfolio-sync-spaces-e2ee1') || '[]').map(space => space.roomId).sort())).toEqual(roomIds);
        await Promise.all([page, other].map(awaitOnline));
        await Promise.all([page, other].map(tab => expect(tab.locator('[data-sync-add-space]')).toBeEnabled()));
        const activeId = (await readSession(page)).roomId;
        await Promise.all([page, other].map(tab => expect(tab.locator(`[data-sync-space-id="${activeId}"]`)).toHaveAttribute('aria-current', 'true')));
        await selectSpace(page, roomIds[0]);
        await expect(other.locator(`[data-sync-space-id="${roomIds[0]}"]`)).toHaveAttribute('aria-current', 'true');
        await sendText(page, 'concurrent-space-one-message');
        await expect(other.locator('[data-sync-messages]')).toContainText('concurrent-space-one-message');
        await selectSpace(other, roomIds[1]);
        await expect(page.locator(`[data-sync-space-id="${roomIds[1]}"]`)).toHaveAttribute('aria-current', 'true');
        await sendText(other, 'concurrent-space-two-message');
        await expect(page.locator('[data-sync-messages]')).toContainText('concurrent-space-two-message');
        await expect(page.locator('[data-sync-messages]')).not.toContainText('concurrent-space-one-message');
        await selectSpace(page, roomIds[0]);
        await expect(page.locator('[data-sync-messages]')).toContainText('concurrent-space-one-message');
        await expect(other.locator('[data-sync-messages]')).toContainText('concurrent-space-one-message');
        await expect(other.locator('[data-sync-messages]')).not.toContainText('concurrent-space-two-message');
        expect(requests).toBe(2);
        await expect(page.locator('[data-sync-space-list] [data-sync-space-id]')).toHaveCount(2);
        await expect(other.locator('[data-sync-space-list] [data-sync-space-id]')).toHaveCount(2);
    } finally {
        releaseRequests();
        await other.close();
    }
});


test('a notification deep link opens its saved space after the original tab closes', async ({ page, context, browserName }) => {
    if (browserName === 'chromium') await context.grantPermissions(['local-network-access']);
    await page.goto(`${siteOrigin}/chat/`);
    await page.locator('[data-sync-create]').click();
    await awaitOnline(page);
    const first = await readSession(page);
    await sendText(page, 'Notification target room');
    await expect(page.locator('.sync-message[data-state="sent"]')).toContainText('Notification target room');
    await expandSpaces(page);
    await page.locator('[data-sync-add-space]').click();
    await page.locator('[data-sync-create]').click();
    await expect.poll(async () => (await readSession(page)).roomId).not.toBe(first.roomId);
    await awaitOnline(page);
    await sendText(page, 'Last selected room');
    await expect(page.locator('.sync-message[data-state="sent"]')).toContainText('Last selected room');
    const reopened = await context.newPage();
    await page.close();
    await reopened.goto(`${siteOrigin}/chat/#space=${first.roomId}`);
    await expect.poll(async () => (await readSession(reopened)).roomId).toBe(first.roomId);
    await expect(reopened.locator('[data-sync-messages]')).toContainText('Notification target room');
    await expect(reopened.locator('[data-sync-messages]')).not.toContainText('Last selected room');
    expect(new URL(reopened.url()).hash).toBe('');
    await reopened.close();
});
