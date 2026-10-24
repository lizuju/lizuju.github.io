(() => {
    const desktop = window.GavinDesktop;
    desktop.apps.controlPanel = (manager) => {
        const app = document.querySelector('[data-control-panel-window]');
        const entry = manager.registerWindow({
            id: 'control-panel', element: app, task: document.querySelector('[data-control-panel-task]'),
            titlebar: app.querySelector('[data-control-panel-drag]'), resizeHandle: app.querySelector('[data-control-panel-resize]'),
            actionAttribute: 'data-control-panel-action', minWidth: 280, minHeight: 220,
            focusTarget: () => app.querySelector('[data-open-sync-storage]')
        });
        document.querySelector('[data-open-control-panel]').addEventListener('click', entry.show);
        window.addEventListener('portfolio-language-change', () => {
            app.querySelectorAll('[data-i18n-aria]').forEach((element) => element.setAttribute('aria-label', desktop.t()[element.dataset.i18nAria]));
        });
    };
})();
