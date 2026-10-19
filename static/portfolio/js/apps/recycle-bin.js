(() => {
    const desktopApi = window.GavinDesktop;

    desktopApi.apps.recycleBin = (manager) => {
        const opener = document.querySelector('[data-open-recycle-bin]');
        const recycleWindow = document.querySelector('[data-recycle-window]');
        const closeButton = recycleWindow.querySelector('.recycle-actions [data-recycle-action="close"]');
        const files = recycleWindow.querySelector('[data-recycle-files]');
        const hint = recycleWindow.querySelector('[data-recycle-hint]');
        const emptyButton = recycleWindow.querySelector('[data-recycle-empty]');
        const status = recycleWindow.querySelector('[data-recycle-status]');

        const entry = manager.registerWindow({
            id: 'recycle-bin',
            element: recycleWindow,
            task: document.querySelector('[data-recycle-task]'),
            titlebar: recycleWindow.querySelector('[data-recycle-drag]'),
            resizeHandle: recycleWindow.querySelector('[data-recycle-resize]'),
            actionAttribute: 'data-recycle-action',
            minWidth: 320,
            minHeight: 280,
            focusTarget: () => emptyButton.disabled ? closeButton : emptyButton
        });

        const updateStatus = () => {
            status.textContent = desktopApi.t()[files.hidden ? 'recycleEmptyStatus' : 'recycleCount'];
        };

        opener.addEventListener('click', entry.show);
        emptyButton.addEventListener('click', () => {
            files.hidden = true;
            hint.hidden = false;
            emptyButton.disabled = true;
            opener.classList.add('is-empty');
            updateStatus();
            closeButton.focus({ preventScroll: true });
        });
        window.addEventListener('portfolio-language-change', updateStatus);
        updateStatus();
    };
})();
