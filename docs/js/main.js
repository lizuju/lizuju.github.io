// Repository configuration
const REPO_OWNER = 'lizuju';
const REPO_NAME = 'lizuju.github.io';
const BRANCH = 'main';

// Cache busting version (update this when content changes)
const CACHE_VERSION = Date.now();

// i18n translations
const I18N = {
    en: {
        skills: 'Categories',
        onThisPage: 'On This Page',
        loading: 'Loading...',
        installation: 'Contact',
        installNaturalDesc: 'Feel free to reach out:',
        installNaturalExample: 'li2096870763@gmail.com',
        installDesc: 'Contact Information:',
        addMarketplace: 'Email',
        installSkills: 'Phone: 13113356348',
        moreOptions: 'More about me',
        titleSuffix: "'s Portfolio",
        whyUseThis: 'Highlights',
        painPoints: 'Key Points',
        triggersTitle: 'Details',
        triggersDesc: 'Key achievements and highlights:'
    },
    'zh-CN': {
        skills: '分类导航',
        onThisPage: '本页目录',
        loading: '加载中...',
        installation: '联系方式',
        installNaturalDesc: '欢迎联系我：',
        installNaturalExample: 'li2096870763@gmail.com',
        installDesc: '联系方式：',
        addMarketplace: '邮箱',
        installSkills: '电话：13113356348',
        moreOptions: '了解更多',
        titleSuffix: ' 的个人主页',
        whyUseThis: '亮点',
        painPoints: '要点',
        triggersTitle: '详情',
        triggersDesc: '主要成就与亮点：'
    }
};

