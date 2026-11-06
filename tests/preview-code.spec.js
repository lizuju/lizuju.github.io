const { createServer } = require('node:http');
const { test, expect, deviceId, keyId, authorize, message, profile, file, startSite } = require('./fixtures/sync-e2ee.cjs');

const documents = [
    ['main.py', 'application/octet-stream', 'def hello():\n    print("你好，世界")\n'],
    ['main.CPP', 'text/x-c++src', '#include <iostream>\nint main() {\n\tstd::cout << "中文";\n}\n'],
    ['main.h', 'application/octet-stream', '#pragma once\nvoid hello();\n'],
    ['settings.json', 'application/json', '{\n  "name": "中文",\n  "html": "<b>literal</b>"\n}\n'],
    ['article.latex', 'application/octet-stream', '\\documentclass{article}\n\\begin{document}\n中文 $x^2$\n\\end{document}\n'],
    ['article.tex', 'application/x-tex', '\\section{中文标题}\n\\textbf{保留源码}\n'],
    ['script.js', 'text/javascript', 'window.codePreviewExecuted = true;\n'],
    ['index.html', 'text/html', '<script>window.codePreviewExecuted = true;</script>\n<img src="missing" onerror="window.codePreviewExecuted = true">\n']
];

for (const entryPath of ['/portfolio/', '/chat/']) {
    test(`previews encrypted code as literal text in ${entryPath}`, async ({ page, isMobile }) => {
        test.skip(isMobile && entryPath === '/portfolio/', 'the desktop shell is not shown on mobile');
        const attachments = documents.map(([name, type, text]) => file(name, type, Buffer.from(text)));
        attachments.push(file('binary.bin', 'application/octet-stream', Buffer.from([0, 1, 2, 255])));
        const headers = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Sync-Key-Id, Range',
            'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
            'Access-Control-Expose-Headers': 'Content-Range, Content-Length'
        };
        const server = createServer((request, response) => {
            if (request.method === 'OPTIONS') { response.writeHead(204, headers); response.end(); return; }
            const pathname = new URL(request.url, 'http://localhost').pathname;
            const json = value => { response.writeHead(200, { ...headers, 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
            if (pathname.endsWith('/key-grants')) return json({ grants: [], hasMore: false, keyId });
            if (pathname.endsWith('/devices')) return json({ deviceId, devices: [profile()] });
            if (pathname.endsWith('/download')) return json({ ticket: pathname.split('/').at(-2).padStart(64, '0'), expiresAt: Date.now() + 86400000 });
            const encrypted = attachments[Number(pathname.split('/').at(-1)) - 1].bytes;
            const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range || '');
            const start = range ? Number(range[1]) : 0;
            const end = range ? Number(range[2]) : encrypted.length - 1;
            const body = encrypted.subarray(start, end + 1);
            response.writeHead(range ? 206 : 200, {
                ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length),
                ...(range ? { 'Content-Range': `bytes ${start}-${end}/${encrypted.length}` } : {})
            });
            response.end(request.method === 'HEAD' ? undefined : body);
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const apiOrigin = `http://127.0.0.1:${server.address().port}`;
        const site = await startSite(apiOrigin);
        try {
            await authorize(page, `${site.origin}${entryPath}`);
            await page.routeWebSocket(`${apiOrigin.replace('http:', 'ws:')}/**`, socket => socket.onMessage(data => {
                if (data === 'ping') return socket.send('pong');
                if (JSON.parse(data).type === 'auth') socket.send(JSON.stringify({
                    type: 'ready', deviceId, pairing: null,
                    messages: attachments.map((attachment, index) => message(index + 1, '', deviceId, attachment.metadata))
                }));
            }));
            await page.goto(`${site.origin}${entryPath}`);
            if (entryPath === '/portfolio/') {
                await page.locator('[data-window-action="minimize"]').click();
                await page.locator('.desktop-shortcut[data-open-sync-space]').click();
            }
            await expect(page.locator('[data-sync-status]')).toHaveAttribute('data-state', 'online');
            await expect(page.locator('[data-sync-preview-file]')).toHaveCount(documents.length);
            const preview = page.locator('[data-sync-preview-window]');
            for (const [name, , text] of documents) {
                await page.locator('[data-sync-preview-file]').filter({ hasText: name }).click();
                await expect(preview).toBeVisible();
                await expect(preview.locator('[data-sync-preview-title]')).toHaveText(name);
                const code = preview.locator('.sync-document-text pre');
                await expect(code).toBeVisible();
                expect(await code.textContent()).toBe(text);
                await expect(code.locator('*')).toHaveCount(0);
                expect(await page.evaluate(() => window.codePreviewExecuted)).toBeUndefined();
                await preview.locator('[data-sync-preview-action="close"]').click();
            }
            await expect(page.locator('.sync-attachment').filter({ hasText: 'binary.bin' }).locator('[data-sync-preview-file]')).toHaveCount(0);
        } finally {
            await site.close();
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        }
    });
}
