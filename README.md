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
- SEO metadata, JSON-LD, sitemap, robots policy, and Playwright smoke coverage.

## Project Structure

```text
src/                       Three.js shell and desktop UI source
static/portfolio/          Responsive bilingual portfolio source
static/portfolio/js/content.js  Bilingual resume and portfolio data
static/portfolio/js/main.js     Portfolio rendering and desktop interactions
static/portfolio/js/gomoku-game.js  Gomoku application behavior
static/                    3D models, textures, audio, and public files
bundler/                   Webpack development and production configuration
docs/                      Generated GitHub Pages output
tests/smoke.spec.js        Browser smoke tests
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
npm run verify:docs
node --check static/portfolio/js/main.js
node --check static/portfolio/js/content.js
node --check static/portfolio/js/gomoku-game.js
```

## Attribution

The immersive 3D shell is adapted from [henryjeff/portfolio-website](https://github.com/henryjeff/portfolio-website), used under the MIT License. The upstream license is preserved in [`licenses/henryjeff-portfolio-website-MIT.md`](licenses/henryjeff-portfolio-website-MIT.md).

The Gomoku computer opponent uses [`@algorithm.ts/gomoku`](https://www.npmjs.com/package/@algorithm.ts/gomoku), also under the MIT License. Its license is preserved in [`static/portfolio/licenses/algorithm-ts-gomoku-MIT.txt`](static/portfolio/licenses/algorithm-ts-gomoku-MIT.txt).

## License

This project is released under the [MIT License](LICENSE).
