const { defineConfig, devices } = require('@playwright/test');

const localNoProxy = [process.env.NO_PROXY, process.env.no_proxy, '127.0.0.1', 'localhost']
    .filter(Boolean)
    .join(',');
process.env.NO_PROXY = localNoProxy;
process.env.no_proxy = localNoProxy;

module.exports = defineConfig({
    testDir: './tests',
    timeout: 30000,
    use: {
        baseURL: 'http://127.0.0.1:3090',
        trace: 'on-first-retry'
    },
    webServer: {
        command: 'python3 -m http.server 3090 --bind 127.0.0.1 --directory docs',
        url: 'http://127.0.0.1:3090/',
        reuseExistingServer: true,
        timeout: 15000
    },
    projects: [
        {
            name: 'desktop',
            use: {
                ...devices['Desktop Chrome'],
                channel: 'chrome',
                viewport: { width: 1440, height: 900 }
            }
        },
        {
            name: 'mobile',
            use: {
                ...devices['Desktop Chrome'],
                channel: 'chrome',
                viewport: { width: 390, height: 844 },
                isMobile: true,
                hasTouch: true
            }
        }
    ]
});
