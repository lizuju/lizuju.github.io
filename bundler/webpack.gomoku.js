const path = require('path')

module.exports = {
    mode: 'production',
    target: 'webworker',
    devtool: false,
    entry: path.resolve(__dirname, '../src/Gomoku/worker.js'),
    output: {
        path: path.resolve(__dirname, '../build/portfolio/js'),
        filename: 'gomoku-engine.js',
        clean: false,
    },
}
