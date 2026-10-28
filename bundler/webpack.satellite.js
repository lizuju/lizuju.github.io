const path = require('path');

module.exports = {
    mode: 'production',
    devtool: false,
    entry: path.resolve(__dirname, '../src/SatelliteTracker/index.js'),
    resolve: {
        exportsFields: []
    },
    output: {
        path: path.resolve(__dirname, '../build/portfolio/js'),
        filename: 'satellite-tracker.js',
        chunkFilename: '[name].[contenthash].js',
        clean: { keep: /^gomoku-engine\.js$/ },
    },
};
