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
- 包含 SEO 元信息、两页共用的 JSON-LD 资料（`src/profile-schema.json`）、Web App Manifest、复古风格 404 页面、构建时自动写入日期的 sitemap、robots 规则和 Playwright smoke test。

## 项目结构

```text
src/                       Three.js 外壳和桌面端 UI 源码
static/portfolio/          响应式双语作品集源码
static/portfolio/js/content.js  中英文简历与作品集数据
static/portfolio/js/main.js     桌面启动及 JS/CSS 打包入口
static/portfolio/js/desktop/    窗口管理、任务栏、开始菜单和沉浸式场景通信
static/portfolio/js/apps/       主页、项目文件夹、邮件、卫星、五子棋、控制面板
                                以及端到端加密的联络站（sync-*.js）
static/portfolio/css/           通用样式、各应用样式、响应式和打印规则
static/portfolio/sync-config.json  联络站后端地址和前端所需的同步 API 版本
static/portfolio/sync-e2ee-worker.js  流式解密附件的 Service Worker
static/chat/               独立的 /chat/ 联络站页面
static/                    3D 模型、纹理、音频和公开文件
cloudflare/sync/           联络站后端（Cloudflare Worker 与 Durable Objects）
bundler/                   Webpack 开发及生产配置
scripts/                   开发服务器和图片元数据工具
tests/                     Playwright 浏览器测试（Chromium、WebKit，桌面端和移动端）
docs/                      生产构建产物（自动生成，不提交）
```

## 本地开发

需要 Node.js 22.15.0 或更高版本。使用 `nvm` 时，执行 `nvm use` 即可切换到 `.nvmrc` 声明的版本。

```bash
npm install
npm run dev
```

开发服务器默认使用 `http://127.0.0.1:8080/`。

构建并预览 GitHub Pages 版本：

```bash
npm run build
npm run preview
```

然后访问 `http://127.0.0.1:3090/`。直接查看作品集可访问 `http://127.0.0.1:3090/portfolio/`。

## 验证

```bash
npm run build
npm run test:smoke
npm test --prefix cloudflare/sync
node --check static/portfolio/js/main.js
node --check static/portfolio/js/content.js
node --check static/portfolio/js/gomoku-game.js
```

`npm run build` 会先执行 `npm run images:check`，如果 `static/` 下任何图片仍带有 EXIF、GPS、XMP、IPTC 或注释元数据，构建会失败。新增照片后运行 `npm run images:strip`，它会无损移除元数据，并保留 ICC 色彩配置。

Webpack 将桌面模块和样式打包为 `docs/portfolio/js/main.js` 和 `docs/portfolio/css/main.css`；请修改 `static/portfolio/` 下对应的源码。`docs/` 和 `build/` 下的五子棋、卫星子包都不纳入 Git，预览或运行浏览器测试前先执行 `npm run build`。首次运行后端测试前先执行 `npm ci --prefix cloudflare/sync`。

## 发布

PR 上由 GitHub Actions 运行后端测试、生产构建和浏览器测试，合并前分支必须已包含最新的 `main`。合并到 `main` 后只重跑后端测试和构建，通过后把构建结果发布到 GitHub Pages。联络站后端需要在 `cloudflare/sync/` 下手动运行 `npm run deploy` 部署（见 [`cloudflare/sync/README.md`](cloudflare/sync/README.md)）。

前端改动需要新的同步协议时，同时把 `static/portfolio/sync-config.json` 的 `apiVersion` 和 `cloudflare/sync/src/api-version.js` 的 `API_VERSION` 加 1，先部署 Worker，再推送到 `main`。CI 发布 Pages 前会运行 `npm run check:sync-api` 读取线上 `/health`，如果 Worker 的 API 版本低于前端需要的版本，就停止发布。Pages 发布后，运行 `npm run build && npm run verify:release -- <完整提交SHA>` 核对线上网站和 Worker 是否都对应这次提交。

## 开源来源

沉浸式 3D 外壳基于 [henryjeff/portfolio-website](https://github.com/henryjeff/portfolio-website) 二次开发，并遵循其 MIT License。上游协议保留在 [`licenses/henryjeff-portfolio-website-MIT.md`](licenses/henryjeff-portfolio-website-MIT.md)。

五子棋电脑对手使用 MIT 许可的 [`@algorithm.ts/gomoku`](https://www.npmjs.com/package/@algorithm.ts/gomoku)，其协议保留在 [`static/portfolio/licenses/algorithm-ts-gomoku-MIT.txt`](static/portfolio/licenses/algorithm-ts-gomoku-MIT.txt)。

## 开源协议

本项目使用 [MIT License](LICENSE)。
