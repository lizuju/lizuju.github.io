<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh-CN.md">简体中文</a>
</p>

# 🚀 李祖钜 Gavin 的个人主页

欢迎来到我的个人主页开源库！这是一个精心设计、轻量级且极具现代感的主页系统。用来展示我的教育背景、全栈开发技能、项目历程以及各项省级、国家级竞赛荣誉。

你可以在这里访问我的线上主页：[lizuju.github.io](https://lizuju.github.io/)

---

## ✨ 核心特性

- **现代玻璃拟态交互 UI (Glassmorphism):** 采用原生 CSS (backdrop-filter) 与丝滑动态渐变背景打造的沉浸式极简科技风。
- **Markdown 动态渲染技术:** 网站利用 JavaScript 动态拉取 Markdown 文件解析。如果需要更新网站的内容，你不用去改 HTML/JS 代码，只需更新 `.md` 文件并 PUSH 即可！
- **原生中英双语支持 (i18n):** 支持在中文与英文间进行无缝、零延迟的界面语言与文章内容切换。
- **完美响应式布局:** 从大屏双栏排版到手机端独立弹出式菜单，全屏幕尺寸兼容。
- **动态全屏弹窗:** 提供美观顺滑的联系方式弹窗（点击右上方 Contact 呼出）。
- **零构建依赖极简架构:** 纯正 HTML/CSS/JS 三剑客！只采用了几个基础 CDN 插件 (`marked.js`, `highlight.js`, `tocbot`)，不依赖任何如 Webpack、Vite 的繁重打包工具。

## 📂 项目结构（四大基石）

主页的内容主要储存在以下四个 Markdown 文件夹内：

- 🎓 **`education/` (教育背景)**: 展示院校信息、GPA、两次国家奖学金获得记录及英中粤三语能力。
- 💻 **`technical-skills/` (专业技能)**: 概述我对 C++、Python、CV 计算机视觉、全栈工程及机器人的掌握。
- 📋 **`projects/` (项目经历)**: 我所主导的三个重大系统：RoboMaster 视觉中控、仓储盘点管理系统、以及 AI 垃圾分类识别系统。
- 🏆 **`awards/` (个人荣誉)**: 包括数学建模美赛 M 奖、大创国家级项目在内的 30 多项重要奖项。

## 🛠️ 本地运行指南

如果你想在本地跑起这个项目，非常简单：

1. 克隆本仓库:
   ```bash
   git clone https://github.com/lizuju/lizuju.github.io.git
   cd lizuju.github.io
   ```

2. 开启一个本地 Web 服务器:
   ```bash
   # 如果你的环境有 Node.js
   npm run dev

   # 或者使用 Python 自带的服务
   python3 -m http.server 3090
   ```

3. 打开浏览器并访问:
   ```
   http://localhost:3090/docs/
   ```

## 📝 如何更新网站内容
如需更改左侧栏里的文字、文章、标题等，**无需**编辑任何前端代码，直接去对应目录（如 `projects/SKILL.zh-CN.md`）修改文案即可，十分优雅！

## 📄 开源协议
本项目采用 MIT 协议进行开源，欢迎参考与探索！