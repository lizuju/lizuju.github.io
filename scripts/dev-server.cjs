const http = require('node:http');
const webpack = require('webpack');
const webpackDevMiddleware = require('webpack-dev-middleware');
const portFinder = require('portfinder-sync');
const configuration = require('../bundler/webpack.dev');

const port = portFinder.getPort(8080);
const address = `http://127.0.0.1:${port}`;
const compiler = webpack(configuration);
const middleware = webpackDevMiddleware(compiler, {
    publicPath: '/',
    stats: 'errors-warnings',
    hot: true
});
compiler.hooks.done.tap('ReloadPages', (stats) => {
    if (!stats.hasErrors()) middleware.context.hot.publish({ action: 'reload-all' });
});

const server = http.createServer((request, response) => {
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(request.headers.host)) {
        response.writeHead(403);
        response.end('Invalid Host header');
        return;
    }
    middleware(request, response, () => {
        response.writeHead(404);
        response.end('Not found');
    });
});

server.listen(port, '127.0.0.1', () => {
    console.log(`Project running at:\n  - ${address}`);
    if (!process.env.CI) {
        middleware.waitUntilValid(() => import('open').then(({ default: open }) => open(address)));
    }
});

const close = () => {
    middleware.close(() => {
        server.close();
        server.closeAllConnections();
    });
};
process.once('SIGINT', close);
process.once('SIGTERM', close);
