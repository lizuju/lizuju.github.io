const path = require('path')

module.exports = {
    mode: 'production',
    devtool: false,
    entry: require.resolve('@algorithm.ts/gomoku'),
    output: {
        path: path.resolve(__dirname, '../build/portfolio/js'),
        filename: 'gomoku-engine.js',
        library: {
            name: 'GomokuEngine',
            type: 'window',
        },
        clean: false,
    },
}
