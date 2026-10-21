(() => {
    const desktopApi = window.GavinDesktop;
    const { t } = desktopApi;
    let revealObserver;

    function renderList(name, items) {
        document.querySelectorAll(`[data-list="${name}"]`).forEach((container) => {
            const tagList = [
                'heroTags',
                'navigationExperienceStack',
                'stemmExperienceStack',
                'educationHighlights'
            ].includes(name);
            container.replaceChildren();
            items.forEach((item) => {
                const element = document.createElement(tagList ? 'span' : 'li');
                element.textContent = item;
                container.append(element);
            });
        });
    }

    function renderProjects(projects, openDetails = []) {
        const container = document.querySelector('[data-projects]');
        if (!container) return;

        const visualTypes = [
            'robomasterAutoAim',
            'robomasterNavigation',
            'vision',
            'inventory',
            'retrieval',
            'resume',
            'recommender'
        ];
        const visualAssets = {
            robomasterAutoAim: 'assets/project-robomaster-autoaim.jpg',
            robomasterNavigation: 'assets/project-robomaster-navigation.jpg',
            vision: 'assets/project-vision.jpg',
            inventory: 'assets/project-inventory.jpg',
            retrieval: 'assets/project-retrieval.jpg',
            resume: 'assets/project-resume-agent.jpg',
            recommender: 'assets/project-taac-recommender.jpg'
        };
        const copy = t();

        container.replaceChildren();
        projects.forEach((project, index) => {
            const visual = visualTypes.includes(project.visual) ? project.visual : 'vision';
            const card = document.createElement('article');
            card.className = `project-card project-card--${visual} reveal`;

            const meta = document.createElement('div');
            meta.className = 'project-index';
            meta.textContent = `${String(index + 1).padStart(2, '0')} / ${project.period}`;

            const media = document.createElement('figure');
            media.className = 'project-media';
            const image = document.createElement('img');
            image.src = visualAssets[visual];
            image.alt = project.alt || project.title;
            image.loading = index === 0 ? 'eager' : 'lazy';
            image.width = 1672;
            image.height = 941;
            media.append(image);

            const body = document.createElement('div');
            body.className = 'project-body';
            const title = document.createElement('h3');
            title.textContent = project.title;
            const role = document.createElement('strong');
            role.className = 'project-role';
            role.textContent = project.role;
            const description = document.createElement('p');
            description.textContent = project.body;
            const tags = document.createElement('div');
            tags.className = 'tags';
            project.tags.slice(0, 5).forEach((tag) => {
                const tagElement = document.createElement('span');
                tagElement.textContent = tag;
                tags.append(tagElement);
            });

            const detailsDrawer = document.createElement('details');
            detailsDrawer.className = 'project-details';
            detailsDrawer.open = Boolean(openDetails[index]);
            const summary = document.createElement('summary');
            summary.textContent = copy.projectDetailLabel;
            const details = document.createElement('ul');
            details.className = 'detail-list';
            project.details.forEach((detail) => {
                const item = document.createElement('li');
                item.textContent = detail;
                details.append(item);
            });
            detailsDrawer.append(summary, details);

            const result = document.createElement('p');
            result.className = 'result-line';
            result.textContent = project.result;
            body.append(meta, title, role, description, tags, detailsDrawer, result);

            if (project.link) {
                const link = document.createElement('a');
                link.className = 'project-link';
                link.href = project.link;
                link.target = '_blank';
                link.rel = 'noreferrer';
                link.textContent = copy.projectGitHub;
                body.append(link);
            }

            card.append(media, body);
            container.append(card);
        });
    }

    function renderMethods(methods) {
        const container = document.querySelector('[data-methods]');
        if (!container) return;

        container.replaceChildren();
        methods.forEach((method, index) => {
            const step = document.createElement('article');
            step.className = 'method-step';

            const number = document.createElement('span');
            number.textContent = String(index + 1).padStart(2, '0');
            const title = document.createElement('h3');
            title.textContent = method.title;
            const label = document.createElement('strong');
            label.textContent = method.label;
            const body = document.createElement('p');
            body.textContent = method.body;

            step.append(number, title, label, body);
            container.append(step);
        });
    }

    function renderSkills(skills) {
        const container = document.querySelector('[data-skills]');
        if (!container) return;

        container.replaceChildren();
        skills.forEach((skill, index) => {
            const card = document.createElement('article');
            card.className = 'skill-card reveal';
            const number = document.createElement('span');
            number.setAttribute('aria-hidden', 'true');
            number.textContent = String(index + 1).padStart(2, '0');
            const title = document.createElement('h3');
            title.textContent = skill.title;
            const body = document.createElement('p');
            body.textContent = skill.body;
            const items = document.createElement('div');
            items.className = 'skill-items';
            skill.items.forEach((item) => {
                const tag = document.createElement('span');
                tag.textContent = item;
                items.append(tag);
            });
            card.append(number, title, body, items);
            container.append(card);
        });
    }

    function setupRevealObserver() {
        const items = document.querySelectorAll('.reveal');

        if (!('IntersectionObserver' in window)) {
            items.forEach((item) => item.classList.add('visible'));
            return;
        }

        revealObserver?.disconnect();
        const observer = new IntersectionObserver((entries) => {
            entries.forEach((entry) => {
                if (entry.isIntersecting) {
                    entry.target.classList.add('visible');
                    observer.unobserve(entry.target);
                }
            });
        }, { threshold: 0.16 });
        revealObserver = observer;

        items.forEach((item) => {
            item.classList.remove('visible');
            revealObserver.observe(item);
        });
    }

    function applyLanguage() {
        const copy = t();
        const currentLang = desktopApi.getLanguage();
        const windowScroll = document.querySelector('[data-window-scroll]');
        const projectCards = [...document.querySelectorAll('[data-projects] > .project-card')];
        const openDetails = projectCards.map((card) => card.querySelector('details').open);
        const anchorSelector = '.page-shell main > section, .method-step, .project-card, .project-body > *, .project-details summary, .project-details[open] li, .skill-card';
        const anchorCandidates = [...document.querySelectorAll(anchorSelector)];
        const viewportTop = windowScroll.getBoundingClientRect().top + windowScroll.clientTop
            + (window.innerWidth <= 900 ? document.querySelector('.site-header').offsetHeight : 0);
        const readingAnchorIndex = projectCards.length && windowScroll.scrollTop > 0
            ? anchorCandidates.findLastIndex((element) => {
                const rect = element.getBoundingClientRect();
                return rect.height > 0 && rect.top <= viewportTop;
            })
            : -1;
        const readingOffset = anchorCandidates[readingAnchorIndex]?.getBoundingClientRect().top;

        document.documentElement.lang = currentLang === 'zh-CN' ? 'zh-CN' : 'en';
        document.title = currentLang === 'zh-CN'
            ? '李祖钜 Gavin | AI Agent、机器人与计算机视觉作品集'
            : 'Gavin Lizuju | AI Agent, Robotics and Computer Vision Portfolio';

        document.querySelectorAll('[data-i18n]').forEach((element) => {
            const key = element.getAttribute('data-i18n');
            if (copy[key]) element.textContent = copy[key];
        });

        document.querySelectorAll('[data-i18n-placeholder]').forEach((element) => {
            const key = element.getAttribute('data-i18n-placeholder');
            if (copy[key]) element.setAttribute('placeholder', copy[key]);
        });

        document.querySelectorAll('[data-i18n-lines]').forEach((element) => {
            const key = element.getAttribute('data-i18n-lines');
            if (!Array.isArray(copy[key])) return;
            element.replaceChildren();
            copy[key].forEach((line) => {
                const span = document.createElement('span');
                span.textContent = line;
                element.append(span);
            });
        });

        renderList('navigationExperience', copy.navigationExperience);
        renderList('navigationExperienceStack', copy.navigationExperienceStack);
        renderList('stemmExperience', copy.stemmExperience);
        renderList('stemmExperienceStack', copy.stemmExperienceStack);
        renderList('heroTags', copy.heroTags);
        renderList('modeling', copy.modeling);
        renderList('robotics', copy.robotics);
        renderList('innovation', copy.innovation);
        renderList('otherAwards', copy.otherAwards);
        renderList('educationHighlights', copy.educationHighlights);
        renderMethods(copy.methods);
        renderProjects(copy.projects, openDetails);
        renderSkills(copy.skills);

        if (readingAnchorIndex >= 0) {
            const restoredAnchor = document.querySelectorAll(anchorSelector)[readingAnchorIndex];
            windowScroll.scrollTop += restoredAnchor.getBoundingClientRect().top - readingOffset;
        }

        const langButton = document.querySelector('[data-lang-toggle]');
        if (langButton) langButton.textContent = currentLang === 'zh-CN' ? 'EN' : '中文';

        const taskbarLangButton = document.querySelector('[data-taskbar-lang]');
        if (taskbarLangButton) {
            const isChinese = currentLang === 'zh-CN';
            const label = isChinese ? '切换为英文' : 'Switch to Chinese';
            taskbarLangButton.textContent = isChinese ? 'EN' : '中';
            taskbarLangButton.setAttribute('aria-label', label);
            taskbarLangButton.title = label;
        }

        window.dispatchEvent(new CustomEvent('portfolio-language-change', {
            detail: { language: currentLang }
        }));
        setupRevealObserver();
    }

    function closeMobileMenu() {
        document.body.classList.remove('menu-open');
        document.querySelector('[data-mobile-menu]')?.classList.remove('active');
        const button = document.querySelector('[data-menu-toggle]');
        if (button) {
            button.setAttribute('aria-expanded', 'false');
            button.setAttribute('aria-label', 'Open menu');
        }
    }

    function scrollPortfolioWindow(target, updateHash = false, behavior = 'smooth') {
        const windowScroll = document.querySelector('[data-window-scroll]');
        const targetElement = document.getElementById(target.slice(1));
        if (!windowScroll || !targetElement) return false;

        closeMobileMenu();
        const headerHeight = window.innerWidth <= 900 ? document.querySelector('.site-header').offsetHeight : 0;
        const top = target === '#top'
            ? 0
            : windowScroll.scrollTop
                + targetElement.getBoundingClientRect().top
                - windowScroll.getBoundingClientRect().top - windowScroll.clientTop
                - headerHeight;

        window.scrollTo(0, 0);
        windowScroll.scrollTo({ top: Math.max(0, top), behavior });

        if (updateHash && window.location.hash !== target) {
            window.history.pushState(null, '', target);
        }

        return true;
    }

    // Homepage window: the resume content, its menus and the desktop shortcut that opens it.
    function setupPortfolioWindow(manager) {
        const appWindow = document.querySelector('[data-app-window]');
        const titlebar = document.querySelector('[data-window-drag]');
        const resizeHandle = document.querySelector('[data-window-resize]');
        const taskWindow = document.querySelector('[data-task-window]');
        if (!appWindow || !titlebar || !resizeHandle || !taskWindow) return null;

        const showPortfolioWindow = (target) => manager.showWindow(appWindow, taskWindow, { target, revealTask: true });
        const entry = manager.registerWindow({
            id: 'portfolio',
            element: appWindow,
            task: taskWindow,
            titlebar,
            resizeHandle,
            actionAttribute: 'data-window-action',
            minWidth: 520,
            minHeight: 360,
            show: () => showPortfolioWindow(),
            focusTarget: () => appWindow.querySelector('[data-lang-toggle]')
        });

        const showMobileHomepage = () => {
            appWindow.classList.remove('is-maximized');
            manager.clearWindowGeometry(appWindow);
            manager.updateMaximizeButtons(appWindow, entry.maximizeSelector);
            showPortfolioWindow();
            window.requestAnimationFrame(() => {
                scrollPortfolioWindow(window.location.hash || '#top', false, 'instant');
            });
        };

        const selectPortfolioContent = () => {
            const content = appWindow.querySelector('.page-shell');
            const selection = window.getSelection();
            if (!content || !selection) return;

            const range = document.createRange();
            range.selectNodeContents(content);
            selection.removeAllRanges();
            selection.addRange(range);
        };

        manager.addMenuActions({
            'portfolio-print': () => window.print(),
            'portfolio-close': () => entry.hide('is-closed'),
            'portfolio-select-all': selectPortfolioContent,
            'clear-selection': () => window.getSelection()?.removeAllRanges(),
            'portfolio-top': () => scrollPortfolioWindow('#top', true),
            'portfolio-projects': () => scrollPortfolioWindow('#projects', true),
            'portfolio-contact': () => scrollPortfolioWindow('#contact', true),
            'portfolio-toggle-size': entry.toggleMaximize,
            'portfolio-github': () => window.open('https://github.com/lizuju', '_blank', 'noopener,noreferrer'),
            'portfolio-about': () => scrollPortfolioWindow('#top', true)
        });

        document.querySelectorAll('[data-open-window]').forEach((button) => {
            button.addEventListener('click', () => showPortfolioWindow(button.getAttribute('data-target')));
        });

        document.querySelectorAll('a[href^="#"]').forEach((link) => {
            link.addEventListener('click', (event) => {
                const target = link.getAttribute('href');
                if (!target || !scrollPortfolioWindow(target, true)) return;
                event.preventDefault();
                closeMobileMenu();
                if (link.closest('[data-mobile-menu]')) {
                    const targetElement = document.getElementById(target.slice(1));
                    targetElement.tabIndex = -1;
                    targetElement.focus({ preventScroll: true });
                }
            });
        });

        return { show: showPortfolioWindow, showMobileHomepage, entry };
    }

    function setupPortfolioInteractions() {
        document.querySelectorAll('[data-lang-toggle], [data-taskbar-lang]').forEach((button) => {
            button.addEventListener('click', () => {
                desktopApi.setLanguage(desktopApi.getLanguage() === 'zh-CN' ? 'en' : 'zh-CN');
                applyLanguage();
            });
        });

        document.querySelector('[data-menu-toggle]')?.addEventListener('click', (event) => {
            const open = document.body.classList.toggle('menu-open');
            document.querySelector('[data-mobile-menu]')?.classList.toggle('active', open);
            event.currentTarget.setAttribute('aria-expanded', String(open));
            event.currentTarget.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
        });

        document.querySelectorAll('a[href^="#"]').forEach((link) => {
            link.addEventListener('click', closeMobileMenu);
        });
    }

    const legacyRouteMap = {
        education: 'education',
        experience: 'experience',
        'technical-skills': 'skills',
        projects: 'projects',
        awards: 'awards'
    };

    function routeLegacySkillLinks() {
        const skill = new URLSearchParams(window.location.search).get('skill');
        const section = legacyRouteMap[skill];
        if (!section) return;

        window.requestAnimationFrame(() => {
            scrollPortfolioWindow(`#${section}`, true);
        });
    }

    desktopApi.scrollPortfolioWindow = scrollPortfolioWindow;
    desktopApi.portfolio = {
        applyLanguage,
        setupPortfolioInteractions,
        routeLegacySkillLinks
    };
    desktopApi.apps.portfolio = setupPortfolioWindow;
})();