// Marketing content for each category
const SKILL_MARKETING = {
    'education': {
        en: {
            headline: 'Guangzhou Nanfang College — Computer Science & Technology',
            why: 'Ranked 3rd out of 219 students. Two-time National Scholarship recipient with multiple academic honors including Inspirational Role Model and Annual Character of the Year.',
            painPoints: [
                { icon: '🏆', title: 'Rank: 3/219', desc: 'Outstanding academic performance throughout university.' },
                { icon: '🎓', title: 'Two National Scholarships', desc: 'Awarded China\'s most prestigious undergraduate scholarship twice.' },
                { icon: '🌍', title: 'Trilingual', desc: 'Fluent in English, Mandarin Chinese, and Cantonese.' }
            ],
            triggers: ['2022.09 - 2026.06', 'Bachelor of Computer Science']
        },
        'zh-CN': {
            headline: '广州南方学院 — 计算机科学与技术',
            why: '综合排名 3/219。两次获得国家奖学金，荣获励志榜样、大学生年度人物等多项荣誉。',
            painPoints: [
                { icon: '🏆', title: '排名：3/219', desc: '大学期间优异的学术表现。' },
                { icon: '🎓', title: '两届国家奖学金', desc: '两次获得中国最高荣誉的本科奖学金。' },
                { icon: '🌍', title: '三语能力', desc: '熟练使用英语、普通话和广东话。' }
            ],
            triggers: ['2022.09 - 2026.06', '计算机科学与技术本科']
        }
    },
    'technical-skills': {
        en: {
            headline: 'Full-stack & Computer Vision Engineer',
            why: 'Proficient in C++, Python, and full-stack web development (Flask + Vue). Deep experience in computer vision (OpenCV, YOLOv5), robotics, and Linux system programming.',
            painPoints: [
                { icon: '💻', title: 'C++ / Python / Full-Stack', desc: 'OOP design, Flask backend, Vue frontend, MySQL database.' },
                { icon: '👁️', title: 'Computer Vision & Deep Learning', desc: 'OpenCV, YOLOv5, industrial camera calibration, CUDA acceleration.' },
                { icon: '🤖', title: 'Robotics & Embedded Systems', desc: 'Sensor fusion, pose estimation, MiniPC optimization, multi-threaded Linux programming.' }
            ],
            triggers: ['C++, Python, Flask, Vue, MySQL', 'OpenCV, YOLOv5, CUDA, Linux, Git']
        },
        'zh-CN': {
            headline: '全栈 & 计算机视觉工程师',
            why: '熟练掌握 C++、Python 及全栈开发（Flask + Vue）。在计算机视觉（OpenCV、YOLOv5）、机器人开发和 Linux 系统编程方面有深厚经验。',
            painPoints: [
                { icon: '💻', title: 'C++ / Python / 全栈开发', desc: '面向对象设计，Flask 后端，Vue 前端，MySQL 数据库。' },
                { icon: '👁️', title: '计算机视觉与深度学习', desc: 'OpenCV、YOLOv5、工业相机标定、CUDA 加速。' },
                { icon: '🤖', title: '机器人与嵌入式系统', desc: '传感器融合、姿态解算、MiniPC 优化、Linux 多线程编程。' }
            ],
            triggers: ['C++, Python, Flask, Vue, MySQL', 'OpenCV, YOLOv5, CUDA, Linux, Git']
        }
    },
    'projects': {
        en: {
            headline: 'Three Major Projects — Vision, Full-Stack & AI',
            why: 'Led three significant projects spanning robotics vision systems, inventory management platforms, and AI-powered garbage classification, all from architecture design to deployment.',
            painPoints: [
                { icon: '🎯', title: 'RoboMaster Vision System', desc: 'Auto-aiming robot with OpenCV + YOLOv5 + CUDA on embedded platforms (2022-2025).' },
                { icon: '📦', title: 'Inventory Management System', desc: 'Full-stack system with machine vision + radar modeling for warehouse automation (2023-2024).' },
                { icon: '♻️', title: 'Garbage Classification System', desc: 'Innovative CLIP + Milvus vector search architecture for extensible recognition (2024-2025).' }
            ],
            triggers: ['Vision Team Leader & Project Lead', 'Full-Stack Developer & Project Lead']
        },
        'zh-CN': {
            headline: '三大项目 — 视觉、全栈与人工智能',
            why: '主导三个重要项目，涵盖机器人视觉系统、库存管理平台和 AI 垃圾分类识别，从架构设计到部署上线全程负责。',
            painPoints: [
                { icon: '🎯', title: 'RoboMaster 视觉系统', desc: '基于 OpenCV + YOLOv5 + CUDA 的嵌入式自动瞄准机器人（2022-2025）。' },
                { icon: '📦', title: '货物盘点管理系统', desc: '基于机器视觉 + 雷达建模的全栈仓储自动化系统（2023-2024）。' },
                { icon: '♻️', title: '垃圾分类识别系统', desc: '创新 CLIP + Milvus 向量检索架构的可扩展识别平台（2024-2025）。' }
            ],
            triggers: ['视觉组组长 & 项目负责人', '全栈开发 & 项目负责人']
        }
    },
    'awards': {
        en: {
            headline: '30+ Awards Across Competitions & Innovation Projects',
            why: 'Extensive competition experience spanning robotics (RoboMaster), mathematical modeling (MCM M Prize), IT skills, and innovation & entrepreneurship projects with national-level completions.',
            painPoints: [
                { icon: '🤖', title: 'RoboMaster', desc: '5 provincial awards across Infantry & 3V3 combat competitions.' },
                { icon: '📐', title: 'Mathematical Modeling', desc: 'MCM Global M Prize, 2 provincial first prizes, multiple national awards.' },
                { icon: '🚀', title: 'Innovation & Entrepreneurship', desc: '2 national-level and 4 provincial-level project completions, plus 1 patent and 4 software copyrights.' }
            ],
            triggers: ['National Scholarship × 2', 'MCM Meritorious Winner', 'Chuanzhi Cup National First Prize']
        },
        'zh-CN': {
            headline: '30+ 项竞赛与创新项目荣誉',
            why: '丰富的竞赛经历，涵盖机器人（RoboMaster）、数学建模（美赛M奖）、IT 技能及创新创业项目，多个国家级结项。',
            painPoints: [
                { icon: '🤖', title: 'RoboMaster 机甲大师', desc: '步兵对抗赛与3V3对抗赛共获5项省级奖项。' },
                { icon: '📐', title: '数学建模', desc: '美赛全球M奖、2项省级一等奖、多项国家级奖项。' },
                { icon: '🚀', title: '创新创业', desc: '2项国家级结项、4项省级结项，1项实用型专利、4项软著。' }
            ],
            triggers: ['国家奖学金 × 2', '美赛M奖', '传智杯国家级一等奖']
        }
    }
};

