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
    const projectFolderWindow = document.querySelector('[data-project-folder-window]');
    const projectFolderTitlebar = document.querySelector('[data-project-folder-drag]');
    const projectFolderResizeHandle = document.querySelector('[data-project-folder-resize]');
    const projectFolderTask = document.querySelector('[data-project-folder-task]');
    const projectFolderTitle = document.querySelector('[data-project-folder-window-title]');
    const projectFolderAddress = document.querySelector('[data-project-folder-address]');
    const projectFolderStatus = document.querySelector('[data-project-folder-status]');
    const projectFolderRoot = document.querySelector('[data-project-folder-root]');
    const robomasterFolderView = document.querySelector('[data-robomaster-folder-view]');
    const projectFolderBack = document.querySelector('[data-project-folder-back]');
    const imagePreviewWindow = document.querySelector('[data-image-preview-window]');
    const imagePreviewTitle = document.querySelector('[data-image-preview-title]');
    const imagePreviewImage = document.querySelector('[data-image-preview-image]');
    const imagePreviewCaption = document.querySelector('[data-image-preview-caption]');
    const imagePreviewStatus = document.querySelector('[data-image-preview-status]');
    const imagePreviewTitlebar = document.querySelector('[data-image-preview-drag]');
    const imagePreviewResizeHandle = document.querySelector('[data-image-preview-resize]');
    const imagePreviewTask = document.querySelector('[data-image-preview-task]');
    const imagePreviewTaskTitle = document.querySelector('[data-image-preview-task-title]');
    const mailWindow = document.querySelector('[data-mail-window]');
    const mailTitlebar = document.querySelector('[data-mail-drag]');
    const mailResizeHandle = document.querySelector('[data-mail-resize]');
    const mailTask = document.querySelector('[data-mail-task]');
    const mailForm = document.querySelector('[data-mail-form]');
    const mailSendButton = document.querySelector('[data-mail-send]');
    const mailStatus = document.querySelector('[data-mail-status]');
    const gameWindow = document.querySelector('[data-gomoku-window]');
    const gameTask = document.querySelector('[data-gomoku-task]');
    const startButton = document.querySelector('[data-start-toggle]');
    const startMenu = document.querySelector('[data-start-menu]');
    const shutdownButton = document.querySelector('[data-shutdown]');
    const shutdownScreen = document.querySelector('[data-shutdown-screen]');
    const shutdownLog = document.querySelector('[data-shutdown-log]');
    const restartButton = document.querySelector('[data-restart]');
    const clock = document.querySelector('[data-retro-clock]');
    if (!desktop || !appWindow || !titlebar || !resizeHandle || !taskWindow
        || !projectFolderWindow || !projectFolderTitlebar || !projectFolderResizeHandle || !projectFolderTask
        || !projectFolderTitle || !projectFolderAddress || !projectFolderStatus || !projectFolderRoot
        || !robomasterFolderView || !projectFolderBack || !imagePreviewWindow || !imagePreviewTitle
        || !imagePreviewImage || !imagePreviewCaption || !imagePreviewStatus || !imagePreviewTitlebar
        || !imagePreviewResizeHandle || !imagePreviewTask || !imagePreviewTaskTitle
        || !mailWindow || !mailTitlebar || !mailResizeHandle || !mailTask || !mailForm || !mailSendButton || !mailStatus
        || !startButton || !startMenu) return;

    let pointerInteraction;
    let shutdownTimers = [];
    let robomasterFolderOpen = false;
    let selectedImageButton;
    let mailStatusKey = 'mailStatusReady';
    let mailStatusState = '';
    const robomasterImageButtons = Array.from(document.querySelectorAll('[data-robomaster-image]'));
    const restoreGeometry = new WeakMap();
    const windowEntries = [
        { element: appWindow, task: taskWindow },
        { element: projectFolderWindow, task: projectFolderTask },
        { element: imagePreviewWindow, task: imagePreviewTask },
        { element: mailWindow, task: mailTask },
        ...(gameWindow && gameTask ? [{ element: gameWindow, task: gameTask }] : [])
    ];

    const isWindowVisible = (element) => (
        !element.classList.contains('is-minimized')
        && !element.classList.contains('is-closed')
    );

    const getWindowZIndex = (element) => Number.parseInt(window.getComputedStyle(element).zIndex, 10) || 0;

    const focusWindow = (element) => {
        const entry = windowEntries.find((candidate) => candidate.element === element);
        if (!entry || !isWindowVisible(element)) return;

        const windowStack = windowEntries
            .filter((candidate) => isWindowVisible(candidate.element) && candidate !== entry)
            .sort((first, second) => getWindowZIndex(first.element) - getWindowZIndex(second.element));
        windowStack.push(entry);

        windowEntries.forEach((candidate) => {
            const active = candidate === entry;
            candidate.element.classList.toggle('is-active', active);
            candidate.task.classList.toggle('is-active', active);
        });

        windowStack.forEach((candidate, index) => {
            candidate.element.style.zIndex = String(10 + index);
        });
    };

    const focusTopWindow = (excludedElement) => {
        const nextEntry = windowEntries
            .filter(({ element }) => element !== excludedElement && isWindowVisible(element))
            .sort((first, second) => getWindowZIndex(first.element) - getWindowZIndex(second.element))
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

    const getWindowGeometry = (element) => {
        const desktopRect = desktop.getBoundingClientRect();
        const windowRect = element.getBoundingClientRect();
        return {
            left: windowRect.left - desktopRect.left,
            top: windowRect.top - desktopRect.top,
            width: windowRect.width,
            height: windowRect.height
        };
    };

    const applyWindowGeometry = (element, { left, top, width, height }) => {
        element.style.left = `${Math.round(left)}px`;
        element.style.top = `${Math.round(top)}px`;
        element.style.width = `${Math.round(width)}px`;
        element.style.height = `${Math.round(height)}px`;
        element.style.right = 'auto';
        element.style.bottom = 'auto';
    };

    const clearWindowGeometry = (element) => {
        ['left', 'top', 'width', 'height', 'right', 'bottom'].forEach((property) => {
            element.style.removeProperty(property);
        });
    };

    const updateMaximizeButtons = (element, selector) => {
        const maximized = element.classList.contains('is-maximized');
        document.querySelectorAll(selector).forEach((button) => {
            button.setAttribute('aria-pressed', String(maximized));
        });
    };

    const toggleMaximize = (element, selector) => {
        if (window.innerWidth <= 900) return;

        if (element.classList.contains('is-maximized')) {
            element.classList.remove('is-maximized');
            const geometry = restoreGeometry.get(element);
            if (geometry) applyWindowGeometry(element, geometry);
        } else {
            restoreGeometry.set(element, getWindowGeometry(element));
            clearWindowGeometry(element);
            element.classList.add('is-maximized');
        }
        updateMaximizeButtons(element, selector);
    };

    const startPointerInteraction = (event, type, element, minWidth, minHeight) => {
        if (event.button !== 0 || window.innerWidth <= 900 || element.classList.contains('is-maximized')) return;

        const geometry = getWindowGeometry(element);
        applyWindowGeometry(element, geometry);
        pointerInteraction = {
            type,
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            geometry,
            element,
            minWidth,
            minHeight
        };
        element.classList.add(type === 'drag' ? 'is-dragging' : 'is-resizing');
        event.currentTarget.setPointerCapture?.(event.pointerId);
        event.preventDefault();
    };

    const updatePointerInteraction = (event) => {
        if (!pointerInteraction || event.pointerId !== pointerInteraction.pointerId) return;

        const { type, startX, startY, geometry, element, minWidth, minHeight } = pointerInteraction;
        const deltaX = event.clientX - startX;
        const deltaY = event.clientY - startY;
        const workArea = getWorkArea();

        if (type === 'drag') {
            applyWindowGeometry(element, {
                ...geometry,
                left: Math.min(Math.max(0, geometry.left + deltaX), Math.max(0, workArea.width - geometry.width)),
                top: Math.min(Math.max(0, geometry.top + deltaY), Math.max(0, workArea.height - geometry.height))
            });
            return;
        }

        const constrainedWidth = Math.min(minWidth, workArea.width - geometry.left);
        const constrainedHeight = Math.min(minHeight, workArea.height - geometry.top);
        applyWindowGeometry(element, {
            ...geometry,
            width: Math.min(Math.max(constrainedWidth, geometry.width + deltaX), workArea.width - geometry.left),
            height: Math.min(Math.max(constrainedHeight, geometry.height + deltaY), workArea.height - geometry.top)
        });
    };

    const finishPointerInteraction = (event) => {
        if (!pointerInteraction || (event?.pointerId !== undefined && event.pointerId !== pointerInteraction.pointerId)) return;
        const { element } = pointerInteraction;
        pointerInteraction = undefined;
        element.classList.remove('is-dragging', 'is-resizing');
    };

    const showWindow = (element, task, { target, revealTask = false } = {}) => {
        element.classList.remove('is-minimized', 'is-closed');
        if (revealTask) task.hidden = false;
        focusWindow(element);
        closeStartMenu();

        if (!target) return;
        window.requestAnimationFrame(() => {
            scrollPortfolioWindow(target);
        });
    };

    const hideWindow = (element, task, state, { hideTask = false } = {}) => {
        element.classList.remove('is-minimized', 'is-closed');
        element.classList.add(state);
        element.classList.remove('is-active');
        task.classList.remove('is-active');
        if (hideTask) task.hidden = true;
        focusTopWindow(element);
        closeStartMenu();
    };

    const showPortfolioWindow = (target) => showWindow(appWindow, taskWindow, { target });
    const hidePortfolioWindow = (state) => hideWindow(appWindow, taskWindow, state);
    const showProjectFolder = () => showWindow(projectFolderWindow, projectFolderTask, { revealTask: true });
    const hideProjectFolder = (state) => hideWindow(projectFolderWindow, projectFolderTask, state, {
        hideTask: state === 'is-closed'
    });
    const showImagePreview = () => showWindow(imagePreviewWindow, imagePreviewTask, { revealTask: true });
    const hideImagePreview = (state) => hideWindow(imagePreviewWindow, imagePreviewTask, state, {
        hideTask: state === 'is-closed'
    });
    const showMailWindow = () => showWindow(mailWindow, mailTask, { revealTask: true });
    const hideMailWindow = (state) => hideWindow(mailWindow, mailTask, state, {
        hideTask: state === 'is-closed'
    });

    const setMailStatus = (key, state = mailStatusState) => {
        mailStatusKey = key;
        mailStatusState = state;
        mailStatus.dataset.state = state;
        mailStatus.textContent = t()[key];
    };

    const getPhotoCopy = (button, key) => {
        const suffix = document.documentElement.lang === 'en' ? 'En' : 'Zh';
        return button.dataset[`${key}${suffix}`] || '';
    };

    const selectPhoto = (button) => {
        if (!button) return;
        selectedImageButton = button;
        robomasterImageButtons.forEach((candidate) => {
            candidate.classList.toggle('is-selected', candidate === button);
        });
    };

    const getPhotoColumnCount = () => {
        if (!robomasterImageButtons.length) return 1;

        const firstRowTop = robomasterImageButtons[0].offsetTop;
        const nextRowIndex = robomasterImageButtons.findIndex((button, index) => (
            index > 0 && button.offsetTop !== firstRowTop
        ));
        return nextRowIndex === -1 ? robomasterImageButtons.length : nextRowIndex;
    };

    const getPhotoNavigationTarget = (key) => {
        if (!robomasterImageButtons.length) return null;
        if (!selectedImageButton) return robomasterImageButtons[0];

        const currentIndex = robomasterImageButtons.indexOf(selectedImageButton);
        const columnCount = getPhotoColumnCount();
        if (currentIndex < 0) return robomasterImageButtons[0];

        if (key === 'ArrowLeft') {
            return currentIndex % columnCount === 0
                ? selectedImageButton
                : robomasterImageButtons[currentIndex - 1];
        }
        if (key === 'ArrowRight') {
            return currentIndex % columnCount === columnCount - 1
                || currentIndex === robomasterImageButtons.length - 1
                ? selectedImageButton
                : robomasterImageButtons[currentIndex + 1];
        }
        if (key === 'ArrowUp') {
            return currentIndex < columnCount
                ? selectedImageButton
                : robomasterImageButtons[currentIndex - columnCount];
        }
        if (key === 'ArrowDown') {
            return currentIndex + columnCount >= robomasterImageButtons.length
                ? selectedImageButton
                : robomasterImageButtons[currentIndex + columnCount];
        }
        return null;
    };

    const updatePhotoCopy = () => {
        const copy = t();
        robomasterImageButtons.forEach((button) => {
            const label = getPhotoCopy(button, 'photoLabel');
            const alt = getPhotoCopy(button, 'photoAlt');
            button.querySelector('[data-photo-label]').textContent = label;
            button.querySelector('[data-photo-type]').textContent = copy.previewImageType;
            button.querySelector('[data-robomaster-thumbnail]').alt = alt;
        });

        if (!selectedImageButton) {
            imagePreviewTitle.textContent = copy.previewWindowTitle;
            imagePreviewTaskTitle.textContent = copy.previewTaskTitle;
            imagePreviewStatus.textContent = copy.previewStatus;
            return;
        }

        const label = getPhotoCopy(selectedImageButton, 'photoLabel');
        imagePreviewTitle.textContent = `${copy.previewWindowTitle} - ${label}`;
        imagePreviewTaskTitle.textContent = `${copy.previewTaskTitle}: ${label}`;
        imagePreviewCaption.textContent = label;
        imagePreviewStatus.textContent = copy.previewImageType;
        imagePreviewImage.alt = getPhotoCopy(selectedImageButton, 'photoAlt');
    };

    const setProjectFolderView = (showRoboMaster) => {
        robomasterFolderOpen = showRoboMaster;
        const copy = t();
        projectFolderRoot.hidden = showRoboMaster;
        robomasterFolderView.hidden = !showRoboMaster;
        projectFolderBack.hidden = !showRoboMaster;
        projectFolderTitle.textContent = showRoboMaster ? copy.folderPhotoWindowTitle : copy.folderWindowTitle;
        projectFolderAddress.textContent = showRoboMaster ? copy.folderPhotoAddress : copy.folderAddress;
        projectFolderStatus.textContent = showRoboMaster ? copy.folderPhotoStatus : copy.folderStatus;

        if (showRoboMaster) {
            document.querySelectorAll('[data-robomaster-thumbnail]').forEach((thumbnail) => {
                if (!thumbnail.getAttribute('src')) thumbnail.src = thumbnail.dataset.thumbnailSrc;
            });
        }

        updatePhotoCopy();
    };

    const openRoboMasterFolder = () => {
        setProjectFolderView(true);
        showProjectFolder();
    };

    const updateImagePreview = (button) => {
        selectPhoto(button);
        imagePreviewImage.decoding = 'async';
        imagePreviewImage.src = button.dataset.imageSrc;
        updatePhotoCopy();
    };

    const openImagePreview = (button) => {
        updateImagePreview(button);
        showImagePreview();
    };

    const openProjectFolder = () => {
        setProjectFolderView(false);
        showProjectFolder();
    };

    const sendMail = async (event) => {
        event.preventDefault();
        if (!mailForm.reportValidity()) return;

        const formData = new FormData(mailForm);
        const payload = Object.fromEntries(formData.entries());
        payload._replyto = payload.email;
        payload._subject = t().mailSubject;
        payload._url = window.location.href;

        mailSendButton.disabled = true;
        setMailStatus('mailStatusSending', 'sending');

        try {
            const response = await fetch(mailForm.dataset.mailEndpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json'
                },
                body: JSON.stringify(payload)
            });
            if (!response.ok) throw new Error('Mail delivery failed');

            mailForm.reset();
            setMailStatus('mailStatusSuccess', 'success');
        } catch {
            setMailStatus('mailStatusError', 'error');
        } finally {
            mailSendButton.disabled = false;
        }
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
        showPortfolioWindow('#top');
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
            if (action === 'minimize') hidePortfolioWindow('is-minimized');
            if (action === 'close') hidePortfolioWindow('is-closed');
            if (action === 'maximize') toggleMaximize(appWindow, '[data-window-action="maximize"]');
        });
    });

    document.querySelectorAll('[data-open-window]').forEach((button) => {
        button.addEventListener('click', () => showPortfolioWindow(button.getAttribute('data-target')));
    });

    document.querySelectorAll('[data-open-project-folder]').forEach((button) => {
        button.addEventListener('click', openProjectFolder);
    });
    document.querySelectorAll('[data-open-mail-window]').forEach((button) => {
        button.addEventListener('click', showMailWindow);
    });
    document.querySelector('[data-open-robomaster-folder]')?.addEventListener('click', openRoboMasterFolder);
    projectFolderBack.addEventListener('click', () => setProjectFolderView(false));
    robomasterImageButtons.forEach((button) => {
        button.addEventListener('click', () => openImagePreview(button));
    });
    mailForm.addEventListener('submit', sendMail);

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
            showPortfolioWindow();
            return;
        }
        if (appWindow.classList.contains('is-active')) {
            hidePortfolioWindow('is-minimized');
            return;
        }
        focusWindow(appWindow);
    });

    projectFolderTask.addEventListener('click', () => {
        if (projectFolderWindow.classList.contains('is-minimized') || projectFolderWindow.classList.contains('is-closed')) {
            showProjectFolder();
            return;
        }
        if (projectFolderWindow.classList.contains('is-active')) {
            hideProjectFolder('is-minimized');
            return;
        }
        focusWindow(projectFolderWindow);
    });

    imagePreviewTask.addEventListener('click', () => {
        if (imagePreviewWindow.classList.contains('is-minimized') || imagePreviewWindow.classList.contains('is-closed')) {
            showImagePreview();
            return;
        }
        if (imagePreviewWindow.classList.contains('is-active')) {
            hideImagePreview('is-minimized');
            return;
        }
        focusWindow(imagePreviewWindow);
    });

    mailTask.addEventListener('click', () => {
        if (mailWindow.classList.contains('is-minimized') || mailWindow.classList.contains('is-closed')) {
            showMailWindow();
            return;
        }
        if (mailWindow.classList.contains('is-active')) {
            hideMailWindow('is-minimized');
            return;
        }
        focusWindow(mailWindow);
    });

    document.querySelectorAll('[data-project-folder-action]').forEach((button) => {
        button.addEventListener('click', () => {
            const action = button.getAttribute('data-project-folder-action');
            if (action === 'minimize') hideProjectFolder('is-minimized');
            if (action === 'close') hideProjectFolder('is-closed');
            if (action === 'maximize') {
                toggleMaximize(projectFolderWindow, '[data-project-folder-action="maximize"]');
            }
        });
    });

    document.querySelectorAll('[data-image-preview-action]').forEach((button) => {
        button.addEventListener('click', () => {
            const action = button.getAttribute('data-image-preview-action');
            if (action === 'minimize') hideImagePreview('is-minimized');
            if (action === 'close') hideImagePreview('is-closed');
            if (action === 'maximize') {
                toggleMaximize(imagePreviewWindow, '[data-image-preview-action="maximize"]');
            }
        });
    });

    document.querySelectorAll('[data-mail-action]').forEach((button) => {
        button.addEventListener('click', () => {
            const action = button.getAttribute('data-mail-action');
            if (action === 'minimize') hideMailWindow('is-minimized');
            if (action === 'close') hideMailWindow('is-closed');
            if (action === 'maximize') toggleMaximize(mailWindow, '[data-mail-action="maximize"]');
        });
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

        if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
        if (!robomasterFolderOpen || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter'].includes(event.key)) {
            return;
        }
        if (event.target instanceof HTMLElement && event.target.matches('input, textarea, select, [contenteditable="true"]')) {
            return;
        }

        const previewActive = isWindowVisible(imagePreviewWindow) && imagePreviewWindow.classList.contains('is-active');
        const folderActive = isWindowVisible(projectFolderWindow) && projectFolderWindow.classList.contains('is-active');
        if (!previewActive && !folderActive) return;

        if (event.key === 'Enter') {
            if (previewActive || !selectedImageButton) return;
            event.preventDefault();
            openImagePreview(selectedImageButton);
            return;
        }

        const targetPhoto = getPhotoNavigationTarget(event.key);
        if (!targetPhoto) return;
        event.preventDefault();

        if (previewActive) {
            updateImagePreview(targetPhoto);
            return;
        }

        selectPhoto(targetPhoto);
        targetPhoto.focus({ preventScroll: true });
    });

    document.querySelector('[data-start-lang]')?.addEventListener('click', () => {
        document.querySelector('[data-lang-toggle]')?.click();
        closeStartMenu();
    });

    shutdownButton?.addEventListener('click', startShutdown);
    restartButton?.addEventListener('click', restartDesktop);

    titlebar.addEventListener('pointerdown', (event) => {
        if (event.target.closest('.window-controls')) return;
        startPointerInteraction(event, 'drag', appWindow, 520, 360);
    });
    resizeHandle.addEventListener('pointerdown', (event) => {
        startPointerInteraction(event, 'resize', appWindow, 520, 360);
    });
    projectFolderTitlebar.addEventListener('pointerdown', (event) => {
        if (event.target.closest('.window-controls')) return;
        startPointerInteraction(event, 'drag', projectFolderWindow, 440, 320);
    });
    projectFolderResizeHandle.addEventListener('pointerdown', (event) => {
        startPointerInteraction(event, 'resize', projectFolderWindow, 440, 320);
    });
    imagePreviewTitlebar.addEventListener('pointerdown', (event) => {
        if (event.target.closest('.window-controls')) return;
        startPointerInteraction(event, 'drag', imagePreviewWindow, 380, 300);
    });
    imagePreviewResizeHandle.addEventListener('pointerdown', (event) => {
        startPointerInteraction(event, 'resize', imagePreviewWindow, 380, 300);
    });
    mailTitlebar.addEventListener('pointerdown', (event) => {
        if (event.target.closest('.window-controls')) return;
        startPointerInteraction(event, 'drag', mailWindow, 420, 410);
    });
    mailResizeHandle.addEventListener('pointerdown', (event) => {
        startPointerInteraction(event, 'resize', mailWindow, 420, 410);
    });
    document.addEventListener('pointermove', updatePointerInteraction);
    document.addEventListener('pointerup', finishPointerInteraction);
    document.addEventListener('pointercancel', finishPointerInteraction);

    titlebar.addEventListener('dblclick', (event) => {
        if (event.target.closest('.window-controls')) return;
        toggleMaximize(appWindow, '[data-window-action="maximize"]');
    });
    projectFolderTitlebar.addEventListener('dblclick', (event) => {
        if (event.target.closest('.window-controls')) return;
        toggleMaximize(projectFolderWindow, '[data-project-folder-action="maximize"]');
    });
    imagePreviewTitlebar.addEventListener('dblclick', (event) => {
        if (event.target.closest('.window-controls')) return;
        toggleMaximize(imagePreviewWindow, '[data-image-preview-action="maximize"]');
    });
    mailTitlebar.addEventListener('dblclick', (event) => {
        if (event.target.closest('.window-controls')) return;
        toggleMaximize(mailWindow, '[data-mail-action="maximize"]');
    });

    window.addEventListener('resize', () => {
        if (window.innerWidth <= 900) {
            finishPointerInteraction();
            [
                [appWindow, '[data-window-action="maximize"]'],
                [projectFolderWindow, '[data-project-folder-action="maximize"]'],
                [imagePreviewWindow, '[data-image-preview-action="maximize"]'],
                [mailWindow, '[data-mail-action="maximize"]']
            ].forEach(([element, selector]) => {
                element.classList.remove('is-maximized');
                restoreGeometry.delete(element);
                clearWindowGeometry(element);
                updateMaximizeButtons(element, selector);
            });
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
    window.addEventListener('portfolio-language-change', () => {
        setProjectFolderView(robomasterFolderOpen);
        setMailStatus(mailStatusKey, mailStatusState);
    });
    focusWindow(appWindow);
    if (document.body.classList.contains('direct-portfolio') && window.innerWidth > 900) {
        toggleMaximize(appWindow, '[data-window-action="maximize"]');
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
