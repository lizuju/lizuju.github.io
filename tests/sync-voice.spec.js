const { test, expect, roomId, deviceId, otherId, keyId, session, authorize, message, profile, file, startSite } = require('./fixtures/sync-e2ee.cjs');
const { createServer } = require('node:http');
const { createDecipheriv } = require('node:crypto');
const { readFile } = require('node:fs/promises');

const wav = (seconds = 4) => {
    const samples = 16000 * seconds;
    const bytes = Buffer.alloc(44 + samples * 2);
    bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
    bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
    bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
    bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
    for (let index = 0; index < samples; index++) bytes.writeInt16LE(Math.round(Math.sin(index * Math.PI / 40) * 3000), 44 + index * 2);
    return bytes;
};
const openCipher = (key, iv, aad, encrypted) => {
    const decrypt = createDecipheriv('aes-256-gcm', key, iv);
    decrypt.setAAD(Buffer.from(aad));
    decrypt.setAuthTag(encrypted.subarray(-16));
    return Buffer.concat([decrypt.update(encrypted.subarray(0, -16)), decrypt.final()]);
};
const payload = body => {
    const envelope = JSON.parse(Buffer.from(body.text.slice(6), 'base64url'));
    return JSON.parse(openCipher(Buffer.from(session.keyring.keys[envelope.keyId], 'base64url'), Buffer.from(envelope.iv, 'base64url'),
        `gavin-sync-v1:${roomId}:message:${deviceId}:${body.clientId}`, Buffer.from(envelope.ciphertext, 'base64url')));
};
let site;
let api;
let apiBase;
let history;
let sockets;
let uploads;
let tickets;
let downloads;
let failTicket;
let holdTicket;
let releaseTicket;
let attachments;