// Categories configuration with SVG icons
const SKILLS = {
    'education': {
        title: 'Education',
        description: '教育背景',
        icon: '<path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c0 2 4 3 6 3s6-1 6-3v-5"/>'
    },
    'technical-skills': {
        title: 'Technical Skills',
        description: '专业技能',
        icon: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>'
    },
    'projects': {
        title: 'Projects',
        description: '项目经历',
        icon: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>'
    },
    'awards': {
        title: 'Awards',
        description: '个人荣誉',
        icon: '<circle cx="12" cy="8" r="7"/><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"/>'
    }
};

// Generate skill icon SVG
function skillIcon(skillId, size = 18) {
    const skill = SKILLS[skillId];
    if (!skill) return '';
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${skill.icon}</svg>`;
}

// Render skill lists dynamically
function renderSkillLists() {
    const currentSkill = new URLSearchParams(window.location.search).get('skill') || DEFAULT_SKILL;

    // 1. Navbar dropdown
    const navDropdown = document.getElementById('navSkillList');
    if (navDropdown) {
        navDropdown.innerHTML = Object.keys(SKILLS).map(id => `
            <a href="?skill=${id}">${skillIcon(id, 16)} ${id}</a>
        `).join('');
    }

    // 2. Mobile menu
    const mobileMenu = document.getElementById('mobileSkillList');
    if (mobileMenu) {
        mobileMenu.innerHTML = Object.keys(SKILLS).map(id => `
            <a href="?skill=${id}">${id}</a>
        `).join('');
    }

    // 3. Sidebar
    const sidebar = document.getElementById('sidebarSkillList');
    if (sidebar) {
        sidebar.innerHTML = Object.keys(SKILLS).map(id => `
            <a class="sidebar-link${id === currentSkill ? ' active' : ''}" href="?skill=${id}">
                ${skillIcon(id)} ${id}
            </a>
        `).join('');
    }
}

// Render contact info dynamically
function renderInstallCode() {
    const installCode = document.getElementById('installCode');
    if (!installCode) return;

    const t = I18N[currentLang];

    installCode.innerHTML = `<div class="install-natural">
<p class="install-natural-desc">${t.installNaturalDesc}</p>
<div class="install-natural-example">"${t.installNaturalExample}"</div>
</div>
<pre><code><span class="comment"># ${t.addMarketplace}</span>
<span class="cmd">li2096870763@gmail.com</span>

<span class="comment"># ${t.installSkills}</span>
<span class="cmd">13113356348</span></code></pre>`;
}

// Default skill to show
const DEFAULT_SKILL = 'education';

// Current language
let currentLang = localStorage.getItem('docs-lang') || 'en';

// User info cache
let userInfo = null;

// Detect if running on GitHub Pages or locally
function getBasePath(skillName, lang = 'en') {
    const isGitHubPages = window.location.hostname.includes('github.io') ||
        window.location.hostname === 'skill.lizuju.me' ||
        window.location.hostname === 'lizuju.me';

    // Determine file name based on language
    const fileName = lang === 'en' ? 'SKILL.md' : `SKILL.${lang}.md`;

    if (isGitHubPages) {
        // Add cache busting for GitHub raw content
        return `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${BRANCH}/${skillName}/${fileName}?v=${CACHE_VERSION}`;
    } else {
        // Add cache busting for local development
        return `../${skillName}/${fileName}?v=${CACHE_VERSION}`;
    }
}

// Fetch GitHub user info
async function fetchUserInfo() {
    if (userInfo) return userInfo;

    try {
        const response = await fetch(`https://api.github.com/users/${REPO_OWNER}`);
        if (response.ok) {
            userInfo = await response.json();
            return userInfo;
        }
    } catch (error) {
        console.log('Could not fetch GitHub user info:', error);
    }

    // Fallback
    return {
        login: REPO_OWNER,
        name: REPO_OWNER,
        avatar_url: `https://github.com/${REPO_OWNER}.png`
    };
}

