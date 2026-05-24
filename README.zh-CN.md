<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh-CN.md">简体中文</a>
</p>

# 李祖钜 Gavin 个人作品集

这是 [lizuju.github.io](https://lizuju.github.io/) 的源码仓库，用来展示我的 AI Agent、计算机视觉、机器人开发、全栈工程、竞赛荣誉和联系方式。

当前网站是放在 `docs/` 目录下的静态 GitHub Pages 站点，使用原生 HTML、CSS 和 JavaScript 实现，方便检查、部署和持续维护。

## 主要特点

- 深色高级视觉系统，配合克制的金色强调色和响应式间距。
- 使用图片主导项目展示，覆盖 RoboMaster 视觉算法、货物盘点感知、检索式识别平台等经历。
- 支持中文 / 英文切换。
- 适配桌面端和移动端导航、联系方式、GitHub 入口和回到顶部交互。
- 根据本地简历补全公开作品集内容，同时不在网站展示学校名称。
- 使用 Playwright smoke test 覆盖关键浏览器交互和响应式回归。

## 项目结构

```text
docs/
  index.html              页面主体结构
  css/custom.css          视觉系统和响应式样式
  js/main.js              内容数据、双语渲染和交互逻辑
  assets/                 作品集和项目图片
  */SKILL*.md             随站点保留的历史内容参考
tests/
  smoke.spec.js           浏览器 smoke 测试
playwright.config.js      Playwright 配置
package.json              本地脚本和测试依赖
```

## 本地开发

首次运行先安装依赖：

```bash
npm install
```

从仓库根目录启动本地服务：

```bash
npm run dev
```

然后访问：

```text
http://localhost:3090/docs/
```

如果要使用浏览器回归时一致的根路径，可以直接把 `docs` 目录作为站点根目录：

```bash
python3 -m http.server 3090 --directory docs
```

然后访问：

```text
http://localhost:3090/
```

## 验证

发布前建议运行：

```bash
node --check docs/js/main.js
npm run test:smoke
```

smoke test 会检查桌面端和移动端渲染、学校名称移除、语言切换、移动菜单、主要按钮锚点、底部回到顶部、详情展开、图片渲染以及教育荣誉高亮。

## 部署

本仓库用于 GitHub Pages。网站内容位于 `docs/` 目录；提交到 `main` 后，GitHub Pages 可以从该目录发布最新作品集。

## 开源协议

本项目使用 MIT License。
