const { merge } = require('webpack-merge')
const commonConfiguration = require('./webpack.common.js')
const webpack = require('webpack')
const path = require('path')

const reloadScript = `<script>new EventSource('/__webpack_hmr').onmessage = (event) => {
    if (event.data.startsWith('{') && JSON.parse(event.data).action === 'reload-all') location.reload();
};</script>`

module.exports = merge(
    commonConfiguration,
    {
        stats: 'errors-warnings',
        mode: 'development',
        infrastructureLogging:
        {
            level: 'warn',
        },
        plugins: [{
            apply(compiler) {
                compiler.hooks.thisCompilation.tap('ReloadPages', (compilation) => {
                    compilation.fileDependencies.add(path.resolve(__dirname, '../src/index.html'));
                    compilation.hooks.processAssets.tap({
                        name: 'ReloadPages',
                        stage: webpack.Compilation.PROCESS_ASSETS_STAGE_SUMMARIZE
                    }, () => {
                        for (const name of ['index.html', 'portfolio/index.html']) {
                            const html = compilation.getAsset(name).source.source().toString();
                            compilation.updateAsset(name, new webpack.sources.RawSource(
                                html.replace('</body>', `${reloadScript}</body>`)
                            ));
                        }
                    });
                });
            }
        }]
    }
)