// Update brand title with user name
async function updateBrandTitle() {
    const user = await fetchUserInfo();
    const displayName = user.name || user.login;
    const suffix = I18N[currentLang].titleSuffix;

    // Update brand title
    const brandTitle = document.getElementById('brandTitle');
    if (brandTitle) {
        brandTitle.innerHTML = `<span class="brand-name">${displayName}</span>${suffix}`;
    }

    // Update avatar
    const avatar = document.getElementById('userAvatar');
    if (avatar) {
        avatar.src = user.avatar_url;
        avatar.alt = displayName;
    }

    // Update favicon to user's avatar
    const favicon = document.getElementById('favicon');
    if (favicon) {
        favicon.href = user.avatar_url;
    }

    // Update repo link
    const repoLink = document.getElementById('repoLink');
    if (repoLink) {
        repoLink.href = `https://github.com/${REPO_OWNER}/${REPO_NAME}`;
    }

    // Update page title
    document.title = `${displayName}${suffix}`;
}

// Apply i18n translations
function applyI18n() {
    const translations = I18N[currentLang];

    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        if (translations[key]) {
            el.textContent = translations[key];
        }
    });

    // Update HTML lang attribute
    document.documentElement.lang = currentLang === 'zh-CN' ? 'zh-CN' : 'en';

    // Update active language button
    document.querySelectorAll('.lang-btn').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-lang') === currentLang);
    });

    // Update brand title
    updateBrandTitle();
}

// Set language
function setLanguage(lang) {
    currentLang = lang;
    localStorage.setItem('docs-lang', lang);
    applyI18n();

    // Update install code with new language
    renderInstallCode();

    // Reload documentation with new language
    const skillName = getCurrentSkill();
    loadDocumentation(skillName);
}

// Setup language switcher
function setupLanguageSwitcher() {
    document.querySelectorAll('.lang-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const lang = btn.getAttribute('data-lang');
            setLanguage(lang);
        });
    });
}

// Configure marked
marked.setOptions({
    breaks: true,
    gfm: true
});

// Render triggers section for a skill
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

// Render marketing section for a skill
function renderMarketingSection(skillName) {
    const marketing = SKILL_MARKETING[skillName];
    if (!marketing) return '';

    const content = marketing[currentLang] || marketing['en'];
    if (!content) return '';

    const t = I18N[currentLang];

    const painPointsHtml = content.painPoints.map(point => `
        <div class="pain-point-card">
            <div class="pain-point-icon">${point.icon}</div>
            <div class="pain-point-content">
                <h4 class="pain-point-title">${point.title}</h4>
                <p class="pain-point-desc">${point.desc}</p>
            </div>
        </div>
    `).join('');

    const triggersHtml = renderTriggersSection(skillName);

    return `
        <div class="marketing-section">
            <div class="marketing-headline">
                <h2 class="marketing-title">${content.headline}</h2>
            </div>
            <div class="marketing-why">
                <p>${content.why}</p>
            </div>
            <div class="marketing-pain-points">
                <h3 class="pain-points-title">${t.painPoints}</h3>
                <div class="pain-points-grid">
                    ${painPointsHtml}
                </div>
            </div>
            ${triggersHtml}
        </div>
    `;
}

// Post-process HTML to add IDs to headings
function addHeadingIds(html) {
    return html.replace(/<h([1-6])>(.*?)<\/h[1-6]>/gi, (match, level, text) => {
        const id = text
            .toLowerCase()
            .replace(/<[^>]*>/g, '')
            .replace(/[^\w\s\u4e00-\u9fa5-]/g, '')
            .replace(/\s+/g, '-')
            .replace(/-+/g, '-')
            .trim();
        return `<h${level} id="${id}">${text}</h${level}>`;
    });
}

// Get current skill from URL
function getCurrentSkill() {
    const params = new URLSearchParams(window.location.search);
    return params.get('skill') || DEFAULT_SKILL;
}

// Update active nav link
function updateActiveNav(skillName) {
    // Update sidebar links
    document.querySelectorAll('.sidebar-link').forEach(link => {
        link.classList.remove('active');
        if (link.href.includes(`skill=${skillName}`)) {
            link.classList.add('active');
        }
    });

    // Update dropdown links
    document.querySelectorAll('.nav-dropdown-content a').forEach(link => {
        link.classList.remove('active');
        if (link.href.includes(`skill=${skillName}`)) {
            link.classList.add('active');
        }
    });
}