test.beforeEach(async ({ page }) => {
    history = [];
    sockets = [];
    uploads = [];
    tickets = [];
    downloads = [];
    failTicket = false;
    holdTicket = false;
    attachments = [file('voice-first.wav', 'audio/wav', wav()), file('voice-second.wav', 'audio/wav', wav())];
    attachments.forEach(attachment => Object.assign(attachment.metadata, { kind: 'voice', durationMs: 4000 }));
    const headers = {
        'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Sync-Key-Id, Range',
        'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS', 'Access-Control-Expose-Headers': 'Content-Range, Content-Length'
    };
    api = createServer(async (request, response) => {
        const pathname = new URL(request.url, 'http://localhost').pathname;
        const json = (value, status = 200) => { response.writeHead(status, { ...headers, 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
        if (request.method === 'OPTIONS') { response.writeHead(204, headers); response.end(); return; }
        if (pathname.endsWith('/key-grants')) return json({ grants: [], hasMore: false, keyId });
        if (pathname.endsWith('/devices')) return json({ deviceId, devices: [profile('Local'), profile('Paired', otherId)] });
        if (pathname.endsWith('/files/uploads') && request.method === 'POST') {
            let raw = '';
            for await (const chunk of request) raw += chunk;
            uploads.push({ body: JSON.parse(raw), bytes: Buffer.alloc(0) });
            return json({ uploadId: 'recording-upload', receivedBytes: 0, chunkSize: 8 * 1024 * 1024 });
        }
        if (pathname.endsWith('/chunks/0') && request.method === 'PUT') {
            const chunks = [];
            for await (const chunk of request) chunks.push(chunk);
            uploads.at(-1).bytes = Buffer.concat(chunks);
            return json({ receivedBytes: uploads.at(-1).bytes.length });
        }
        if (pathname.endsWith('/recording-upload/complete')) {
            const body = uploads.at(-1).body;
            const sent = { id: history.length + 1, clientId: body.clientId, deviceId, text: body.text, createdAt: Date.now() };
            history.push(sent);
            sockets.at(-1).send(JSON.stringify({ type: 'message', message: sent }));
            return json(sent);
        }
        const ticket = /\/files\/(\d+)\/download$/.exec(pathname);
        if (ticket) {
            const id = Number(ticket[1]);
            tickets.push(id);
            if (failTicket) { failTicket = false; return json({ error: 'unavailable' }, 503); }
            if (holdTicket) await new Promise(resolve => { releaseTicket = resolve; });
            return json({ ticket: String(id).padStart(64, '0'), expiresAt: Date.now() + 86400000 });
        }
        const download = /\/downloads\/(\d+)$/.exec(pathname);
        if (download) {
            const id = Number(download[1]);
            const encrypted = attachments[id - 1]?.bytes;
            if (encrypted) {
                if (request.method === 'GET') downloads.push(id);
                const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range || '');
                const start = range ? Number(range[1]) : 0;
                const end = range ? Math.min(Number(range[2]), encrypted.length - 1) : encrypted.length - 1;
                const body = encrypted.subarray(start, end + 1);
                response.writeHead(range ? 206 : 200, { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': body.length,
                    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${encrypted.length}` } : {}) });
                response.end(request.method === 'HEAD' ? undefined : body);
                return;
            }
        }
        response.writeHead(404, headers); response.end();
    });
    await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
    apiBase = `http://127.0.0.1:${api.address().port}`;
    site = await startSite(apiBase);
    await page.addInitScript(() => {
        const state = window.voiceMock = { mode: 'allow', sampleCount: 8000, tracks: [], contexts: [], nodes: [], modules: [], created: [], revoked: [], closes: 0 };
        const stream = () => {
            const track = new EventTarget();
            track.readyState = 'live';
            track.stop = () => { track.readyState = 'ended'; };
            state.tracks.push(track);
            return { getTracks: () => [track] };
        };
        Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
            getUserMedia: async () => {
                if (state.mode === 'denied') throw new DOMException('Microphone denied', 'NotAllowedError');
                if (state.mode === 'pending') return new Promise(resolve => { state.allow = () => resolve(stream()); });
                return stream();
            }
        } });
        window.AudioContext = class {
            constructor() {
                this.state = 'suspended'; this.destination = {}; this.closed = 0;
                this.audioWorklet = { addModule: async url => { state.modules.push(String(url)); } };
                state.contexts.push(this);
            }
            async resume() { this.state = 'running'; }
            async close() { this.closed++; this.state = 'closed'; }
            createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
        };
        window.AudioWorkletNode = class {
            constructor() {
                this.port = { closed: false,
                    postMessage: data => {
                        if (data.type !== 'stop') return;
                        queueMicrotask(() => {
                            this.port.onmessage?.({ data: { type: 'samples', samples: new Float32Array(state.sampleCount).fill(0.125) } });
                            this.port.onmessage?.({ data: { type: 'stopped' } });
                        });
                    },
                    close() { this.closed = true; }
                };
                state.nodes.push(this);
            }
            connect() {}
            disconnect() {}
        };
        const create = URL.createObjectURL.bind(URL);
        URL.createObjectURL = blob => { const url = create(blob); state.created.push({ url, blob }); return url; };
        const revoke = URL.revokeObjectURL.bind(URL);
        URL.revokeObjectURL = url => { state.revoked.push(url); revoke(url); };
        const post = ServiceWorker.prototype.postMessage;
        ServiceWorker.prototype.postMessage = function (data, ...rest) {
            if (data?.source === 'gavin-sync-e2ee' && data.type === 'close') state.closes++;
            return post.call(this, data, ...rest);
        };
    });
    await page.routeWebSocket(`${apiBase.replace('http:', 'ws:')}/**`, socket => {
        sockets.push(socket);
        socket.onMessage(raw => {
            if (raw === 'ping') return socket.send('pong');
            if (JSON.parse(raw).type === 'auth') socket.send(JSON.stringify({
                type: 'ready', deviceId, pairing: null, messages: history, historyMode: 'replace', readReceipts: [],
                history: { generation: '1', oldestId: history.length ? 1 : null, latestId: history.at(-1)?.id || null, continuationId: history.at(-1)?.id || null, hasMore: false, hasNewer: false }
            }));
        });
    });
});

test.afterEach(async () => {
    releaseTicket?.();
    releaseTicket = null;
    await site?.close();
    if (api) { api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); }
});

const openChat = async (page, desktop = false) => {
    await authorize(page, `${site.origin}/portfolio/`);
    await page.goto(`${site.origin}/portfolio/${desktop ? '' : 'chat/'}`);
    if (desktop) {
        if (await page.locator('[data-window-action="minimize"]').isVisible()) await page.locator('[data-window-action="minimize"]').click();
        await page.locator('.desktop-shortcut[data-open-sync-space]').click();
    }
    await page.bringToFront();
    await expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
};
const startRecording = async page => {
    await page.locator('[data-sync-voice-record]').click();
    await expect(page.locator('[data-sync-voice-stop]')).toBeEnabled();
    await expect(page.locator('[data-sync-voice-recording]')).toBeVisible();
};
const microphoneReleased = page => expect.poll(() => page.evaluate(() => window.voiceMock.tracks.every(track => track.readyState === 'ended')
    && window.voiceMock.contexts.every(context => context.state === 'closed' && context.closed === 1))).toBe(true);

test('records a real WAV for local review and sends only encrypted bytes and voice metadata on explicit send', async ({ page }) => {
    await openChat(page);
    await page.locator('[data-sync-input]').fill('Voice caption remains until sent');
    await startRecording(page);
    await expect(page.locator('[data-sync-send]')).toBeDisabled();
    await expect(page.locator('[data-sync-attach]')).toBeDisabled();
    await page.locator('[data-sync-voice-stop]').click();
    const preview = page.locator('[data-sync-voice-preview]');
    await expect(preview).toBeVisible();
    await expect(preview).toHaveJSProperty('paused', true);
    await microphoneReleased(page);
    await expect(page.locator('[data-sync-input]')).toHaveValue('Voice caption remains until sent');
    expect(uploads).toHaveLength(0);
    const recorded = Buffer.from(await preview.evaluate(async audio => Array.from(new Uint8Array(await window.voiceMock.created.find(entry => entry.url === audio.src).blob.arrayBuffer()))));
    expect(recorded.toString('ascii', 0, 4)).toBe('RIFF');
    expect(recorded.toString('ascii', 8, 16)).toBe('WAVEfmt ');
    expect([recorded.readUInt16LE(20), recorded.readUInt16LE(22), recorded.readUInt32LE(24), recorded.readUInt16LE(34)]).toEqual([1, 1, 16000, 16]);
    expect(recorded.length).toBe(44 + 8000 * 2);
    await preview.evaluate(async audio => { audio.muted = true; await audio.play(); audio.pause(); });
    await page.locator('[data-sync-send]').click();
    await expect(page.locator('.sync-message.is-own[data-state="sent"]')).toHaveCount(1);
    expect(uploads).toHaveLength(1);
    const upload = uploads[0];
    expect(upload.body.type).toBe('application/octet-stream');
    expect(upload.body.name).not.toContain('.wav');
    expect(upload.body).not.toHaveProperty('durationMs');
    expect(upload.body).not.toHaveProperty('kind');
    expect(JSON.stringify(upload.body)).not.toContain('Voice caption');
    const clear = payload(upload.body);
    expect(clear.text).toBe('Voice caption remains until sent');
    expect(clear.attachment).toMatchObject({ type: 'audio/wav', kind: 'voice', durationMs: 500, size: recorded.length });
    const nonce = Buffer.concat([Buffer.from(clear.attachment.noncePrefix, 'base64url'), Buffer.alloc(4)]);
    expect(openCipher(Buffer.from(clear.attachment.key, 'base64url'), nonce, `gavin-sync-file-v1:${clear.attachment.fileId}:0`, upload.bytes)).toEqual(recorded);
    expect(upload.bytes).not.toEqual(recorded);
    await expect(preview).toBeHidden();
    await expect(page.locator('.sync-voice-message')).toHaveCount(1);
});

test('handles denied microphone access and cancels a delayed permission result without losing the text draft', async ({ page }) => {
    await openChat(page);
    await page.locator('[data-sync-input]').fill('Keep this draft');
    await page.evaluate(() => { window.voiceMock.mode = 'denied'; });
    await page.locator('[data-sync-voice-record]').click();
    await expect(page.locator('[data-sync-notice]')).toHaveAttribute('data-i18n', 'syncVoiceDenied');
    await microphoneReleased(page);
    await expect(page.locator('[data-sync-voice-record]')).toBeEnabled();
    await page.evaluate(() => { window.voiceMock.mode = 'pending'; });
    await page.locator('[data-sync-voice-record]').click();
    await expect(page.locator('[data-sync-voice-status]')).toHaveAttribute('data-i18n', 'syncVoiceStarting');
    await expect(page.locator('[data-sync-voice-stop]')).toBeDisabled();
    await page.locator('[data-sync-voice-cancel]').click();
    await page.evaluate(() => window.voiceMock.allow());
    await microphoneReleased(page);
    await expect(page.locator('[data-sync-voice-recording]')).toBeHidden();
    await expect(page.locator('[data-sync-voice-preview]')).toBeHidden();
    await expect(page.locator('[data-sync-input]')).toHaveValue('Keep this draft');
    expect(uploads).toHaveLength(0);
    await page.evaluate(() => { window.voiceMock.mode = 'allow'; });
    await startRecording(page);
    await page.locator('[data-sync-voice-cancel]').click();
    await microphoneReleased(page);
});

test('rejects a sub-250ms recording and stops the next recording at sixty seconds before sending', async ({ page }) => {
    await page.clock.install();
    await openChat(page);
    await page.evaluate(() => { window.voiceMock.sampleCount = 3200; });
    await startRecording(page);
    await page.locator('[data-sync-voice-stop]').click();
    await expect(page.locator('[data-sync-notice]')).toHaveAttribute('data-i18n', 'syncVoiceTooShort');
    await expect(page.locator('[data-sync-voice-preview]')).toBeHidden();
    await microphoneReleased(page);
    await page.evaluate(() => { window.voiceMock.sampleCount = 960000; });
    await startRecording(page);
    await page.clock.runFor(60000);
    await expect(page.locator('[data-sync-voice-recording]')).toBeHidden();
    await expect(page.locator('[data-sync-voice-preview]')).toBeVisible();
    await expect(page.locator('[data-sync-file-name]')).toContainText('01:00');
    await microphoneReleased(page);
    expect(uploads).toHaveLength(0);
});

test('cancels capture on blur, hidden document, inert desktop, scene exit, minimization and closing', async ({ page }) => {
    await openChat(page, true);
    await page.locator('[data-sync-input]').fill('Preserved through every interruption');
    const changes = [
        [() => page.evaluate(() => window.dispatchEvent(new Event('blur'))), () => page.evaluate(() => window.dispatchEvent(new Event('focus')))],
        [() => page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); }),
            () => page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); })],
        [() => page.locator('[data-retro-desktop]').evaluate(element => { element.inert = true; }), () => page.locator('[data-retro-desktop]').evaluate(element => { element.inert = false; })],
        [() => page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { origin: location.origin, source: window, data: { source: 'gavin-shell', type: 'portfolio-view-state', active: false } }))),
            () => page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { origin: location.origin, source: window, data: { source: 'gavin-shell', type: 'portfolio-view-state', active: true } })))],
        [() => page.locator('[data-sync-action="minimize"]').click(), () => page.locator('[data-sync-task]').click()],
        [() => page.locator('[data-sync-action="close"]').click(), () => page.locator('.desktop-shortcut[data-open-sync-space]').click()]
    ];
    for (const [interrupt, restore] of changes) {
        await startRecording(page);
        await interrupt();
        await microphoneReleased(page);
        await restore();
        await expect(page.locator('[data-sync-voice-recording]')).toBeHidden();
        await expect(page.locator('[data-sync-voice-preview]')).toBeHidden();
        await expect(page.locator('[data-sync-input]')).toHaveValue('Preserved through every interruption');
    }
    expect(uploads).toHaveLength(0);
});

