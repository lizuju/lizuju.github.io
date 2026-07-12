const { USER, SUPPORTED_LANGS, CONTENT } = window.PORTFOLIO_DATA;

let revealObserver;

function normalizeLanguage(lang) {
    return SUPPORTED_LANGS.includes(lang) ? lang : 'zh-CN';
}

function readStoredLanguage() {
    try {
        return localStorage.getItem('portfolio-lang');
    } catch {
        return null;
    }
}

function storeLanguage(lang) {
    try {
        localStorage.setItem('portfolio-lang', lang);
    } catch {
        // Language persistence is optional; the page should still work without browser storage.
    }
}

const legacyRouteMap = {
    education: 'education',
    experience: 'experience',
    'technical-skills': 'skills',
    projects: 'projects',
    awards: 'awards'
};

let currentLang = normalizeLanguage(readStoredLanguage());

function t() {
    return CONTENT[currentLang] || CONTENT['zh-CN'];
}

function renderList(name, items) {
    document.querySelectorAll(`[data-list="${name}"]`).forEach((container) => {
        const tagList = name === 'heroTags' || name === 'experienceStack' || name === 'educationHighlights';
        container.replaceChildren();
        items.forEach((item) => {
            const element = document.createElement(tagList ? 'span' : 'li');
            element.textContent = item;
            container.append(element);
        });
    });
}

