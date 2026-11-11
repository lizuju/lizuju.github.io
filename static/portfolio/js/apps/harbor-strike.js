(() => {
    const desktopApi = window.GavinDesktop;
    const { t } = desktopApi;
    const GAME_URL = 'games/harbor-strike/';

    // The shooter needs a keyboard and mouse. games/harbor-strike/index.html repeats this check for direct visits.
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

        // The frame is same-origin, so a minimized window reports itself hidden to the game:
        // it pauses an active round and suspends its audio, as it does for a background tab.
        const setGameHidden = (hidden) => {
            const gameDocument = frame?.contentDocument;
            if (!gameDocument) return;
            try {
                if (hidden) {
                    Object.defineProperty(gameDocument, 'hidden', { configurable: true, get: () => true });
                    Object.defineProperty(gameDocument, 'visibilityState', { configurable: true, get: () => 'hidden' });
                } else {
                    delete gameDocument.hidden;
                    delete gameDocument.visibilityState;
                }
                gameDocument.dispatchEvent(new Event('visibilitychange'));
            } catch {
                // A failed hint only leaves the game running in the background.
            }
        };

        // The game reads this flag every audio frame; it starts from the same state on load.
        const syncAudioMute = () => {
            try {
                if (frame?.contentWindow) {
                    frame.contentWindow.__harborStrikeMuted = Boolean(desktopApi.isAudioMuted?.());
                }
            } catch {
                // The frame is same-origin; a failure only leaves the game's own volume in charge.
            }
        };
        window.addEventListener('gavin:audio-mute-change', syncAudioMute);

        // The game shares this page's thread, so it stops drawing (keeping its last frame) while
        // its window is behind another one, being dragged or resized, or the 3D camera has left
        // the monitor. The 3D scene in turn slows its own redraw while the game is on screen.
        let viewingMonitor = true;
        window.addEventListener('message', (event) => {
            if (event.origin !== window.location.origin || event.source !== window.parent
                || event.data?.source !== 'gavin-shell' || event.data?.type !== 'portfolio-view-state') return;
            viewingMonitor = event.data.active === true;
            syncWindowState();
        });

        let reportedRunning = false;
        const syncWindowState = () => {
            const hold = !viewingMonitor || !gameWindow.classList.contains('is-active')
                || gameWindow.classList.contains('is-dragging') || gameWindow.classList.contains('is-resizing');
            try {
                if (frame?.contentWindow) frame.contentWindow.__harborStrikeHold = hold;
            } catch {
                // Holding is only a saving; without it the game keeps drawing at its normal pace.
            }
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

        const unloadGame = () => {
            frame?.remove();
            frame = null;
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
            stage.append(frame);
            syncWindowState();

            // A same-origin frame shares this thread and the game's startup briefly blocks it,
            // so the window and its loading screen paint before the game page is requested.
            // The timeout covers background tabs, where animation frames never run.
            const pendingFrame = frame;
            const startGame = () => {
                if (frame !== pendingFrame || pendingFrame.hasAttribute('src')) return;
                pendingFrame.addEventListener('load', () => {
                    syncAudioMute();
                    syncWindowState();
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
