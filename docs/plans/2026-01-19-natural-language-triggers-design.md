# share-skill 自然语言功能增强设计

## 概述

为 share-skill 生成的文档页面新增两个功能：
1. 在痛点下方展示自然语言触发示例
2. 在安装方法处推荐自然语言安装方式

## 核心理解

**share-skill 是一个文档生成工具**，真正的"源代码"是 `SKILL.md`。当用户调用 `/share-skill docs` 时，它根据 SKILL.md 中的模板和指令生成 `docs/` 目录下的文件。

因此，需要修改的是 `./share-skill/SKILL.md`，而不是直接修改 `docs/` 目录。

## 需要修改的文件

**唯一需要修改的文件：** `./share-skill/SKILL.md`

修改位置：
1. **Section 6 (Marketing Section)** - 添加 triggers 字段的文档说明
2. **Step 8.2** - 更新 SKILL_MARKETING 模板，包含 triggers 字段
3. **Section 8 (Right Sidebar - Installation Section)** - 添加自然语言安装推荐的 HTML 模板
4. **i18n 配置示例** - 添加新的翻译键

## 功能一：自然语言触发示例

### 1.1 修改 Section 6 (Marketing Section)

在 `#### 6. Marketing Section` 部分，在 Pain Points 说明后添加：
- **Triggers**: 2-3 个自然语言触发示例

### 1.2 修改 SKILL_MARKETING 数据结构模板

位置：约第 1282-1320 行

**修改前：**
```javascript
const SKILL_MARKETING = {
    'skill-name': {
        en: {
            headline: '...',
            why: '...',
            painPoints: [...]
        }
    }
};
```

**修改后：**
```javascript
const SKILL_MARKETING = {
    'skill-name': {
        en: {
            headline: '...',
            why: '...',
            painPoints: [...],
            // 新增
            triggers: [
                'Help me allocate a port for my project',
                'Start the dev server for me'
            ]
        },
        'zh-CN': {
            headline: '...',
            why: '...',
            painPoints: [...],
            triggers: [
                '帮我为项目自动分配端口',
                '帮我启动开发服务器'
            ]
        },
        ja: {
            headline: '...',
            why: '...',
            painPoints: [...],
            triggers: [
                'プロジェクトにポートを自動割り当てしてください',
                '開発サーバーを起動してください'
            ]
        }
    }
};
```

### 1.3 添加 renderTriggersSection 函数模板

在 `renderMarketingSection` 函数说明后添加：

```javascript
function renderTriggersSection(skillName) {
    const marketing = SKILL_MARKETING[skillName];
    if (!marketing) return '';

    const content = marketing[currentLang] || marketing['en'];
    if (!content || !content.triggers || content.triggers.length === 0) return '';

    const t = I18N[currentLang];

    const triggersHtml = content.triggers.map(trigger => `
        <div class="trigger-item">
            <span class="trigger-quote">"${trigger}"</span>
        </div>
    `).join('');

    return `
        <div class="triggers-section">
            <h3 class="triggers-title">💬 ${t.triggersTitle}</h3>
            <p class="triggers-desc">${t.triggersDesc}</p>
            <div class="triggers-list">
                ${triggersHtml}
            </div>
        </div>
    `;
}
```

### 1.4 添加 triggers CSS 样式模板

在 CSS 模板部分添加：

```css
/* Triggers Section */
.triggers-section {
    margin-top: 2rem;
    padding: 1.5rem;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid var(--glass-border);
    border-radius: 12px;
}

.triggers-title {
    font-size: 1.1rem;
    font-weight: 600;
    margin: 0 0 0.5rem 0;
    color: var(--color-text);
}

.triggers-desc {
    font-size: 0.875rem;
    color: var(--color-text-muted);
    margin: 0 0 1rem 0;
}

.triggers-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
}

.trigger-item {
    padding: 0.75rem 1rem;
    background: rgba(59, 130, 246, 0.1);
    border-radius: 8px;
    border-left: 3px solid rgba(59, 130, 246, 0.5);
}

.trigger-quote {
    font-size: 0.9rem;
    color: var(--color-text);
    font-style: italic;
}
```