function renderProjects(projects) {
    const container = document.querySelector('[data-projects]');
    if (!container) return;

    const visualTypes = ['vision', 'inventory', 'retrieval', 'resume', 'recommender'];
    const visualAssets = {
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

function applyLanguage() {
    const copy = t();

    document.documentElement.lang = currentLang === 'zh-CN' ? 'zh-CN' : 'en';
    document.title = currentLang === 'zh-CN'
        ? '李祖钜 Gavin | AI Agent、机器人与计算机视觉作品集'
        : 'Gavin Lizuju | AI Agent, Robotics and Computer Vision Portfolio';

    document.querySelectorAll('[data-i18n]').forEach((element) => {
        const key = element.getAttribute('data-i18n');
        if (copy[key]) element.textContent = copy[key];
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

    renderList('experience', copy.experience);
    renderList('experienceStack', copy.experienceStack);
    renderList('heroTags', copy.heroTags);
    renderList('modeling', copy.modeling);
    renderList('robotics', copy.robotics);
    renderList('innovation', copy.innovation);
    renderList('otherAwards', copy.otherAwards);
    renderList('educationHighlights', copy.educationHighlights);
    renderMethods(copy.methods);
    renderProjects(copy.projects);
    renderSkills(copy.skills);

    const langButton = document.querySelector('[data-lang-toggle]');
    if (langButton) langButton.textContent = currentLang === 'zh-CN' ? 'EN' : '中文';

    window.dispatchEvent(new CustomEvent('portfolio-language-change', {
        detail: { language: currentLang }
    }));
    setupRevealObserver();
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

function closeMobileMenu() {
    document.body.classList.remove('menu-open');
    document.querySelector('[data-mobile-menu]')?.classList.remove('active');
    const button = document.querySelector('[data-menu-toggle]');
    if (button) {
        button.setAttribute('aria-expanded', 'false');
        button.setAttribute('aria-label', 'Open menu');
    }
}

function scrollPortfolioWindow(target, updateHash = false) {
    const windowScroll = document.querySelector('[data-window-scroll]');
    const targetElement = document.querySelector(target);
    if (!windowScroll || !targetElement) return false;

    const top = target === '#top'
        ? 0
        : windowScroll.scrollTop
            + targetElement.getBoundingClientRect().top
            - windowScroll.getBoundingClientRect().top;

    window.scrollTo(0, 0);
    windowScroll.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });

    if (updateHash && window.location.hash !== target) {
        window.history.pushState(null, '', target);
    }

    return true;
}

function setupDesktopShell() {
    const desktop = document.querySelector('[data-retro-desktop]');
    const appWindow = document.querySelector('[data-app-window]');
    const titlebar = document.querySelector('[data-window-drag]');
    const resizeHandle = document.querySelector('[data-window-resize]');
    const taskWindow = document.querySelector('[data-task-window]');
    const gameWindow = document.querySelector('[data-gomoku-window]');
    const gameTask = document.querySelector('[data-gomoku-task]');
    const startButton = document.querySelector('[data-start-toggle]');
    const startMenu = document.querySelector('[data-start-menu]');
    const shutdownButton = document.querySelector('[data-shutdown]');
    const shutdownScreen = document.querySelector('[data-shutdown-screen]');
    const shutdownLog = document.querySelector('[data-shutdown-log]');
    const restartButton = document.querySelector('[data-restart]');
    const clock = document.querySelector('[data-retro-clock]');
    if (!desktop || !appWindow || !titlebar || !resizeHandle || !taskWindow || !startButton || !startMenu) return;

    let restoreGeometry;
    let pointerInteraction;
    let shutdownTimers = [];
    const windowEntries = [
        { element: appWindow, task: taskWindow },
        ...(gameWindow && gameTask ? [{ element: gameWindow, task: gameTask }] : [])
    ];

    const isWindowVisible = (element) => (
        !element.classList.contains('is-minimized')
        && !element.classList.contains('is-closed')
    );

    const focusWindow = (element) => {
        const entry = windowEntries.find((candidate) => candidate.element === element);
        if (!entry || !isWindowVisible(element)) return;

        windowEntries.forEach((candidate, index) => {
            const active = candidate === entry;
            candidate.element.classList.toggle('is-active', active);
            candidate.task.classList.toggle('is-active', active);
            candidate.element.style.zIndex = String(active ? 20 : 5 + index);
        });
    };

    const focusTopWindow = (excludedElement) => {
        const nextEntry = windowEntries
            .filter(({ element }) => element !== excludedElement && isWindowVisible(element))
            .sort((first, second) => (
                (Number.parseInt(window.getComputedStyle(first.element).zIndex, 10) || 0)
                - (Number.parseInt(window.getComputedStyle(second.element).zIndex, 10) || 0)
            ))
            .at(-1);

        if (nextEntry) {
            focusWindow(nextEntry.element);
            return;
        }

        windowEntries.forEach(({ element, task }) => {
            element.classList.remove('is-active');
            task.classList.remove('is-active');
        });
    };

    const closeStartMenu = () => {
        startMenu.hidden = true;
        startButton.setAttribute('aria-expanded', 'false');
    };

    const getWorkArea = () => ({
        width: desktop.clientWidth,
        height: desktop.clientHeight - (document.querySelector('.desktop-taskbar')?.offsetHeight || 36)
    });

    const getWindowGeometry = () => {
        const desktopRect = desktop.getBoundingClientRect();
        const windowRect = appWindow.getBoundingClientRect();
        return {
            left: windowRect.left - desktopRect.left,
            top: windowRect.top - desktopRect.top,
            width: windowRect.width,
            height: windowRect.height
        };
    };

    const applyWindowGeometry = ({ left, top, width, height }) => {
        appWindow.style.left = `${Math.round(left)}px`;
        appWindow.style.top = `${Math.round(top)}px`;
        appWindow.style.width = `${Math.round(width)}px`;
        appWindow.style.height = `${Math.round(height)}px`;
        appWindow.style.right = 'auto';
        appWindow.style.bottom = 'auto';
    };

    const clearWindowGeometry = () => {
        ['left', 'top', 'width', 'height', 'right', 'bottom'].forEach((property) => {
            appWindow.style.removeProperty(property);
        });
    };

    const updateMaximizeButtons = () => {
        const maximized = appWindow.classList.contains('is-maximized');
        document.querySelectorAll('[data-window-action="maximize"]').forEach((button) => {
            button.setAttribute('aria-pressed', String(maximized));
        });
    };

    const toggleMaximize = () => {
        if (window.innerWidth <= 900) return;

        if (appWindow.classList.contains('is-maximized')) {
            appWindow.classList.remove('is-maximized');
            if (restoreGeometry) applyWindowGeometry(restoreGeometry);
        } else {
            restoreGeometry = getWindowGeometry();
            clearWindowGeometry();
            appWindow.classList.add('is-maximized');
        }
        updateMaximizeButtons();
    };

    const startPointerInteraction = (event, type) => {
        if (event.button !== 0 || window.innerWidth <= 900 || appWindow.classList.contains('is-maximized')) return;

        const geometry = getWindowGeometry();
        applyWindowGeometry(geometry);
        pointerInteraction = {
            type,
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            geometry
        };
        appWindow.classList.add(type === 'drag' ? 'is-dragging' : 'is-resizing');
        event.currentTarget.setPointerCapture?.(event.pointerId);
        event.preventDefault();
    };

    const updatePointerInteraction = (event) => {
        if (!pointerInteraction || event.pointerId !== pointerInteraction.pointerId) return;

        const { type, startX, startY, geometry } = pointerInteraction;
        const deltaX = event.clientX - startX;
        const deltaY = event.clientY - startY;
        const workArea = getWorkArea();

        if (type === 'drag') {
            applyWindowGeometry({
                ...geometry,
                left: Math.min(Math.max(0, geometry.left + deltaX), Math.max(0, workArea.width - geometry.width)),
                top: Math.min(Math.max(0, geometry.top + deltaY), Math.max(0, workArea.height - geometry.height))
            });
            return;
        }

        const minWidth = Math.min(520, workArea.width - geometry.left);
        const minHeight = Math.min(360, workArea.height - geometry.top);
        applyWindowGeometry({
            ...geometry,
            width: Math.min(Math.max(minWidth, geometry.width + deltaX), workArea.width - geometry.left),
            height: Math.min(Math.max(minHeight, geometry.height + deltaY), workArea.height - geometry.top)
        });
    };

    const finishPointerInteraction = (event) => {
        if (!pointerInteraction || (event?.pointerId !== undefined && event.pointerId !== pointerInteraction.pointerId)) return;
        pointerInteraction = undefined;
        appWindow.classList.remove('is-dragging', 'is-resizing');
    };

    const showWindow = (target) => {
        appWindow.classList.remove('is-minimized', 'is-closed');
        focusWindow(appWindow);
        closeStartMenu();

        if (!target) return;
        window.requestAnimationFrame(() => {
            scrollPortfolioWindow(target);
        });
    };

    const hideWindow = (state) => {
        appWindow.classList.remove('is-minimized', 'is-closed');
        appWindow.classList.add(state);
        appWindow.classList.remove('is-active');
        taskWindow.classList.remove('is-active');
        focusTopWindow(appWindow);
        closeStartMenu();
    };

    const clearShutdownTimers = () => {
        shutdownTimers.forEach((timer) => window.clearTimeout(timer));
        shutdownTimers = [];
    };

    const restartDesktop = () => {
        clearShutdownTimers();
        if (shutdownScreen) shutdownScreen.hidden = true;
        if (shutdownLog) shutdownLog.textContent = '';
        if (restartButton) restartButton.hidden = true;
        showWindow('#top');
    };

    const startShutdown = () => {
        if (!shutdownScreen || !shutdownLog || !restartButton) return;

        closeStartMenu();
        clearShutdownTimers();
        shutdownLog.textContent = '';
        restartButton.hidden = true;
        shutdownScreen.hidden = false;

        t().shutdownLines.forEach((line, index, lines) => {
            shutdownTimers.push(window.setTimeout(() => {
                shutdownLog.textContent += `${line}\n`;
                if (index === lines.length - 1) {
                    restartButton.hidden = false;
                    shutdownTimers.push(window.setTimeout(restartDesktop, 12000));
                }
            }, 450 * (index + 1)));
        });
    };

    document.querySelectorAll('[data-window-action]').forEach((button) => {
        button.addEventListener('click', () => {
            const action = button.getAttribute('data-window-action');
            if (action === 'minimize') hideWindow('is-minimized');
            if (action === 'close') hideWindow('is-closed');
            if (action === 'maximize') toggleMaximize();
        });
    });

    document.querySelectorAll('[data-open-window]').forEach((button) => {
        button.addEventListener('click', () => showWindow(button.getAttribute('data-target')));
    });

    document.querySelectorAll('a[href^="#"]').forEach((link) => {
        link.addEventListener('click', (event) => {
            const target = link.getAttribute('href');
            if (!target || !scrollPortfolioWindow(target, true)) return;
            event.preventDefault();
            closeMobileMenu();
        });
    });

    taskWindow.addEventListener('click', () => {
        if (appWindow.classList.contains('is-minimized') || appWindow.classList.contains('is-closed')) {
            showWindow();
            return;
        }
        if (appWindow.classList.contains('is-active')) {
            hideWindow('is-minimized');
            return;
        }
        focusWindow(appWindow);
    });

    startButton.addEventListener('click', (event) => {
        event.stopPropagation();
        startMenu.hidden = !startMenu.hidden;
        startButton.setAttribute('aria-expanded', String(!startMenu.hidden));
    });

    startMenu.addEventListener('click', (event) => event.stopPropagation());
    document.addEventListener('click', closeStartMenu);
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') closeStartMenu();
    });

    document.querySelector('[data-start-lang]')?.addEventListener('click', () => {
        document.querySelector('[data-lang-toggle]')?.click();
        closeStartMenu();
    });

    shutdownButton?.addEventListener('click', startShutdown);
    restartButton?.addEventListener('click', restartDesktop);

    titlebar.addEventListener('pointerdown', (event) => {
        if (event.target.closest('.window-controls')) return;
        startPointerInteraction(event, 'drag');
    });
    resizeHandle.addEventListener('pointerdown', (event) => startPointerInteraction(event, 'resize'));
    document.addEventListener('pointermove', updatePointerInteraction);
    document.addEventListener('pointerup', finishPointerInteraction);
    document.addEventListener('pointercancel', finishPointerInteraction);

    titlebar.addEventListener('dblclick', (event) => {
        if (event.target.closest('.window-controls')) return;
        toggleMaximize();
    });

    window.addEventListener('resize', () => {
        if (window.innerWidth <= 900) {
            finishPointerInteraction();
            appWindow.classList.remove('is-maximized');
            restoreGeometry = undefined;
            clearWindowGeometry();
            updateMaximizeButtons();
        }
    });

    desktop.addEventListener('gavin:focus-window', (event) => {
        const targetWindow = event.target.closest?.('.app-window');
        if (targetWindow) focusWindow(targetWindow);
    });
    desktop.addEventListener('gavin:window-hidden', (event) => {
        const targetWindow = event.target.closest?.('.app-window');
        focusTopWindow(targetWindow);
    });
    windowEntries.forEach(({ element }) => {
        element.addEventListener('pointerdown', () => focusWindow(element));
        element.addEventListener('focusin', () => focusWindow(element));
    });
    focusWindow(appWindow);
    if (document.body.classList.contains('direct-portfolio') && window.innerWidth > 900) {
        toggleMaximize();
    }

    const updateClock = () => {
        if (!clock) return;
        clock.textContent = new Intl.DateTimeFormat([], {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        }).format(new Date());
    };
    updateClock();
    window.setInterval(updateClock, 30000);
}

function setupParentEventBridge() {
    if (window.parent === window) return;

    let pendingMouseMove;
    let animationFrame;
    document.addEventListener('mousemove', (event) => {
        pendingMouseMove = {
            source: 'gavin-portfolio',
            type: 'mousemove',
            clientX: event.clientX,
            clientY: event.clientY
        };
        if (animationFrame) return;
        animationFrame = window.requestAnimationFrame(() => {
            window.parent.postMessage(pendingMouseMove, window.location.origin);
            animationFrame = null;
        });
    });

    ['mousedown', 'mouseup'].forEach((type) => {
        document.addEventListener(type, (event) => {
            window.parent.postMessage({
                source: 'gavin-portfolio',
                type,
                clientX: event.clientX,
                clientY: event.clientY
            }, window.location.origin);
        });
    });

    ['keydown', 'keyup'].forEach((type) => {
        document.addEventListener(type, (event) => {
            window.parent.postMessage({
                source: 'gavin-portfolio',
                type,
                key: event.key
            }, window.location.origin);
        });
    });
}

function setupInteractions() {
    document.querySelector('[data-lang-toggle]')?.addEventListener('click', () => {
        currentLang = normalizeLanguage(currentLang) === 'zh-CN' ? 'en' : 'zh-CN';
        storeLanguage(currentLang);
        applyLanguage();
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

function routeLegacySkillLinks() {
    const skill = new URLSearchParams(window.location.search).get('skill');
    const section = legacyRouteMap[skill];
    if (!section) return;

    window.requestAnimationFrame(() => {
        scrollPortfolioWindow(`#${section}`, true);
    });
}

document.addEventListener('DOMContentLoaded', () => {
    const directReturn = document.querySelector('[data-direct-return]');
    if (directReturn && window.parent === window) {
        directReturn.hidden = false;
        document.body.classList.add('direct-portfolio');
    }

    document.querySelectorAll('img[src="' + USER.avatar + '"]').forEach((img) => {
        img.alt = USER.name;
    });

    const favicon = document.getElementById('favicon');
    if (favicon) favicon.href = USER.avatar;

    setupParentEventBridge();
    setupDesktopShell();
    setupInteractions();
    applyLanguage();
    routeLegacySkillLinks();
});
