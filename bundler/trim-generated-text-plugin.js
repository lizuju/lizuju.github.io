class TrimGeneratedTextPlugin {
    apply(compiler) {
        compiler.hooks.thisCompilation.tap('TrimGeneratedTextPlugin', (compilation) => {
            compilation.hooks.processAssets.tap(
                {
                    name: 'TrimGeneratedTextPlugin',
                    stage: compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE,
                },
                (assets) => {
                    for (const name of Object.keys(assets)) {
                        if (!/\.(css|html|xml|txt)$/.test(name)) continue;
                        const content = assets[name].source().toString().replace(/\s+$/, '\n');
                        compilation.updateAsset(
                            name,
                            new compiler.webpack.sources.RawSource(content)
                        );
                    }
                }
            );
        });
    }
}

module.exports = TrimGeneratedTextPlugin;