### 1.5 添加 i18n 翻译键

```javascript
const I18N = {
    en: {
        // ... existing keys
        triggersTitle: 'How to Use',
        triggersDesc: 'Trigger this skill with natural language:'
    },
    'zh-CN': {
        // ... existing keys
        triggersTitle: '如何调用',
        triggersDesc: '使用自然语言即可触发此 skill：'
    },
    ja: {
        // ... existing keys
        triggersTitle: '使い方',
        triggersDesc: '自然言語でこのスキルを呼び出せます：'
    }
};
```

## 功能二：自然语言安装推荐

### 2.1 修改 Section 8 (Right Sidebar - Installation Section)

位置：约第 1391-1412 行

**修改前：**
```html
<aside class="sidebar-right glass">
    <div class="sidebar-content">
        <div class="sidebar-section">
            <h4 class="sidebar-heading" data-i18n="installation">Installation</h4>
            <p class="install-desc" data-i18n="installDesc">The easiest way to install:</p>
            <div class="install-code">...</div>
            ...
        </div>
    </div>
</aside>
```

**修改后：**
```html
<aside class="sidebar-right glass">
    <div class="sidebar-content">
        <div class="sidebar-section">
            <h4 class="sidebar-heading" data-i18n="installation">Installation</h4>

            <!-- 新增：自然语言安装推荐 -->
            <div class="install-natural">
                <p class="install-natural-desc" data-i18n="installNaturalDesc">We recommend installing via natural language:</p>
                <div class="install-natural-example">
                    "<span data-i18n="installNaturalExample">Please help me install this skill:</span> https://github.com/{username}/{repo}"
                </div>
            </div>

            <!-- 现有：命令行安装 -->
            <p class="install-desc" data-i18n="installDesc">The easiest way to install:</p>
            <div class="install-code">...</div>
            ...
        </div>
    </div>
</aside>
```

### 2.2 添加 install-natural CSS 样式

```css
/* Natural Language Install */
.install-natural {
    margin-bottom: 1.5rem;
    padding-bottom: 1.5rem;
    border-bottom: 1px solid var(--glass-border);
}

.install-natural-desc {
    font-size: 0.875rem;
    color: var(--color-text-muted);
    margin: 0 0 0.75rem 0;
}

.install-natural-example {
    padding: 0.75rem 1rem;
    background: rgba(59, 130, 246, 0.1);
    border-radius: 8px;
    border-left: 3px solid rgba(59, 130, 246, 0.5);
    font-size: 0.85rem;
    color: var(--color-text);
    font-style: italic;
    word-break: break-all;
}
```

### 2.3 添加 i18n 翻译键

```javascript
const I18N = {
    en: {
        // ... existing keys
        installNaturalDesc: 'We recommend installing via natural language:',
        installNaturalExample: 'Please help me install this skill:'
    },
    'zh-CN': {
        // ... existing keys
        installNaturalDesc: '我们推荐使用自然语言安装：',
        installNaturalExample: '请帮我安装这个 skill：'
    },
    ja: {
        // ... existing keys
        installNaturalDesc: '自然言語でのインストールをお勧めします：',
        installNaturalExample: 'このスキルをインストールしてください：'
    }
};
```

## 实现步骤

1. 修改 `./share-skill/SKILL.md` 中的 Section 6，添加 triggers 说明
2. 修改 Step 8.2 的 SKILL_MARKETING 模板，包含 triggers 字段
3. 在 Render Function 部分添加 renderTriggersSection 函数模板
4. 修改 Section 8 的 HTML 模板，添加自然语言安装推荐
5. 在 CSS 模板部分添加新样式
6. 在 i18n 配置示例中添加新翻译键
7. 更新 Step 8.2 的说明，提示生成 triggers 内容

## 验证

修改完成后，调用 `/share-skill docs` 生成的文档站点应该：
1. 在每个 skill 的痛点下方显示自然语言触发示例（如果配置了 triggers）
2. 在右侧边栏的安装方法处，显示自然语言安装推荐（在命令行安装上方）
