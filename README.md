<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh-CN.md">简体中文</a>
</p>

# Gavin Lizuju Portfolio

Source code for [lizuju.github.io](https://lizuju.github.io/), a personal portfolio for presenting my work in AI agents, computer vision, robotics, full-stack engineering, awards, and contact information.

The current site is a static GitHub Pages website under `docs/`. It is built with plain HTML, CSS, and JavaScript so the page stays lightweight, easy to inspect, and simple to deploy.

## Highlights

- Premium dark visual system with restrained gold accents and responsive spacing.
- Image-led project sections for RoboMaster vision, inventory sensing, and retrieval-based recognition work.
- Bilingual Chinese / English content with a lightweight language toggle.
- Mobile navigation, desktop navigation, contact links, and GitHub profile links.
- Resume content completed from the local resume source while keeping the school name out of the public site.
- Playwright smoke tests for layout, language switching, navigation, expandable details, and key links.

## Project Structure

```text
docs/
  index.html              Main page markup
  css/custom.css          Visual system and responsive layout
  js/main.js              Content data, i18n, rendering, and interactions
  assets/                 Portfolio and project images
  */SKILL*.md             Legacy content references kept with the site
tests/
  smoke.spec.js           Browser smoke tests
playwright.config.js      Playwright configuration
package.json              Local scripts and test dependency
```

## Local Development

Install dependencies once:

```bash
npm install
```

Run the site from the repository root:

```bash
npm run dev
```

Then open:

```text
http://localhost:3090/docs/
```

For the same root URL used during browser QA, serve the `docs` folder directly:

```bash
python3 -m http.server 3090 --directory docs
```

Then open:

```text
http://localhost:3090/
```

## Validation

Run the main checks before publishing:

```bash
node --check docs/js/main.js
npm run test:smoke
```

The smoke tests cover desktop and mobile rendering, absence of the removed school name, language switching, mobile menu behavior, CTA anchors, the footer back-to-top link, expandable detail sections, image rendering, and highlighted education honors.

## Deployment

This repository is intended for GitHub Pages. The published site content lives in `docs/`; after committing changes to `main`, GitHub Pages can serve the updated portfolio from that folder.

## License

This project is released under the MIT License.