// Fetch and render the Markdown file
async function loadDocumentation(skillName) {
    const skill = SKILLS[skillName];

    if (!skill) {
        document.getElementById('content').innerHTML = `
            <div class="alert alert-danger">
                <h4>Skill Not Found</h4>
                <p>The skill "${skillName}" does not exist.</p>
                <p>Available skills: ${Object.keys(SKILLS).join(', ')}</p>
            </div>`;
        return;
    }

    // Try loading language-specific file first, fallback to English
    let skillPath = getBasePath(skillName, currentLang);
    let fallbackToEnglish = false;

    console.log('Loading skill:', skillName);
    console.log('Language:', currentLang);
    console.log('Path:', skillPath);

    try {
        const loadingText = I18N[currentLang].loading;
        document.getElementById('content').innerHTML = `
            <div class="loading">
                <div class="loading-spinner"></div>
                <p>${loadingText}</p>
            </div>`;

        let response = await fetch(skillPath);
        console.log('Response status:', response.status);

        // If language-specific file not found, fallback to English
        if (!response.ok && currentLang !== 'en') {
            console.log('Language-specific file not found, falling back to English');
            skillPath = getBasePath(skillName, 'en');
            response = await fetch(skillPath);
            fallbackToEnglish = true;
        }

        if (!response.ok) {
            throw new Error(`Failed to load: ${response.status}`);
        }

        let markdown = await response.text();

        // Remove YAML frontmatter
        markdown = markdown.replace(/^---[\s\S]*?---\n*/m, '');

        // Parse and render
        let html = marked.parse(markdown);
        html = addHeadingIds(html);

        // Add marketing section before the main content
        const marketingHtml = renderMarketingSection(skillName);
        document.getElementById('content').innerHTML = marketingHtml + html;

        // Update page title
        const user = await fetchUserInfo();
        const displayName = user.name || user.login;
        document.title = `${skill.title} - ${displayName}${I18N[currentLang].titleSuffix}`;

        // Highlight code blocks
        document.querySelectorAll('pre code').forEach((block) => {
            hljs.highlightElement(block);
        });

        // Initialize table of contents
        setTimeout(() => {
            tocbot.destroy();
            tocbot.init({
                tocSelector: '.js-toc',
                contentSelector: '.js-toc-content',
                headingSelector: 'h1, h2, h3',
                scrollSmooth: true,
                scrollSmoothDuration: 300,
                headingsOffset: 100,
                scrollSmoothOffset: -100
            });
        }, 100);

        // Update active nav
        updateActiveNav(skillName);

    } catch (error) {
        console.error('Error loading documentation:', error);
        document.getElementById('content').innerHTML = `
            <div class="alert alert-danger">
                <h4>Error Loading Documentation</h4>
                <p>${error.message}</p>
                <p>Path: ${skillPath}</p>
            </div>`;
    }
}

// Mobile menu toggle
function toggleMobileMenu() {
    const mobileMenu = document.getElementById('mobileMenu');
    mobileMenu.classList.toggle('active');
}

// Close mobile menu when clicking a link
function setupMobileMenuLinks() {
    document.querySelectorAll('.mobile-menu-content a').forEach(link => {
        link.addEventListener('click', () => {
            document.getElementById('mobileMenu').classList.remove('active');
        });
    });
}

// Handle URL changes (for SPA-like navigation)
function handleNavigation() {
    const skillName = getCurrentSkill();
    loadDocumentation(skillName);
}

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
    // Render dynamic skill lists
    renderSkillLists();

    // Render install code
    renderInstallCode();

    // Setup language switcher
    setupLanguageSwitcher();

    // Apply initial i18n
    applyI18n();

    // Fetch user info and update UI
    await fetchUserInfo();
    await updateBrandTitle();

    // Handle navigation
    handleNavigation();
    setupMobileMenuLinks();
});

// Handle popstate for back/forward navigation
window.addEventListener('popstate', handleNavigation);
