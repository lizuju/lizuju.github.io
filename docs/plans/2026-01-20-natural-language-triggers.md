# Natural Language Triggers Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add natural language trigger examples and installation recommendations to share-skill generated documentation pages.

**Architecture:** Modify SKILL.md templates to include triggers field in SKILL_MARKETING, add renderTriggersSection function, update installation HTML template, and extend i18n configuration.

**Tech Stack:** Markdown templates, JavaScript (main.js templates), CSS class descriptions

---

## Task 1: Add Triggers to SKILL_MARKETING Template

**Files:**
- Modify: `share-skill/SKILL.md:1282-1320` (SKILL_MARKETING data structure)

**Step 1: Read the current SKILL_MARKETING template**

Verify the exact content at lines 1282-1320.

**Step 2: Update SKILL_MARKETING template to include triggers field**

Find this block (around line 1284-1320):
```javascript
const SKILL_MARKETING = {
    'skill-name': {
        en: {
            headline: 'Compelling one-liner value proposition',
            why: 'Detailed explanation of why this skill exists and how it helps users...',
            painPoints: [
                {
                    icon: '🔥',
                    title: 'Problem Title',
                    desc: 'Description of the problem this skill solves.'
                },
                {
                    icon: '🧠',
                    title: 'Another Problem',
                    desc: 'Description of another pain point.'
                },
                {
                    icon: '💥',
                    title: 'Third Problem',
                    desc: 'Description of the third issue addressed.'
                }
            ]
        },
        'zh-CN': {
            headline: '中文标题',
            why: '中文说明...',
            painPoints: [/* ... */]
        },
        ja: {
            headline: '日本語タイトル',
            why: '日本語説明...',
            painPoints: [/* ... */]
        }
    }
};
```

Replace with:
```javascript
const SKILL_MARKETING = {
    'skill-name': {
        en: {
            headline: 'Compelling one-liner value proposition',
            why: 'Detailed explanation of why this skill exists and how it helps users...',
            painPoints: [
                {
                    icon: '🔥',
                    title: 'Problem Title',
                    desc: 'Description of the problem this skill solves.'
                },
                {
                    icon: '🧠',
                    title: 'Another Problem',
                    desc: 'Description of another pain point.'
                },
                {
                    icon: '💥',
                    title: 'Third Problem',
                    desc: 'Description of the third issue addressed.'
                }
            ],
            triggers: [
                'Example natural language prompt 1',
                'Example natural language prompt 2'
            ]
        },
        'zh-CN': {
            headline: '中文标题',
            why: '中文说明...',
            painPoints: [/* ... */],
            triggers: [
                '自然语言触发示例 1',
                '自然语言触发示例 2'
            ]
        },
        ja: {
            headline: '日本語タイトル',
            why: '日本語説明...',
            painPoints: [/* ... */],
            triggers: [
                '自然言語トリガー例 1',
                '自然言語トリガー例 2'
            ]
        }
    }
};
```

**Step 3: Verify the edit**

Read the modified section to confirm the change.

---

## Task 2: Add Triggers Section Documentation

**Files:**
- Modify: `share-skill/SKILL.md:1340-1347` (after CSS Classes, before Guidelines)

**Step 1: Add triggers documentation after CSS Classes**

Find line 1340 (`.pain-point-card` description) and add after line 1340, before "**Guidelines for Writing Marketing Content:**":

```markdown

**Triggers Section (Natural Language Examples):**

Display 2-3 example phrases users can say to trigger this skill. Shown below pain points.

```javascript
// triggers field in SKILL_MARKETING
triggers: [
    'Help me allocate a port for my project',
    'Start the dev server for me'
]
```

**Render Function:**

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

**CSS Classes for Triggers:**
- `.triggers-section` - Container with subtle background
- `.triggers-title` - Section heading with emoji
- `.triggers-desc` - Instruction text
- `.triggers-list` - Vertical list of examples
- `.trigger-item` - Individual example with left border accent
- `.trigger-quote` - Italic quoted text

```

**Step 2: Verify the edit**

