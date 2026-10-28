<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh-CN.md">简体中文</a>
</p>

# Gavin Immersive Portfolio

Source code for [lizuju.github.io](https://lizuju.github.io/), the bilingual portfolio of 李祖钜 Gavin. The site presents work in AI agents, robotics, computer vision, recommender systems, full-stack engineering, and applied research.

Desktop visitors enter an interactive Three.js workspace, move toward a CRT computer, and use the portfolio through a turn-of-the-century desktop and application window. Mobile visitors receive the responsive retro desktop directly; the Three.js application and CRT media are split into desktop-only chunks, so mobile browsers do not download or render the 3D scene. Chinese is the default language, with a complete English version available from the language control.

## Highlights

- Interactive Three.js workspace with a local, self-contained CRT monitor experience.
- Functional retro desktop with a draggable and resizable window, taskbar, Start menu, shutdown/restart sequence, and early-web visual system.
- Playable bilingual Gomoku application with a Windows 2000 Minesweeper-style interface and minimax-powered computer opponent.
- Lightweight mobile layout designed for touch navigation and smaller screens.
- Five selected projects, two submitted research works, six capability areas, awards, education highlights, and contact links.
- Resume-derived public content with the school name intentionally omitted.
- SEO metadata, a shared JSON-LD profile (`src/profile-schema.json`), web app manifest, retro 404 page, build-dated sitemap, robots policy, and Playwright smoke coverage.

## Project Structure

```text
src/                       Three.js shell and desktop UI source
static/portfolio/          Responsive bilingual portfolio source
static/portfolio/js/content.js  Bilingual resume and portfolio data
static/portfolio/js/main.js     Desktop bootstrap and bundled JS/CSS entry
static/portfolio/js/desktop/    Shared window manager, taskbar, Start menu and scene bridge
static/portfolio/js/apps/       Portfolio, project folder, mail, satellite, Gomoku, control panel
                                and the end-to-end encrypted sync chat (sync-*.js)
static/portfolio/css/           Shared styles, per-app styles, responsive and print rules
static/portfolio/sync-config.json  Sync Worker address and the sync API version the frontend needs
static/portfolio/sync-e2ee-worker.js  Service Worker that streams and decrypts attachments
static/chat/               Standalone /chat/ page for the sync chat
static/                    3D models, textures, audio, and public files
cloudflare/sync/           Cloudflare Worker and Durable Objects backend for the sync chat
bundler/                   Webpack development and production configuration
scripts/                   Development server and image metadata tools
tests/                     Playwright browser tests (Chromium and WebKit, desktop and mobile)
docs/                      Production build output (generated, not committed)
```

## Local Development

Node.js 22.15.0 or later is required. With `nvm`, run `nvm use` to select the version declared in `.nvmrc`.

```bash
npm install
npm run dev
```

The development server opens the site at `http://127.0.0.1:8080/` by default.

To build and preview the GitHub Pages output:

```bash
npm run build
npm run preview
```

Then open `http://127.0.0.1:3090/`. The direct portfolio is also available at `http://127.0.0.1:3090/portfolio/`.

## Validation

```bash
npm run build
npm run test:smoke
npm test --prefix cloudflare/sync
node --check static/portfolio/js/main.js
node --check static/portfolio/js/content.js
node --check static/portfolio/js/gomoku-game.js
```

`npm run build` first runs `npm run images:check`, which fails if any image under `static/` still carries EXIF, GPS, XMP, IPTC, or comment metadata. Run `npm run images:strip` after adding photos; it removes metadata losslessly and keeps ICC color profiles.

Webpack bundles the desktop modules and styles into `docs/portfolio/js/main.js` and `docs/portfolio/css/main.css`; edit their source files under `static/portfolio/`. `docs/` and the Gomoku and satellite bundles in `build/` are ignored by Git: run `npm run build` before previewing or running the browser tests. Run `npm ci --prefix cloudflare/sync` once before the backend tests.

## Release

Pushing to `main` runs the backend tests, the production build and the browser tests on GitHub Actions, then publishes the build to GitHub Pages. The sync Worker is deployed by hand with `npm run deploy` in `cloudflare/sync/` (see [`cloudflare/sync/README.md`](cloudflare/sync/README.md)).

When a frontend change needs a new sync protocol, raise `apiVersion` in `static/portfolio/sync-config.json` and `API_VERSION` in `cloudflare/sync/src/api-version.js` together, deploy the Worker, then push to `main`. Before publishing Pages, CI runs `npm run check:sync-api`, which reads the live `/health` and stops the release if the Worker serves an older API than the frontend needs. After Pages is published, `npm run build && npm run verify:release -- <full commit SHA>` confirms that the live site and Worker match that commit.

## Attribution

The immersive 3D shell is adapted from [henryjeff/portfolio-website](https://github.com/henryjeff/portfolio-website), used under the MIT License. The upstream license is preserved in [`licenses/henryjeff-portfolio-website-MIT.md`](licenses/henryjeff-portfolio-website-MIT.md).

The Gomoku computer opponent uses [`@algorithm.ts/gomoku`](https://www.npmjs.com/package/@algorithm.ts/gomoku), also under the MIT License. Its license is preserved in [`static/portfolio/licenses/algorithm-ts-gomoku-MIT.txt`](static/portfolio/licenses/algorithm-ts-gomoku-MIT.txt).

## License

This project is released under the [MIT License](LICENSE).