test('keeps ordinary attachments exclusive with recording and releases reviewed voice URLs on remove and pagehide', async ({ page }) => {
    await openChat(page);
    await page.locator('[data-sync-file-input]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Ordinary attachment') });
    await expect(page.locator('[data-sync-voice-record]')).toBeDisabled();
    await expect(page.locator('[data-sync-file-name]')).toHaveText('notes.txt');
    await page.locator('[data-sync-remove-file]').click();
    await startRecording(page);
    await page.locator('[data-sync-voice-stop]').click();
    const preview = page.locator('[data-sync-voice-preview]');
    await expect(preview).toBeVisible();
    const first = await preview.getAttribute('src');
    await page.locator('[data-taskbar-lang]').click();
    await expect(page.locator('[data-sync-file-name]')).toContainText('Voice message');
    await expect(preview).toHaveAttribute('aria-label', 'Listen to recording');
    await page.locator('[data-sync-remove-file]').click();
    await expect(preview).toBeHidden();
    expect(await page.evaluate(url => window.voiceMock.revoked.includes(url), first)).toBe(true);
    await startRecording(page);
    await page.locator('[data-sync-voice-stop]').click();
    await expect(preview).toBeVisible();
    const second = await preview.getAttribute('src');
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
    await expect(preview).toBeHidden();
    await expect(preview).not.toHaveAttribute('src');
    expect(await page.evaluate(url => window.voiceMock.revoked.includes(url), second)).toBe(true);
    await microphoneReleased(page);
});

