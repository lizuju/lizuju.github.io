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
const syncWindowsPath = path.resolve(rootDirectory, 'src/sync-windows.html');
const projectWindowsPath = path.resolve(rootDirectory, 'src/project-windows.html');
const syncOrigin = new URL(require('../static/portfolio/sync-config.json').apiBase).origin;
const socketOrigin = syncOrigin.replace(/^http/, 'ws');
const contentSecurityPolicy = [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${syncOrigin}`,
    `media-src 'self' blob: ${syncOrigin}`,
    "font-src 'self' data:",
    `connect-src 'self' ${syncOrigin} ${socketOrigin} https://formsubmit.co https://celestrak.org`,
    "worker-src 'self' blob:",
    // Safari checks the parent frame policy before downloading an iframe's Blob URL.
    `frame-src 'self' blob: ${syncOrigin}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
].join('; ');

module.exports = {
    entry: {
        main: path.resolve(__dirname, '../src/script.ts'),
        portfolio: {
            import: path.resolve(rootDirectory, 'static/portfolio/js/main.js'),
            filename: 'portfolio/js/main.js',
            publicPath: '../',
        },
        chat: {
            import: path.resolve(rootDirectory, 'static/portfolio/js/chat.js'),
            filename: 'portfolio/js/chat.js',
            publicPath: '../',
        },
        honors: {
            import: path.resolve(rootDirectory, 'static/portfolio/js/honors.js'),
            filename: 'portfolio/js/honors.js',
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
                { from: path.resolve(rootDirectory, 'static/portfolio/sync-config.json'), to: 'chat/sync-config.json' },
                { from: path.resolve(rootDirectory, 'static/portfolio/sync-e2ee-worker.js'), to: 'sync-e2ee-worker.js' },
                // Gomoku and satellite bundles from build:gomoku / build:satellite. build/ is absent when
                // the browser tests start the dev server without them; the production build always creates it.
                { from: path.resolve(rootDirectory, 'build'), noErrorOnMissing: true },
                {
                from: path.resolve(rootDirectory, 'static'),
                globOptions: {
                    ignore: [
                        'static/portfolio/assets/robomaster-match-records/*.jpg',
                        'static/portfolio/js/main.js',
                        'static/portfolio/js/chat.js',
                        'static/portfolio/js/honors.js',
                        'static/portfolio/sync-e2ee-worker.js',
                        'static/portfolio/js/desktop/**',
                        'static/portfolio/js/apps/**',
                        'static/portfolio/css/**',
                    ].map((pattern) => path.resolve(rootDirectory, pattern)),
                },
                transform(content, absolutePath) {
                    if (['portfolio/index.html', 'chat/index.html', 'honors/index.html'].some(page => absolutePath.endsWith(page))) {
                        return content
                            .toString()
                            .replace('__SYNC_WINDOWS__', () => fs.readFileSync(syncWindowsPath, 'utf8'))
                            .replace('__PROJECT_WINDOWS__', () => fs.readFileSync(projectWindowsPath, 'utf8'))
                            .replaceAll('__ASSET_VERSION__', buildMetadata.assetVersion)
                            .replace('__CONTENT_SECURITY_POLICY__', contentSecurityPolicy)
                            .replace('__PROFILE_SCHEMA__', readProfileSchema);
                    }
                    if (absolutePath.endsWith('sitemap.xml')) {
                        return content
                            .toString()
                            .replaceAll('__LAST_MODIFIED__', buildMetadata.lastModified);
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
                .replace('__CONTENT_SECURITY_POLICY__', contentSecurityPolicy)
                .replace('__PROFILE_SCHEMA__', readProfileSchema),
            minify: {
                collapseWhitespace: true,
                minifyCSS: true,
                minifyJS: true,
                removeComments: true,
            },
        }),
        new MiniCSSExtractPlugin({
            filename: ({ chunk }) => chunk.name === 'portfolio' ? 'portfolio/css/main.css'
                : ['chat', 'honors'].includes(chunk.name) ? `portfolio/css/${chunk.name}.css` : '[name].css',
            chunkFilename: '[name].css',
        }),
        new TrimGeneratedTextPlugin(),
        {
            apply(compiler) {
                compiler.hooks.thisCompilation.tap('SyncWindowTemplate', (compilation) => {
                    compilation.fileDependencies.add(syncWindowsPath);
                    compilation.fileDependencies.add(projectWindowsPath);
                });
            },
        },
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
