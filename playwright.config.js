const { defineConfig, devices } = require('@playwright/test');

const localNoProxy = [process.env.NO_PROXY, process.env.no_proxy, '127.0.0.1', 'localhost']
    .filter(Boolean)
    .join(',');
process.env.NO_PROXY = localNoProxy;
process.env.no_proxy = localNoProxy;

module.exports = defineConfig({
    testDir: './tests',
    timeout: 30000,
    retries: process.env.CI ? 1 : 0,
    workers: process.env.CI ? 1 : undefined,
    reporter: process.env.CI
        ? [['line'], ['html', { open: 'never' }]]
        : 'list',
    use: {
        baseURL: 'http://127.0.0.1:3090',
        trace: 'on-first-retry',
        screenshot: 'only-on-failure'
    },
    webServer: {
        command: 'python3 -m http.server 3090 --bind 127.0.0.1 --directory docs',
        url: 'http://127.0.0.1:3090/',
        reuseExistingServer: true,
        timeout: 15000
    },
    projects: [
        {
            name: 'chromium-desktop',
            use: {
                ...devices['Desktop Chrome'],
                viewport: { width: 1366, height: 768 }
            }
        },
        {
            name: 'chromium-mobile',
            use: {
                ...devices['Pixel 5'],
                viewport: { width: 320, height: 568 }
            }
        },
        {
            name: 'webkit-desktop',
            use: {
                ...devices['Desktop Safari'],
                viewport: { width: 1366, height: 768 }
            }
        },
        {
            name: 'webkit-mobile',
            use: {
                ...devices['iPhone 13'],
                viewport: { width: 320, height: 568 }
            }
        }
    ]
});