test('loads voices only on activation and replays cached audio after ending or hiding without another request', async ({ page }) => {
    history = attachments.map((attachment, index) => message(index + 1, '', otherId, attachment.metadata));
    await openChat(page);
    const voices = page.locator('.sync-voice-message');
    await expect(voices).toHaveCount(2);
    expect(tickets).toEqual([]);
    expect(downloads).toEqual([]);
    await expect(voices.locator('audio[src]')).toHaveCount(0);
    const first = voices.nth(0);
    await first.locator('[data-sync-voice-play]').focus();
    await first.locator('[data-sync-voice-play]').press('Enter');
    const firstAudio = first.locator('audio');
    await expect(firstAudio).toBeVisible();
    await expect.poll(() => firstAudio.evaluate(audio => audio.readyState)).toBeGreaterThanOrEqual(1);
    const playerLayout = await firstAudio.evaluate(audio => {
        const message = audio.closest('.sync-message');
        const feed = audio.closest('[data-sync-messages]').parentElement;
        const feedStyle = getComputedStyle(feed);
        const messageStyle = getComputedStyle(message);
        const available = (feed.clientWidth - parseFloat(feedStyle.paddingLeft) - parseFloat(feedStyle.paddingRight)) * 0.92
            - parseFloat(messageStyle.paddingLeft) - parseFloat(messageStyle.paddingRight)
            - parseFloat(messageStyle.borderLeftWidth) - parseFloat(messageStyle.borderRightWidth);
        return { width: audio.getBoundingClientRect().width, expected: Math.min(300, available),
            overflow: feed.scrollWidth - feed.clientWidth };
    });
    expect(playerLayout.width).toBeGreaterThanOrEqual(playerLayout.expected - 1);
    expect(playerLayout.overflow).toBeLessThanOrEqual(1);
    await firstAudio.evaluate(audio => { audio.pause(); audio.currentTime = 1; });
    await expect(firstAudio).toHaveJSProperty('currentTime', 1);
    await firstAudio.evaluate(async audio => { audio.muted = true; await audio.play(); });
    await expect(firstAudio).toHaveJSProperty('paused', false);
    expect(tickets).toEqual([1]);
    expect(downloads).toContain(1);
    const second = voices.nth(1);
    await second.locator('[data-sync-voice-play]').click();
    const secondAudio = second.locator('audio');
    await expect(secondAudio).toBeVisible();
    await expect.poll(() => secondAudio.evaluate(audio => audio.readyState)).toBeGreaterThanOrEqual(1);
    await expect(firstAudio).toHaveJSProperty('paused', true);
    await expect(firstAudio).toHaveAttribute('src', /^blob:/);
    await expect(firstAudio).toBeVisible();
    const secondUrl = await secondAudio.getAttribute('src');
    const requests = { tickets: [...tickets], downloads: [...downloads] };
    await secondAudio.evaluate(audio => audio.dispatchEvent(new Event('ended')));
    await expect(secondAudio).toHaveJSProperty('paused', true);
    await expect(secondAudio).toHaveAttribute('src', secondUrl);
    await expect.poll(() => page.evaluate(() => window.voiceMock.closes)).toBeGreaterThanOrEqual(2);
    await secondAudio.evaluate(async audio => { audio.muted = true; audio.currentTime = 0; await audio.play(); });
    await expect(secondAudio).toHaveJSProperty('paused', false);
    await page.locator('[data-retro-desktop]').evaluate(element => { element.inert = true; });
    await expect(secondAudio).toHaveJSProperty('paused', true);
    await expect(secondAudio).toHaveAttribute('src', secondUrl);
    await page.locator('[data-retro-desktop]').evaluate(element => { element.inert = false; });
    await secondAudio.evaluate(async audio => { audio.currentTime = 0; await audio.play(); });
    await expect(secondAudio).toHaveJSProperty('paused', false);
    expect(tickets).toEqual(requests.tickets);
    expect(downloads).toEqual(requests.downloads);
    const downloading = page.waitForEvent('download');
    await page.locator('[data-sync-download-file]').first().click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe('voice-first.wav');
    expect(await readFile(await download.path())).toEqual(wav());
});

