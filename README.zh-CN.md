<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh-CN.md">简体中文</a>
</p>

# 李祖钜 Gavin 沉浸式个人作品集

这是 [lizuju.github.io](https://lizuju.github.io/) 的源码仓库，用于展示李祖钜 Gavin 在 AI Agent、机器人、计算机视觉、推荐系统、全栈工程和应用研究方面的经历。

桌面端使用 Three.js 构建可交互的复古计算机工作台，访客可以靠近 CRT 显示器，在 00 年代系统桌面和应用窗口中浏览作品集；移动端会直接加载响应式复古桌面，Three.js 应用与 CRT 媒体被拆分为仅桌面加载的资源，因此手机不会下载或渲染 3D 场景。网站默认显示中文，并提供完整英文版本。

## 主要特点

- 桌面端 Three.js 沉浸式场景，显示器内容完全使用本地资源。
- 可操作的复古桌面，支持窗口拖动与缩放、任务栏、开始菜单、关机重启流程和早期网页视觉系统。
- 内置可玩的中英双语五子棋软件，采用 Windows 2000 扫雷式界面，并提供 minimax 电脑对手。
- 面向触控和小屏设备优化的轻量移动端布局。
- 完整展示 5 个代表项目、2 项投稿中研究、6 类能力、荣誉、教育亮点和联系方式。
- 网站内容根据最新版简历整理，按要求不公开学校名称。
- 包含 SEO 元信息、JSON-LD、sitemap、robots 规则和 Playwright smoke test。

## 项目结构

```text
src/                       Three.js 外壳和桌面端 UI 源码
static/portfolio/          响应式双语作品集源码
static/portfolio/js/       作品集与五子棋浏览器逻辑
static/                    3D 模型、纹理、音频和公开文件
bundler/                   Webpack 开发及生产配置
docs/                      构建生成的 GitHub Pages 文件
tests/smoke.spec.js        浏览器 smoke test
```

## 本地开发

```bash
npm install
npm run dev
```

开发服务器默认使用 `http://localhost:8080/`。

构建并预览 GitHub Pages 版本：

```bash
npm run build
npm run preview
```

然后访问 `http://localhost:3090/`。直接查看作品集可访问 `http://localhost:3090/portfolio/`。

## 验证

```bash
npm run build
npm run test:smoke
npm run verify:docs
node --check static/portfolio/js/main.js
node --check static/portfolio/js/gomoku-game.js
```

## 开源来源

沉浸式 3D 外壳基于 [henryjeff/portfolio-website](https://github.com/henryjeff/portfolio-website) 二次开发，并遵循其 MIT License。上游协议保留在 [`licenses/henryjeff-portfolio-website-MIT.md`](licenses/henryjeff-portfolio-website-MIT.md)。

五子棋电脑对手使用 MIT 许可的 [`@algorithm.ts/gomoku`](https://www.npmjs.com/package/@algorithm.ts/gomoku)，其协议保留在 [`static/portfolio/licenses/algorithm-ts-gomoku-MIT.txt`](static/portfolio/licenses/algorithm-ts-gomoku-MIT.txt)。

## 开源协议

本项目使用 [MIT License](LICENSE)。