Read lines 1335-1400 to confirm the insertion.

---

## Task 3: Update Installation Section HTML Template

**Files:**
- Modify: `share-skill/SKILL.md:1395-1412` (Installation HTML template)

**Step 1: Update the installation HTML template**

Find the current template (around line 1395-1412):
```html
<aside class="sidebar-right glass">
    <div class="sidebar-content">
        <div class="sidebar-section">
            <h4 class="sidebar-heading" data-i18n="installation">Installation</h4>
            <p class="install-desc" data-i18n="installDesc">The easiest way to install:</p>
            <div class="install-code">
                <pre><code><span class="comment"># <span data-i18n="addMarketplace">Add marketplace</span></span>
<span class="cmd">/plugin marketplace add {username}/{repo}</span>

<span class="comment"># <span data-i18n="installSkills">Install skills</span></span>
<span class="cmd">/plugin install {skill-name}@{username}-{repo}</span></code></pre>
            </div>
            <a class="install-link" href="https://github.com/{username}/{repo}#installation" target="_blank" data-i18n="moreOptions">More installation options</a>
        </div>
    </div>
</aside>
```

Replace with:
```html
<aside class="sidebar-right glass">
    <div class="sidebar-content">
        <div class="sidebar-section">
            <h4 class="sidebar-heading" data-i18n="installation">Installation</h4>

            <!-- Natural language installation recommendation -->
            <div class="install-natural">
                <p class="install-natural-desc" data-i18n="installNaturalDesc">We recommend installing via natural language:</p>
                <div class="install-natural-example">
                    "<span data-i18n="installNaturalExample">Please help me install this skill:</span> https://github.com/{username}/{repo}"
                </div>
            </div>

            <!-- Command line installation -->
            <p class="install-desc" data-i18n="installDesc">The easiest way to install:</p>
            <div class="install-code">
                <pre><code><span class="comment"># <span data-i18n="addMarketplace">Add marketplace</span></span>
<span class="cmd">/plugin marketplace add {username}/{repo}</span>

<span class="comment"># <span data-i18n="installSkills">Install skills</span></span>
<span class="cmd">/plugin install {skill-name}@{username}-{repo}</span></code></pre>
            </div>
            <a class="install-link" href="https://github.com/{username}/{repo}#installation" target="_blank" data-i18n="moreOptions">More installation options</a>
        </div>
    </div>
</aside>
```

**Step 2: Verify the edit**

Read lines 1390-1420 to confirm the change.

---

## Task 4: Update i18n Configuration

**Files:**
- Modify: `share-skill/SKILL.md:1416-1439` (I18N configuration)

**Step 1: Update i18n configuration with new keys**

Find the current I18N config (lines 1416-1439):
```javascript
const I18N = {
    en: {
        installation: 'Installation',
        installDesc: 'The easiest way to install:',
        addMarketplace: 'Add marketplace',
        installSkills: 'Install skills',
        moreOptions: 'More installation options'
    },
    'zh-CN': {
        installation: '安装方法',
        installDesc: '最简单的安装方式：',
        addMarketplace: '添加技能市场',
        installSkills: '安装技能',
        moreOptions: '更多安装选项'
    },
    ja: {
        installation: 'インストール',
        installDesc: '最も簡単なインストール方法：',
        addMarketplace: 'マーケットプレイスを追加',
        installSkills: 'スキルをインストール',
        moreOptions: 'その他のインストールオプション'
    }
};
```