test('rejects invalid encrypted voice duration and finishes a retried load in the background without autoplay', async ({ page }) => {
    history = [...attachments.map((attachment, index) => message(index + 1, '', otherId, attachment.metadata)),
        message(3, '', otherId, { ...attachments[0].metadata, durationMs: 60001 })];
    await openChat(page);
    await expect(page.locator('.sync-voice-message')).toHaveCount(2);
    await expect(page.locator('.sync-message').nth(2).locator('.sync-message-text')).toHaveText('此消息无法解密或已被篡改。');
    const first = page.locator('.sync-voice-message').first();
    failTicket = true;
    await first.locator('[data-sync-voice-play]').click();
    await expect(first).toHaveAttribute('data-state', 'failed');
    await expect(first.locator('audio')).not.toHaveAttribute('src');
    await expect(page.locator('[data-sync-notice]')).toHaveAttribute('data-i18n', 'syncVoicePlaybackFailed');
    holdTicket = true;
    await first.locator('[data-sync-voice-play]').click();
    await expect.poll(() => typeof releaseTicket).toBe('function');
    const closed = await page.evaluate(() => window.voiceMock.closes);
    await page.locator('[data-retro-desktop]').evaluate(element => { element.inert = true; });
    holdTicket = false;
    releaseTicket();
    await expect.poll(() => page.evaluate(() => window.voiceMock.closes)).toBeGreaterThan(closed);
    const audio = first.locator('audio');
    await expect(first).toHaveAttribute('data-state', 'ready');
    await expect(audio).toHaveAttribute('src', /^blob:/);
    await expect(audio).toHaveJSProperty('paused', true);
    const requests = { tickets: [...tickets], downloads: [...downloads] };
    await page.locator('[data-retro-desktop]').evaluate(element => { element.inert = false; });
    await expect(audio).toBeVisible();
    await expect.poll(() => audio.evaluate(audio => audio.readyState)).toBeGreaterThanOrEqual(1);
    await audio.evaluate(async audio => { audio.muted = true; await audio.play(); });
    await expect(audio).toHaveJSProperty('paused', false);
    expect(tickets).toEqual(requests.tickets);
    expect(downloads).toEqual(requests.downloads);
});

