const CopyWebpackPlugin = require('copy-webpack-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const MiniCSSExtractPlugin = require('mini-css-extract-plugin');
const fs = require('fs');
const path = require('path');
const { createBuildMetadata } = require('./build-metadata');
const TrimGeneratedTextPlugin = require('./trim-generated-text-plugin');

const rootDirectory = path.resolve(__dirname, '..');
const buildMetadata = createBuildMetadata(rootDirectory);

module.exports = {
    entry: path.resolve(__dirname, '../src/script.ts'),
    output: {
        hashFunction: 'xxhash64',
        filename: 'bundle.[contenthash].js',
        chunkFilename: '[name].[contenthash].js',
        path: path.resolve(__dirname, '../docs'),
    },
    devtool: 'source-map',
    plugins: [
        new CopyWebpackPlugin({
            patterns: [{
                from: path.resolve(rootDirectory, 'static'),
                globOptions: {
                    ignore: [path.resolve(
                        rootDirectory,
                        'static/portfolio/assets/robomaster-match-records/*.jpg'
                    )],
                },
                transform(content, absolutePath) {
                    if (absolutePath.endsWith('portfolio/index.html')) {
                        return content
                            .toString()
                            .replaceAll('__ASSET_VERSION__', buildMetadata.assetVersion);
                    }
                    if (absolutePath.endsWith('sitemap.xml')) {
                        return content
                            .toString()
                            .replace('__LAST_MODIFIED__', buildMetadata.lastModified);
                    }
                    return content;
                },
            }],
        }),
        new HtmlWebpackPlugin({
            templateContent: fs
                .readFileSync(path.resolve(__dirname, '../src/index.html'), 'utf8')
                .replaceAll('__ASSET_VERSION__', buildMetadata.assetVersion),
            minify: {
                collapseWhitespace: true,
                minifyCSS: true,
                minifyJS: true,
                removeComments: true,
            },
        }),
        new MiniCSSExtractPlugin(),
        new TrimGeneratedTextPlugin(),
    ],
    resolve: {
        alias: {
            three: path.resolve('./node_modules/three'),
        },
        extensions: ['.tsx', '.ts', '.js'],
    },
    module: {
        rules: [
            // HTML
            {
                test: /\.(html)$/,
                use: {
                    loader: 'html-loader',
                    options: {
                        sources: false,
                    },
                },
            },
            {
                test: /\.ts?$/,
                use: 'ts-loader',
                exclude: /node_modules/,
            },
            // JS
            {
                test: /\.tsx$/,
                exclude: /node_modules/,
                use: {
                    loader: 'babel-loader',
                    options: {
                        presets: [
                            '@babel/preset-env',
                            '@babel/preset-react',
                            '@babel/preset-typescript',
                        ],
                    },
                },
            },

            // CSS
            {
                test: /\.css$/,
                use: [MiniCSSExtractPlugin.loader, 'css-loader'],
            },

            // Images
            {
                test: /\.(jpg|png|gif|svg)$/,
                type: 'asset/resource',
                generator: {
                    filename: 'assets/images/[hash][ext]',
                },
            },
            // Audio
            {
                test: /\.(mp3|wav)$/,
                loader: 'file-loader',
                options: {
                    name: '[path][name].[ext]',
                },
            },
            // Fonts
            {
                test: /\.(ttf|eot|woff|woff2)$/,
                type: 'asset/resource',
                generator: {
                    filename: 'assets/fonts/[hash][ext]',
                },
            },
            // Shaders
            {
                test: /\.(glsl|vs|fs|vert|frag)$/,
                exclude: /node_modules/,
                use: ['glslify-import-loader', 'raw-loader', 'glslify-loader'],
            },
        ],
    },
};
