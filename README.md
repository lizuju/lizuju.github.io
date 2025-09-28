# Gavin Lee 个人简历网站

这是一个纯HTML/CSS/JavaScript的静态个人简历网站，主要用于展示个人技能、经历和获奖证书。

## 网站结构

- **首页** (`index.html`): 个人简历概览
- **关于我** (`about.html`): 详细个人介绍
- **奖状画廊** (`awards.html`): 获奖证书展示

## 如何添加奖状图片

1. 将证书图片放入 `assets/awards/` 目录
2. 编辑 `awards.html` 文件，按照现有格式添加新的证书项目
3. 确保图片文件名简洁明了，建议使用描述性名称

### 图片格式建议
- 推荐使用 JPG 或 PNG 格式
- 建议图片尺寸为 300x200 像素或类似比例
- 文件大小控制在 500KB 以内

## 本地开发

### 环境要求
- 任何现代浏览器
- 本地HTTP服务器（可选，用于开发）

### 运行方式

#### 方式1：直接打开
直接双击 `index.html` 文件在浏览器中打开

#### 方式2：本地服务器（推荐）
```bash
# 使用Python启动本地服务器
python -m http.server 8000

# 或使用Node.js
npx http-server

# 或使用PHP
php -S localhost:8000
```

然后访问 `http://localhost:8000`

## 自定义配置

### 修改个人信息
直接编辑HTML文件中的内容：
- `index.html`: 修改首页信息
- `about.html`: 修改关于我页面
- `awards.html`: 修改奖状展示

### 修改样式
编辑 `assets/css/style.css` 文件来自定义网站样式。

## 部署

### GitHub Pages
1. 将代码推送到GitHub仓库
2. 在仓库设置中启用GitHub Pages
3. 选择main分支作为源
4. 网站将自动部署到 `https://username.github.io/repository-name`

### 其他静态托管服务
- Netlify
- Vercel
- 任何支持静态文件的Web服务器

## 技术栈

- **HTML5**: 页面结构
- **CSS3**: 样式和布局
- **JavaScript**: 交互功能（如需要）
- **GitHub Pages**: 免费托管平台

## 文件结构

```
lizuju.github.io/
├── index.html          # 首页
├── about.html          # 关于我页面
├── awards.html         # 奖状画廊页面
├── assets/
│   ├── css/
│   │   └── style.css   # 样式文件
│   └── awards/         # 奖状图片目录
├── 404.html            # 404错误页面
└── README.md           # 说明文档
```

## 联系方式

- 邮箱: li2096870763@Gmail.com
- 电话: 13113356348
- 微信: gavinxlee
