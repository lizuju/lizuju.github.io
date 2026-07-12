const path = require('path')
const { merge } = require('webpack-merge')
const commonConfiguration = require('./webpack.common.js')
const portFinderSync = require('portfinder-sync')

const infoColor = (_message) =>
{
    return `\u001b[1m\u001b[34m${_message}\u001b[39m\u001b[22m`
}

module.exports = merge(
    commonConfiguration,
    {
        stats: 'errors-warnings',
        mode: 'development',
        infrastructureLogging:
        {
            level: 'warn',
        },
        devServer:
        {
            host: '127.0.0.1',
            port: portFinderSync.getPort(8080),
            open: true,
            allowedHosts: 'auto',
            hot: false,
            watchFiles: ['src/**', 'static/**'],
            static:
            {
                watch: true,
                directory: path.join(__dirname, '../static')
            },
            client:
            {
                logging: 'none',
                overlay: true,
                progress: false
            },
            setupMiddlewares: function(middlewares, devServer)
            {
                const port = devServer.options.port
                const domain = `http://${devServer.options.host}:${port}`

                console.log(`Project running at:\n  - ${infoColor(domain)}`)
                return middlewares
            }
        }
    }
)
