import { setupSyncStorage } from './sync-storage.js';

(() => {
    const desktop = window.GavinDesktop;
    desktop.apps.controlPanel = (manager) => {
        const app = document.querySelector('[data-control-panel-window]');
        const root = app.querySelector('[data-control-panel-root]');
        const view = app.querySelector('[data-sync-storage-view]');
        const item = app.querySelector('[data-open-sync-storage]');
        const back = app.querySelector('[data-control-panel-back]');
        const location = app.querySelector('[data-control-panel-location]');
        const storage = setupSyncStorage(view);
        const updateLocation = () => {
            location.textContent = view.hidden ? desktop.t().controlPanel : `${desktop.t().controlPanel} › ${desktop.t().syncStorage}`;
        };
        const setPage = (showStorage) => {
            root.hidden = showStorage;
            view.hidden = !showStorage;
            back.hidden = !showStorage;
            updateLocation();
            if (showStorage) storage.show();
            else storage.reset();
        };
        const entry = manager.registerWindow({
            id: 'control-panel', element: app, task: document.querySelector('[data-control-panel-task]'),
            titlebar: app.querySelector('[data-control-panel-drag]'), resizeHandle: app.querySelector('[data-control-panel-resize]'),
            actionAttribute: 'data-control-panel-action', minWidth: 280, minHeight: 220,
            focusTarget: () => view.hidden ? item : back,
            show: () => {
                manager.showWindow(app, entry.task, { revealTask: true });
                if (!view.hidden) storage.show();
            },
            hide: (state) => {
                if (state === 'is-closed') setPage(false);
                manager.hideWindow(app, entry.task, state, { hideTask: state === 'is-closed' });
            }
        });
        item.addEventListener('click', () => {
            setPage(true);
            back.focus({ preventScroll: true });
        });
        back.addEventListener('click', () => {
            setPage(false);
            item.focus({ preventScroll: true });
        });
        document.querySelector('[data-open-control-panel]').addEventListener('click', entry.show);
        manager.onSession({
            save: () => ({ controlPanelView: view.hidden ? 'root' : 'storage' }),
            restore: (state) => {
                if (!app.classList.contains('is-closed') && state.controlPanelView === 'storage') setPage(true);
            }
        });
        window.addEventListener('portfolio-language-change', () => {
            updateLocation();
            app.querySelectorAll('[data-i18n-aria]').forEach((element) => element.setAttribute('aria-label', desktop.t()[element.dataset.i18nAria]));
        });
    };
})();
