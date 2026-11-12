(() => {
    const desktopApi = window.GavinDesktop;
    const { t } = desktopApi;
    const GAME_URL = '../games/harbor-strike/';

    // The shooter needs a keyboard and mouse. games/harbor-strike/index.html at the site root repeats this check for direct visits.
    const isPhone = () => {
        const coarseOnly = window.matchMedia('(any-pointer: coarse)').matches
            && !window.matchMedia('(any-pointer: fine)').matches;
        return Boolean(navigator.userAgentData?.mobile)
            || /Android|iPhone|iPod|Windows Phone|Mobile/i.test(navigator.userAgent)
            || coarseOnly;
    };

    // Harbor Strike game window. The game page is only fetched when the window opens and is
    // unloaded on close so its WebGL context and audio stop with it.
    function setupHarborStrike(manager) {
        const gameWindow = document.querySelector('[data-harbor-window]');
        const titlebar = document.querySelector('[data-harbor-drag]');
        const resizeHandle = document.querySelector('[data-harbor-resize]');
        const task = document.querySelector('[data-harbor-task]');
        const stage = document.querySelector('[data-harbor-stage]');
        const loading = document.querySelector('[data-harbor-loading]');
        const phoneNotice = document.querySelector('[data-harbor-phone]');
        const status = document.querySelector('[data-harbor-status]');
        if (!gameWindow || !titlebar || !resizeHandle || !task || !stage || !loading || !phoneNotice || !status) {
            return null;
        }

        const phone = isPhone();
        let frame = null;
        let statusKey = '';

        const setStatus = (key) => {
            statusKey = key;
            status.textContent = key ? t()[key] : '';
        };

        // The game runs in a sandboxed frame. Its opaque origin lets Chromium give it its own
        // process, so its heavy startup and rendering no longer stall this desktop. Everything it
        // needs from here arrives as one state message: hidden (minimized: pause and suspend audio),
        // hold (stop drawing while behind another window, dragged, resized or off-camera), muted
        // (the system mute) and the settings it saved last time.
        const SETTINGS_KEY = 'saltline.settings.v1';
        let gameHidden = false;
        let viewingMonitor = true;
        let reportedRunning = false;

        const readSettings = () => {
            try {
                return localStorage.getItem(SETTINGS_KEY);
            } catch {
                return null;
            }
        };

        const postState = () => {
            // An opaque origin can only be addressed with '*'; the state holds nothing private.
            frame?.contentWindow?.postMessage({
                source: 'gavin-desktop',
                type: 'harbor-strike-state',
                hidden: gameHidden,
                hold: !viewingMonitor || !gameWindow.classList.contains('is-active')
                    || gameWindow.classList.contains('is-dragging') || gameWindow.classList.contains('is-resizing'),
                muted: Boolean(desktopApi.isAudioMuted?.()),
                settings: readSettings()
            }, '*');
        };

        // The 3D scene slows its own redraw while the game is on screen in the monitor.
        const syncWindowState = () => {
            postState();
            const running = Boolean(frame) && manager.isWindowVisible(gameWindow);
            if (running === reportedRunning || window.parent === window) return;
            reportedRunning = running;
            window.parent.postMessage({
                source: 'gavin-portfolio',
                type: 'heavy-app-state',
                active: running
            }, window.location.origin);
        };
        new MutationObserver(syncWindowState).observe(gameWindow, { attributes: true, attributeFilter: ['class'] });
        window.addEventListener('gavin:audio-mute-change', postState);

        const setGameHidden = (hidden) => {
            gameHidden = hidden;
            postState();
        };

        window.addEventListener('message', (event) => {
            if (event.origin === window.location.origin && event.source === window.parent
                && event.data?.source === 'gavin-shell' && event.data?.type === 'portfolio-view-state') {
                viewingMonitor = event.data.active === true;
                syncWindowState();
                return;
            }
            if (!frame || event.source !== frame.contentWindow || event.data?.source !== 'harbor-strike') return;
            if (event.data.type === 'ready') postState();
            if (event.data.type === 'settings' && typeof event.data.value === 'string' && event.data.value.length < 4096) {
                try {
                    JSON.parse(event.data.value);
                    localStorage.setItem(SETTINGS_KEY, event.data.value);
                } catch {
                    // Malformed or unsaved settings leave the previous ones in place.
                }
            }
        });

        const unloadGame = () => {
            frame?.remove();
            frame = null;
            gameHidden = false;
            loading.hidden = true;
            syncWindowState();
        };

        const loadGame = () => {
            if (phone || frame) return;
            loading.hidden = false;
            setStatus('harborLoading');
            frame = document.createElement('iframe');
            frame.className = 'harbor-frame';
            frame.title = t().harborWindowTitle;
            frame.allow = 'fullscreen; autoplay';
            frame.setAttribute('sandbox', 'allow-scripts allow-pointer-lock');
            stage.append(frame);
            syncWindowState();

            // Browsers without out-of-process frames (Safari) still run the game's startup on this
            // thread, so the window and its loading screen paint before the game page is requested.
            // The timeout covers background tabs, where animation frames never run.
            const pendingFrame = frame;
            const startGame = () => {
                if (frame !== pendingFrame || pendingFrame.hasAttribute('src')) return;
                pendingFrame.addEventListener('load', () => {
                    postState();
                    loading.hidden = true;
                    setStatus('harborReady');
                }, { once: true });
                pendingFrame.src = GAME_URL;
            };
            window.requestAnimationFrame(() => window.setTimeout(startGame));
            window.setTimeout(startGame, 100);
        };

        const showGame = () => {
            phoneNotice.hidden = !phone;
            if (phone) setStatus('harborPhoneStatus');
            else if (frame) setGameHidden(false);
            else loadGame();
        };

        const show = () => {
            showGame();
            manager.showWindow(gameWindow, task, { revealTask: true });
        };

        const hide = (state) => {
            manager.hideWindow(gameWindow, task, state, { hideTask: state === 'is-closed' });
            if (state === 'is-closed') {
                unloadGame();
                setStatus('');
            } else {
                setGameHidden(true);
            }
        };

        const entry = manager.registerWindow({
            id: 'harbor-strike',
            element: gameWindow,
            task,
            titlebar,
            resizeHandle,
            actionAttribute: 'data-harbor-action',
            minWidth: 520,
            minHeight: 380,
            show,
            hide,
            focusTarget: () => frame
        });

        gameWindow.querySelectorAll('[data-harbor-desktop-only]').forEach((element) => {
            element.hidden = phone;
        });

        manager.addMenuActions({
            'harbor-reload': () => {
                unloadGame();
                loadGame();
                manager.focusWindow(gameWindow, true);
            },
            'harbor-open-tab': () => {
                window.open(new URL(GAME_URL, document.baseURI).href, '_blank', 'noopener');
                entry.hide('is-closed');
            },
            'harbor-close': () => entry.hide('is-closed'),
            'harbor-toggle-size': entry.toggleMaximize
        });

        document.querySelectorAll('[data-open-harbor-strike]').forEach((button) => {
            button.addEventListener('click', show);
        });

        // The link opens the game at its own address; the copy in this window closes so only one runs.
        const openLink = gameWindow.querySelector('[data-harbor-open-link]');
        openLink?.addEventListener('click', () => window.setTimeout(() => entry.hide('is-closed')));

        // Clicks inside the frame never reach this document; the frame taking focus raises the window.
        window.addEventListener('blur', () => {
            window.setTimeout(() => {
                if (frame && document.activeElement === frame) manager.focusWindow(gameWindow);
            });
        });

        const updateCopy = () => {
            gameWindow.querySelectorAll('[data-i18n-aria]').forEach((element) => {
                if (t()[element.dataset.i18nAria]) element.setAttribute('aria-label', t()[element.dataset.i18nAria]);
            });
            if (frame) frame.title = t().harborWindowTitle;
            if (openLink) openLink.title = t().harborOpenTab;
            setStatus(statusKey);
        };
        window.addEventListener('portfolio-language-change', updateCopy);
        updateCopy();

        // Loads the game when a restored session left the window open.
        const resumeIfVisible = () => {
            if (manager.isWindowVisible(gameWindow)) showGame();
        };

        return { open: show, resumeIfVisible };
    }

    desktopApi.apps.harborStrike = setupHarborStrike;
})();