Replace with:
```javascript
const I18N = {
    en: {
        installation: 'Installation',
        installNaturalDesc: 'We recommend installing via natural language:',
        installNaturalExample: 'Please help me install this skill:',
        installDesc: 'The easiest way to install:',
        addMarketplace: 'Add marketplace',
        installSkills: 'Install skills',
        moreOptions: 'More installation options',
        triggersTitle: 'How to Use',
        triggersDesc: 'Trigger this skill with natural language:'
    },
    'zh-CN': {
        installation: '安装方法',
        installNaturalDesc: '我们推荐使用自然语言安装：',
        installNaturalExample: '请帮我安装这个 skill：',
        installDesc: '最简单的安装方式：',
        addMarketplace: '添加技能市场',
        installSkills: '安装技能',
        moreOptions: '更多安装选项',
        triggersTitle: '如何调用',
        triggersDesc: '使用自然语言即可触发此 skill：'
    },
    ja: {
        installation: 'インストール',
        installNaturalDesc: '自然言語でのインストールをお勧めします：',
        installNaturalExample: 'このスキルをインストールしてください：',
        installDesc: '最も簡単なインストール方法：',
        addMarketplace: 'マーケットプレイスを追加',
        installSkills: 'スキルをインストール',
        moreOptions: 'その他のインストールオプション',
        triggersTitle: '使い方',
        triggersDesc: '自然言語でこのスキルを呼び出せます：'
    }
};
```

**Step 2: Verify the edit**

Read lines 1414-1450 to confirm the change.

---

## Task 5: Add CSS Class Descriptions for Install Natural

**Files:**
- Modify: `share-skill/SKILL.md` (after Task 3's HTML, add CSS class descriptions)

**Step 1: Add CSS class descriptions after installation HTML template**

After the `</aside>` closing tag of the installation template, add:

```markdown

**CSS Classes for Natural Language Installation:**
- `.install-natural` - Container with bottom border separator
- `.install-natural-desc` - Recommendation text
- `.install-natural-example` - Quoted example with left border accent
```

**Step 2: Verify the edit**

Read the section to confirm.

---

## Task 6: Update Step 8.2 Instructions

**Files:**
- Modify: `share-skill/SKILL.md:534-553` (Step 8.2 SKILL_MARKETING update instructions)

**Step 1: Read current Step 8.2 content**

Verify exact content at lines 534-553.

**Step 2: Update Step 8.2 to include triggers generation**

Find the current template in Step 8.2:
```javascript
   const SKILL_MARKETING = {
       // ... existing skills
       '<skill-name>': {
           en: {
               headline: '<generated from skill description>',
               why: '<generated explanation>',
               painPoints: [
                   { icon: '🔥', title: '...', desc: '...' },
                   { icon: '🧠', title: '...', desc: '...' },
                   { icon: '💥', title: '...', desc: '...' }
               ]
           },
           'zh-CN': { /* Chinese translation */ },
           ja: { /* Japanese translation */ }
       }
   };
```

Replace with:
```javascript
   const SKILL_MARKETING = {
       // ... existing skills
       '<skill-name>': {
           en: {
               headline: '<generated from skill description>',
               why: '<generated explanation>',
               painPoints: [
                   { icon: '🔥', title: '...', desc: '...' },
                   { icon: '🧠', title: '...', desc: '...' },
                   { icon: '💥', title: '...', desc: '...' }
               ],
               triggers: [
                   '<natural language example 1>',
                   '<natural language example 2>'
               ]
           },
           'zh-CN': { /* Chinese translation including triggers */ },
           ja: { /* Japanese translation including triggers */ }
       }
   };
```

**Step 3: Verify the edit**

Read lines 530-560 to confirm.

---

## Task 7: Commit Changes

**Step 1: Review all changes**

```bash
git diff share-skill/SKILL.md
```

**Step 2: Commit**

```bash
git add share-skill/SKILL.md docs/plans/
git commit -m "feat(share-skill): add natural language triggers and install recommendations

- Add triggers field to SKILL_MARKETING template for natural language examples
- Add renderTriggersSection function template
- Add natural language installation recommendation to sidebar
- Extend i18n with triggersTitle, triggersDesc, installNaturalDesc, installNaturalExample
- Update Step 8.2 to include triggers generation"
```

---

## Verification

After implementation, test by calling `/share-skill docs` on a skill repository. The generated documentation should:

1. Display 2-3 natural language trigger examples below pain points (if triggers configured)
2. Show natural language installation recommendation above command-line instructions in right sidebar
3. Support all three languages (en, zh-CN, ja)
