<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh-CN.md">简体中文</a>
</p>

# Gavin Immersive Portfolio

Source code for [lizuju.github.io](https://lizuju.github.io/), the bilingual portfolio of 李祖钜 Gavin. The site presents work in AI agents, robotics, computer vision, recommender systems, full-stack engineering, and applied research.

Desktop visitors enter an interactive Three.js workspace, move toward a CRT computer, and use the portfolio through a turn-of-the-century desktop and application window. Mobile visitors receive the responsive retro desktop directly, avoiding the download and rendering cost of the 3D scene. Chinese is the default language, with a complete English version available from the language control.

## Highlights

- Interactive Three.js workspace with a local, self-contained CRT monitor experience.
- Functional retro desktop with a draggable and resizable window, taskbar, Start menu, shutdown/restart sequence, and early-web visual system.
- Lightweight mobile layout designed for touch navigation and smaller screens.
- Five selected projects, two submitted research works, six capability areas, awards, education highlights, and contact links.
- Resume-derived public content with the school name intentionally omitted.
- SEO metadata, JSON-LD, sitemap, robots policy, and Playwright smoke coverage.

## Project Structure

```text
src/                       Three.js shell and desktop UI source
static/portfolio/          Responsive bilingual portfolio source
static/                    3D models, textures, audio, and public files
bundler/                   Webpack development and production configuration
docs/                      Generated GitHub Pages output
tests/smoke.spec.js        Browser smoke tests
```

## Local Development

```bash
npm install
npm run dev
```

The development server opens the site at `http://localhost:8080/` by default.

To build and preview the GitHub Pages output:

```bash
npm run build
npm run preview
```

Then open `http://localhost:3090/`. The direct portfolio is also available at `http://localhost:3090/portfolio/`.

## Validation

```bash
npm run build
npm run test:smoke
node --check static/portfolio/js/main.js
```

## Attribution

The immersive 3D shell is adapted from [henryjeff/portfolio-website](https://github.com/henryjeff/portfolio-website), used under the MIT License. The upstream license is preserved in [`licenses/henryjeff-portfolio-website-MIT.md`](licenses/henryjeff-portfolio-website-MIT.md).

## License

This project is released under the [MIT License](LICENSE).
