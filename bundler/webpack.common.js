const CopyWebpackPlugin = require('copy-webpack-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const MiniCSSExtractPlugin = require('mini-css-extract-plugin');
const fs = require('fs');
const path = require('path');
const { createBuildMetadata } = require('./build-metadata');
const TrimGeneratedTextPlugin = require('./trim-generated-text-plugin');

const rootDirectory = path.resolve(__dirname, '..');
const buildMetadata = createBuildMetadata(rootDirectory);
const profileSchemaPath = path.resolve(rootDirectory, 'src/profile-schema.json');
const readProfileSchema = () => JSON.stringify(JSON.parse(fs.readFileSync(profileSchemaPath, 'utf8')));

module.exports = {
    entry: {
        main: path.resolve(__dirname, '../src/script.ts'),
        portfolio: {
            import: path.resolve(rootDirectory, 'static/portfolio/js/main.js'),
            filename: 'portfolio/js/main.js',
            publicPath: '../',
        },
    },
    output: {
        hashFunction: 'xxhash64',
        filename: 'bundle.[contenthash].js',
        chunkFilename: '[name].[contenthash].js',
        path: path.resolve(__dirname, '../docs'),
    },
    devtool: 'source-map',
    plugins: [
        new CopyWebpackPlugin({
            patterns: [
                ...['cmaps', 'standard_fonts', 'wasm'].map((folder) => ({
                    from: path.resolve(rootDirectory, 'node_modules/pdfjs-dist', folder),
                    to: `portfolio/assets/pdfjs/${folder}`,
                })),
                {
                from: path.resolve(rootDirectory, 'static'),
                globOptions: {
                    ignore: [
                        'static/portfolio/assets/robomaster-match-records/*.jpg',
                        'static/portfolio/js/main.js',
                        'static/portfolio/js/desktop/**',
                        'static/portfolio/js/apps/**',
                        'static/portfolio/css/**',
                    ].map((pattern) => path.resolve(rootDirectory, pattern)),
                },
                transform(content, absolutePath) {
                    if (absolutePath.endsWith('portfolio/index.html')) {
                        return content
                            .toString()
                            .replaceAll('__ASSET_VERSION__', buildMetadata.assetVersion)
                            .replace('__PROFILE_SCHEMA__', readProfileSchema);
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
            chunks: ['main'],
            templateContent: () => fs
                .readFileSync(path.resolve(__dirname, '../src/index.html'), 'utf8')
                .replaceAll('__ASSET_VERSION__', buildMetadata.assetVersion)
                .replace('__PROFILE_SCHEMA__', readProfileSchema),
            minify: {
                collapseWhitespace: true,
                minifyCSS: true,
                minifyJS: true,
                removeComments: true,
            },
        }),
        new MiniCSSExtractPlugin({
            filename: ({ chunk }) => chunk.name === 'portfolio' ? 'portfolio/css/main.css' : '[name].css',
            chunkFilename: '[name].css',
        }),
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
            {
                test: /[\\/]pdfjs-dist[\\/]build[\\/]pdf\.mjs$/,
                use: path.resolve(__dirname, 'pdfjs-browser-loader.js'),
            },
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
