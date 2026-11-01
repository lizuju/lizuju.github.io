import { setupSyncStorage } from './sync-storage.js';
import { setupSyncDiagnostics } from './sync-diagnostics-view.js';

(() => {
    const desktop = window.GavinDesktop;
    desktop.apps.controlPanel = (manager) => {
        const app = document.querySelector('[data-control-panel-window]');
        const root = app.querySelector('[data-control-panel-root]');
        const view = app.querySelector('[data-sync-storage-view]');
        const item = app.querySelector('[data-open-sync-storage]');
        const diagnosticsView = app.querySelector('[data-sync-diagnostics-view]');
        const diagnosticsItem = app.querySelector('[data-open-sync-diagnostics]');
        const back = app.querySelector('[data-control-panel-back]');
        const location = app.querySelector('[data-control-panel-location]');
        const storage = setupSyncStorage(view);
        const diagnostics = setupSyncDiagnostics(diagnosticsView);
        let page = 'root';
        const updateLocation = () => {
            location.textContent = page === 'root' ? desktop.t().controlPanel
                : `${desktop.t().controlPanel} › ${desktop.t()[page === 'storage' ? 'syncStorage' : 'syncDiagnostics']}`;
        };
        const setPage = (nextPage) => {
            page = nextPage;
            root.hidden = page !== 'root';
            view.hidden = page !== 'storage';
            diagnosticsView.hidden = page !== 'diagnostics';
            back.hidden = page === 'root';
            updateLocation();
            if (page === 'storage') storage.show();
            else storage.reset();
            if (page === 'diagnostics') diagnostics.show();
        };
        const entry = manager.registerWindow({
            id: 'control-panel', element: app, task: document.querySelector('[data-control-panel-task]'),
            titlebar: app.querySelector('[data-control-panel-drag]'), resizeHandle: app.querySelector('[data-control-panel-resize]'),
            actionAttribute: 'data-control-panel-action', minWidth: 280, minHeight: 220,
            focusTarget: () => page === 'root' ? item : back,
            show: () => {
                manager.showWindow(app, entry.task, { revealTask: true });
                if (!view.hidden) storage.show();
                if (!diagnosticsView.hidden) diagnostics.show();
            },
            hide: (state) => {
                if (state === 'is-closed') setPage('root');
                manager.hideWindow(app, entry.task, state, { hideTask: state === 'is-closed' });
            }
        });
        item.addEventListener('click', () => {
            setPage('storage');
            back.focus({ preventScroll: true });
        });
        diagnosticsItem.addEventListener('click', () => {
            setPage('diagnostics');
            back.focus({ preventScroll: true });
        });
        back.addEventListener('click', () => {
            const target = page === 'diagnostics' ? diagnosticsItem : item;
            setPage('root');
            target.focus({ preventScroll: true });
        });
        document.querySelector('[data-open-control-panel]').addEventListener('click', entry.show);
        manager.onSession({
            save: () => ({ controlPanelView: page }),
            restore: (state) => {
                if (!app.classList.contains('is-closed') && ['storage', 'diagnostics'].includes(state.controlPanelView)) setPage(state.controlPanelView);
            }
        });
        window.addEventListener('portfolio-language-change', () => {
            updateLocation();
            app.querySelectorAll('[data-i18n-aria]').forEach((element) => element.setAttribute('aria-label', desktop.t()[element.dataset.i18nAria]));
        });
    };
})();