test('keeps only eight activated voices, releases on pagehide and clears cached audio with room history', async ({ page }) => {
    attachments = Array.from({ length: 9 }, (_, index) => file(`voice-${index}.wav`, 'audio/wav', wav()));
    attachments.forEach(attachment => Object.assign(attachment.metadata, { kind: 'voice', durationMs: 4000 }));
    history = attachments.map((attachment, index) => message(index + 1, '', otherId, attachment.metadata));
    await openChat(page);
    const voices = page.locator('.sync-voice-message');
    let firstUrl;
    for (let index = 0; index < 9; index++) {
        const voice = voices.nth(index);
        await voice.locator('[data-sync-voice-play]').click();
        await expect(voice).toHaveAttribute('data-state', 'ready');
        const audio = voice.locator('audio');
        await audio.evaluate(audio => audio.pause());
        if (index === 0) firstUrl = await audio.getAttribute('src');
    }
    await expect(voices.locator('audio[src]')).toHaveCount(8);
    await expect(voices.first().locator('[data-sync-voice-play]')).toBeVisible();
    expect(await page.evaluate(url => window.voiceMock.revoked.includes(url), firstUrl)).toBe(true);
    expect(tickets).toHaveLength(9);
    expect(downloads).toHaveLength(9);
    const cached = await voices.locator('audio[src]').evaluateAll(audios => audios.map(audio => audio.src));
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    await expect(voices.locator('audio[src]')).toHaveCount(0);
    expect(await page.evaluate(urls => urls.every(url => window.voiceMock.revoked.includes(url)), cached)).toBe(true);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
    await voices.last().locator('[data-sync-voice-play]').click();
    await expect(voices.last()).toHaveAttribute('data-state', 'ready');
    await expect(voices.last().locator('audio')).toHaveAttribute('src', /^blob:/);
    const reopened = await voices.last().locator('audio').getAttribute('src');
    sockets.at(-1).send(JSON.stringify({ type: 'cleared', history: { generation: '2', oldestId: null, latestId: null }, readReceipts: [] }));
    await expect(voices).toHaveCount(0);
    expect(await page.evaluate(url => window.voiceMock.revoked.includes(url), reopened)).toBe(true);
});

