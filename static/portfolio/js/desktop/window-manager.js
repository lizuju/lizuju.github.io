(() => {
    const desktopApi = window.GavinDesktop;

    // Owns window stacking, focus, menus, drag/resize and the minimize/maximize/close
    // controls shared by every desktop window. Apps register their windows here.
    function createWindowManager({ desktop, startButton, startMenu }) {
        let pointerInteraction;
        const menuTriggers = Array.from(document.querySelectorAll('[data-window-menu]'));
        const restoreGeometry = new WeakMap();
        const windowEntries = [];
        const focusTargets = new Map();
        const menuActionHandlers = {};
        const sessionHooks = [];

        const isWindowVisible = (element) => (
            !element.classList.contains('is-minimized')
            && !element.classList.contains('is-closed')
        );

        const getWindowZIndex = (element) => Number.parseInt(window.getComputedStyle(element).zIndex, 10) || 0;

        const isFocusable = (element) => (
            element instanceof HTMLElement
            && !element.hidden
            && !element.matches(':disabled')
            && window.getComputedStyle(element).visibility === 'visible'
            && element.getClientRects().length > 0
        );

        const getWindowFocusTarget = (element) => {
            const preferred = focusTargets.get(element)?.() || null;
            if (isFocusable(preferred)) return preferred;

            return Array.from(element.querySelectorAll(
                'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
            )).find(isFocusable) || null;
        };

        const focusWindow = (element, moveFocus = false) => {
            const entry = windowEntries.find((candidate) => candidate.element === element);
            if (!entry || !isWindowVisible(element)) return null;

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

            if (moveFocus) getWindowFocusTarget(element)?.focus({ preventScroll: true });
            return entry;
        };

        const focusTopWindow = (excludedElement) => {
            const nextEntry = windowEntries
                .filter(({ element }) => element !== excludedElement && isWindowVisible(element))
                .sort((first, second) => getWindowZIndex(first.element) - getWindowZIndex(second.element))
                .at(-1);

            if (nextEntry) {
                focusWindow(nextEntry.element);
                return nextEntry;
            }

            windowEntries.forEach(({ element, task }) => {
                element.classList.remove('is-active');
                task.classList.remove('is-active');
            });

            return null;
        };

        const restoreFocusAfterWindowHidden = (hiddenElement, fallbackTask) => {
            const nextEntry = focusTopWindow(hiddenElement);
            const target = nextEntry
                ? getWindowFocusTarget(nextEntry.element)
                : fallbackTask && !fallbackTask.hidden
                    ? fallbackTask
                    : startButton;

            if (isFocusable(target)) target.focus({ preventScroll: true });
        };

        const getMenuPopup = (trigger) => document.querySelector(
            `[data-window-menu-popup="${trigger.dataset.windowMenu}"]`
        );

        const getMenuItems = (popup) => Array.from(popup.querySelectorAll('[role="menuitem"]'))
            .filter((item) => !item.disabled && !item.hidden);

        const closeWindowMenus = () => {
            document.querySelectorAll('[data-window-menu-popup]').forEach((popup) => {
                popup.hidden = true;
            });
            menuTriggers.forEach((trigger) => {
                trigger.setAttribute('aria-expanded', 'false');
            });
        };

        const closeStartMenu = () => {
            startMenu.hidden = true;
            startButton.setAttribute('aria-expanded', 'false');
            closeWindowMenus();
        };

        const openWindowMenu = (trigger, focusPosition) => {
            const popup = getMenuPopup(trigger);
            if (!popup) return;

            closeStartMenu();
            popup.hidden = false;
            trigger.setAttribute('aria-expanded', 'true');

            if (!focusPosition) return;
            const items = getMenuItems(popup);
            const target = focusPosition === 'last' ? items.at(-1) : items[0];
            target?.focus({ preventScroll: true });
        };

        const getAdjacentMenuTrigger = (trigger, offset) => {
            const menubar = trigger.closest('[data-window-menubar]');
            const triggers = Array.from(menubar?.querySelectorAll('[data-window-menu]') || []);
            const index = triggers.indexOf(trigger);
            if (index < 0 || !triggers.length) return null;
            return triggers[(index + offset + triggers.length) % triggers.length];
        };

        const moveToAdjacentMenu = (trigger, offset, openMenu) => {
            const nextTrigger = getAdjacentMenuTrigger(trigger, offset);
            if (!nextTrigger) return;
            closeWindowMenus();
            nextTrigger.focus({ preventScroll: true });
            if (openMenu) openWindowMenu(nextTrigger, 'first');
        };

        menuTriggers.forEach((trigger) => {
            trigger.addEventListener('click', (event) => {
                event.stopPropagation();
                trigger.focus({ preventScroll: true });
                const shouldOpen = trigger.getAttribute('aria-expanded') !== 'true';
                closeWindowMenus();
                if (shouldOpen) openWindowMenu(trigger);
            });
            trigger.addEventListener('keydown', (event) => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault();
                    openWindowMenu(trigger, event.key === 'ArrowUp' ? 'last' : 'first');
                    return;
                }
                if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                    event.preventDefault();
                    const openMenu = trigger.getAttribute('aria-expanded') === 'true';
                    moveToAdjacentMenu(trigger, event.key === 'ArrowLeft' ? -1 : 1, openMenu);
                    return;
                }
                if (event.key === 'Escape') {
                    closeWindowMenus();
                    trigger.focus({ preventScroll: true });
                }
            });
        });

        document.querySelectorAll('[data-window-menu-popup]').forEach((popup) => {
            popup.addEventListener('keydown', (event) => {
                const item = event.target.closest?.('[role="menuitem"]');
                if (!item) return;

                const items = getMenuItems(popup);
                const index = items.indexOf(item);
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault();
                    const offset = event.key === 'ArrowDown' ? 1 : -1;
                    items[(index + offset + items.length) % items.length]?.focus({ preventScroll: true });
                    return;
                }
                if (event.key === 'Home' || event.key === 'End') {
                    event.preventDefault();
                    (event.key === 'Home' ? items[0] : items.at(-1))?.focus({ preventScroll: true });
                    return;
                }

                const trigger = popup.closest('.window-menu')?.querySelector('[data-window-menu]');
                if (!trigger) return;
                if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                    event.preventDefault();
                    moveToAdjacentMenu(trigger, event.key === 'ArrowLeft' ? -1 : 1, true);
                    return;
                }
                if (event.key === 'Escape') {
                    event.preventDefault();
                    closeWindowMenus();
                    trigger.focus({ preventScroll: true });
                }
            });
        });

        document.querySelectorAll('[data-window-menubar]').forEach((menubar) => {
            menubar.addEventListener('click', (event) => event.stopPropagation());
        });
        document.addEventListener('gavin:close-window-menus', closeWindowMenus);
        document.addEventListener('click', closeWindowMenus);
        document.addEventListener('focusin', (event) => {
            if (!event.target.closest?.('[data-window-menubar]')) closeWindowMenus();
        });

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

        const restoreWindowGeometry = (element, geometry) => {
            if (!geometry || !['left', 'top', 'width', 'height'].every((key) => Number.isFinite(geometry[key]))) return;

            const workArea = getWorkArea();
            const width = Math.min(Math.max(1, geometry.width), workArea.width);
            const height = Math.min(Math.max(1, geometry.height), workArea.height);
            applyWindowGeometry(element, {
                left: Math.min(Math.max(0, geometry.left), Math.max(0, workArea.width - width)),
                top: Math.min(Math.max(0, geometry.top), Math.max(0, workArea.height - height)),
                width,
                height
            });
        };

        const updateMaximizeButtons = (element, selector) => {
            const maximized = element.classList.contains('is-maximized');
            document.querySelectorAll(selector).forEach((button) => {
                button.setAttribute('aria-pressed', String(maximized));
            });
        };

        const toggleMaximize = (element, selector) => {
            if (element.classList.contains('is-maximized')) {
                element.classList.remove('is-maximized');
                const geometry = restoreGeometry.get(element);
                if (geometry) restoreWindowGeometry(element, geometry);
            } else {
                restoreGeometry.set(element, getWindowGeometry(element));
                clearWindowGeometry(element);
                element.classList.add('is-maximized');
            }
            updateMaximizeButtons(element, selector);
        };

        const startPointerInteraction = (event, type, element, minWidth, minHeight) => {
            if (event.button !== 0 || element.classList.contains('is-maximized')) return;

            const geometry = getWindowGeometry(element);
            applyWindowGeometry(element, geometry);
            const mobileWindow = window.innerWidth <= 900;
            pointerInteraction = {
                type,
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                geometry,
                element,
                minWidth: mobileWindow ? Math.min(minWidth, 260) : minWidth,
                minHeight: mobileWindow ? Math.min(minHeight, 280) : minHeight
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
            closeWindowMenus();
            element.classList.remove('is-minimized', 'is-closed');
            if (revealTask) task.hidden = false;
            if (!element.classList.contains('is-maximized') && (window.innerWidth > 900 || element.style.width)) {
                restoreWindowGeometry(element, getWindowGeometry(element));
            }
            focusWindow(element, true);
            closeStartMenu();

            if (!target) return;
            window.requestAnimationFrame(() => {
                window.GavinDesktop.scrollPortfolioWindow(target);
            });
        };

        const hideWindow = (element, task, state, { hideTask = false } = {}) => {
            closeWindowMenus();
            element.classList.remove('is-minimized', 'is-closed');
            element.classList.add(state);
            element.classList.remove('is-active');
            task.classList.remove('is-active');
            if (hideTask) task.hidden = true;
            restoreFocusAfterWindowHidden(element, task);
            closeStartMenu();
        };

        // Registers a desktop window. The manager wires its taskbar button, titlebar drag,
        // resize grip, double-click maximize and minimize/maximize/close buttons.
        const registerWindow = ({
            id, element, task, titlebar, resizeHandle, actionAttribute,
            minWidth, minHeight, show, hide, focusTarget
        }) => {
            const maximizeSelector = `[${actionAttribute}="maximize"]`;
            const entry = { id, element, task, maximizeSelector };
            windowEntries.push(entry);
            if (focusTarget) focusTargets.set(element, focusTarget);

            const showApp = show || (() => showWindow(element, task, { revealTask: true }));
            const hideApp = hide || ((state) => hideWindow(element, task, state, { hideTask: state === 'is-closed' }));
            const maximize = () => toggleMaximize(element, maximizeSelector);
            Object.assign(entry, { show: showApp, hide: hideApp, toggleMaximize: maximize });

            task.addEventListener('click', () => {
                if (element.classList.contains('is-minimized') || element.classList.contains('is-closed')) {
                    showApp();
                    return;
                }
                if (element.classList.contains('is-active')) {
                    hideApp('is-minimized');
                    return;
                }
                focusWindow(element, true);
            });

            document.querySelectorAll(`[${actionAttribute}]`).forEach((button) => {
                button.addEventListener('click', () => {
                    const action = button.getAttribute(actionAttribute);
                    if (action === 'minimize') hideApp('is-minimized');
                    if (action === 'close') hideApp('is-closed');
                    if (action === 'maximize') maximize();
                });
            });

            titlebar.addEventListener('pointerdown', (event) => {
                if (event.target.closest('.window-controls')) return;
                startPointerInteraction(event, 'drag', element, minWidth, minHeight);
            });
            resizeHandle.addEventListener('pointerdown', (event) => {
                startPointerInteraction(event, 'resize', element, minWidth, minHeight);
            });
            titlebar.addEventListener('dblclick', (event) => {
                if (event.target.closest('.window-controls')) return;
                maximize();
            });

            return entry;
        };

        // For windows that manage their own chrome (Gomoku): they only join focus and stacking.
        const registerExternalWindow = ({ id, element, task, focusTarget }) => {
            windowEntries.push({ id, element, task, external: true });
            if (focusTarget) focusTargets.set(element, focusTarget);
        };

        const getWindow = (id) => windowEntries.find((entry) => entry.id === id);

        const addMenuActions = (handlers) => Object.assign(menuActionHandlers, handlers);
        const onSession = (hooks) => sessionHooks.push(hooks);

        const getWindowSessionState = ({ element, task }) => ({
            minimized: element.classList.contains('is-minimized'),
            closed: element.classList.contains('is-closed'),
            taskHidden: task.hidden,
            zIndex: element.style.zIndex || null
        });

        const getDesktopWindowState = (entry, previousState) => {
            const maximized = entry.element.classList.contains('is-maximized');
            const previousWindow = previousState?.windows?.[entry.id];
            const geometry = window.innerWidth > 900 && isWindowVisible(entry.element) && !maximized
                ? getWindowGeometry(entry.element)
                : previousWindow?.geometry || null;

            return {
                geometry,
                maximized: window.innerWidth > 900 ? maximized : Boolean(previousWindow?.maximized)
            };
        };

        const saveDesktopSession = () => {
            const previousState = desktopApi.readDesktopSession();
            const activeEntry = windowEntries.find(({ element }) => element.classList.contains('is-active'));
            const desktopState = window.innerWidth > 900
                ? {
                    windows: Object.fromEntries(windowEntries
                        .filter((entry) => !entry.external)
                        .map((entry) => [entry.id, getDesktopWindowState(entry, previousState?.desktop)]))
                }
                : previousState?.desktop || null;

            const session = {
                version: 1,
                context: desktopApi.getSessionContext(),
                activeWindowId: activeEntry?.id || null,
                windows: Object.fromEntries(windowEntries.map((entry) => [entry.id, getWindowSessionState(entry)]))
            };
            sessionHooks.forEach(({ save }) => save && Object.assign(session, save()));
            session.desktop = desktopState;
            desktopApi.storeDesktopSession(session);
        };

        const restoreDesktopSession = () => {
            const savedState = desktopApi.readDesktopSession();
            if (!savedState || savedState.version !== 1 || savedState.context !== desktopApi.getSessionContext()) return null;

            windowEntries.forEach((entry) => {
                const state = savedState.windows?.[entry.id];
                if (!state) return;
                if (desktopApi.isMobileHomepage() && entry.id === 'portfolio') return;

                entry.element.classList.toggle('is-minimized', Boolean(state.minimized));
                entry.element.classList.toggle('is-closed', Boolean(state.closed));
                entry.task.hidden = Boolean(state.taskHidden);
                if (state.zIndex) entry.element.style.zIndex = state.zIndex;
            });

            if (window.innerWidth > 900) {
                windowEntries.filter((entry) => !entry.external).forEach(({ id, element, maximizeSelector }) => {
                    const state = savedState.desktop?.windows?.[id];
                    if (!state) return;

                    if (state.maximized) {
                        clearWindowGeometry(element);
                        element.classList.add('is-maximized');
                    } else {
                        element.classList.remove('is-maximized');
                        restoreWindowGeometry(element, state.geometry);
                    }
                    updateMaximizeButtons(element, maximizeSelector);
                });
            }

            sessionHooks.forEach(({ restore }) => restore?.(savedState));

            const activeEntry = windowEntries.find(({ id, element }) => (
                id === savedState.activeWindowId && isWindowVisible(element)
            ));
            return activeEntry || null;
        };

        // Binds listeners that span every registered window. Called once all apps are registered.
        const bindGlobalListeners = () => {
            document.querySelectorAll('[data-menu-action]').forEach((button) => {
                button.addEventListener('click', () => {
                    const handler = menuActionHandlers[button.dataset.menuAction];
                    const trigger = button.closest('.window-menu')?.querySelector('[data-window-menu]');
                    closeWindowMenus();
                    trigger?.focus({ preventScroll: true });
                    handler?.();
                });
            });

            document.addEventListener('pointermove', updatePointerInteraction);
            document.addEventListener('pointerup', finishPointerInteraction);
            document.addEventListener('pointercancel', finishPointerInteraction);

            window.addEventListener('resize', () => {
                finishPointerInteraction();
                if (window.innerWidth <= 900) {
                    windowEntries.filter((entry) => !entry.external).forEach(({ element, maximizeSelector }) => {
                        element.classList.remove('is-maximized');
                        restoreGeometry.delete(element);
                        clearWindowGeometry(element);
                        updateMaximizeButtons(element, maximizeSelector);
                    });
                } else {
                    windowEntries.forEach(({ element, external }) => {
                        if (external || !isWindowVisible(element)
                            || element.classList.contains('is-maximized')) return;
                        restoreWindowGeometry(element, getWindowGeometry(element));
                    });
                }
            });

            desktop.addEventListener('gavin:focus-window', (event) => {
                const targetWindow = event.target.closest?.('.app-window');
                if (targetWindow) focusWindow(targetWindow, true);
            });
            desktop.addEventListener('gavin:window-hidden', (event) => {
                const targetWindow = event.target.closest?.('.app-window');
                const entry = windowEntries.find((candidate) => candidate.element === targetWindow);
                restoreFocusAfterWindowHidden(targetWindow, entry?.task);
            });
            windowEntries.forEach(({ element }) => {
                element.addEventListener('pointerdown', () => focusWindow(element));
                element.addEventListener('focusin', () => focusWindow(element));
            });
            window.addEventListener('pagehide', saveDesktopSession);
            window.addEventListener('gavin:save-session-state', saveDesktopSession);
        };

        return {
            desktop,
            startButton,
            startMenu,
            isWindowVisible,
            isFocusable,
            focusWindow,
            showWindow,
            hideWindow,
            closeWindowMenus,
            closeStartMenu,
            clearWindowGeometry,
            updateMaximizeButtons,
            toggleMaximize,
            registerWindow,
            registerExternalWindow,
            getWindow,
            addMenuActions,
            onSession,
            restoreDesktopSession,
            bindGlobalListeners
        };
    }

    desktopApi.createWindowManager = createWindowManager;
})();