test('restores a reviewed unsent voice after pagehide and pageshow without keeping its former blob URL', async ({ page }) => {
    await openChat(page);
    await page.locator('[data-sync-input]').fill('Keep the unsent voice caption');
    await startRecording(page);
    await page.locator('[data-sync-voice-stop]').click();
    const preview = page.locator('[data-sync-voice-preview]');
    await expect(preview).toBeVisible();
    const previous = await preview.getAttribute('src');
    await preview.evaluate(async audio => { audio.muted = true; await audio.play(); });
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    await expect(preview).toBeHidden();
    await expect(preview).toHaveJSProperty('paused', true);
    await expect(preview).not.toHaveAttribute('src');
    expect(await page.evaluate(url => window.voiceMock.revoked.includes(url), previous)).toBe(true);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
    await expect(preview).toBeVisible();
    await expect(preview).toHaveJSProperty('paused', true);
    expect(await preview.getAttribute('src')).not.toBe(previous);
    await expect(page.locator('[data-sync-input]')).toHaveValue('Keep the unsent voice caption');
    await expect(page.locator('[data-sync-file-name]')).toContainText('00:00');
    await expect(page.locator('[data-sync-send]')).toBeEnabled();
    await preview.evaluate(async audio => { audio.muted = true; await audio.play(); audio.pause(); });
    await microphoneReleased(page);
    expect(uploads).toHaveLength(0);
});

test('cancels a starting microphone request on blur and stops its later permission stream', async ({ page }) => {
    await openChat(page);
    await page.locator('[data-sync-input]').fill('Draft while permission is pending');
    await page.evaluate(() => { window.voiceMock.mode = 'pending'; });
    await page.locator('[data-sync-voice-record]').click();
    await expect(page.locator('[data-sync-voice-status]')).toHaveAttribute('data-i18n', 'syncVoiceStarting');
    await expect.poll(() => page.evaluate(() => typeof window.voiceMock.allow)).toBe('function');
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await expect(page.locator('[data-sync-voice-recording]')).toBeHidden();
    await expect(page.locator('[data-sync-voice-record]')).toBeEnabled();
    await page.evaluate(() => window.voiceMock.allow());
    await expect.poll(() => page.evaluate(() => window.voiceMock.tracks.length)).toBe(1);
    await microphoneReleased(page);
    expect(await page.evaluate(() => window.voiceMock.nodes.length)).toBe(0);
    await expect(page.locator('[data-sync-voice-preview]')).toBeHidden();
    await expect(page.locator('[data-sync-input]')).toHaveValue('Draft while permission is pending');
    expect(uploads).toHaveLength(0);
    await page.evaluate(() => { window.voiceMock.mode = 'allow'; window.dispatchEvent(new Event('focus')); });
    await startRecording(page);
    await page.locator('[data-sync-voice-cancel]').click();
    await microphoneReleased(page);
});
