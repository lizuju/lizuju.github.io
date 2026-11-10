(() => {
    const desktopApi = window.GavinDesktop;

    desktopApi.apps.recycleBin = (manager) => {
        const opener = document.querySelector('[data-open-recycle-bin]');
        const recycleWindow = document.querySelector('[data-recycle-window]');
        const closeButton = recycleWindow.querySelector('.recycle-actions [data-recycle-action="close"]');
        const files = recycleWindow.querySelector('[data-recycle-files]');
        const fileButtons = [...files.querySelectorAll('[data-recycle-file]')];
        const hint = recycleWindow.querySelector('[data-recycle-hint]');
        const intro = recycleWindow.querySelector('.recycle-intro');
        const emptyButton = recycleWindow.querySelector('[data-recycle-empty]');
        const restoreButton = recycleWindow.querySelector('[data-recycle-restore]');
        const resetButton = recycleWindow.querySelector('[data-recycle-reset]');
        const status = recycleWindow.querySelector('[data-recycle-status]');
        const detail = recycleWindow.querySelector('[data-recycle-detail]');
        const detailTitle = recycleWindow.querySelector('[data-recycle-detail-title]');
        const detailText = recycleWindow.querySelector('[data-recycle-detail-text]');
        let selected = null;
        let restored = null;

        const entry = manager.registerWindow({
            id: 'recycle-bin',
            element: recycleWindow,
            task: document.querySelector('[data-recycle-task]'),
            titlebar: recycleWindow.querySelector('[data-recycle-drag]'),
            resizeHandle: recycleWindow.querySelector('[data-recycle-resize]'),
            actionAttribute: 'data-recycle-action',
            minWidth: 320,
            minHeight: 320,
            focusTarget: () => emptyButton.disabled ? closeButton : emptyButton
        });

        const render = () => {
            const copy = desktopApi.t();
            const count = fileButtons.filter(button => !button.parentElement.hidden).length;
            files.hidden = count === 0;
            intro.hidden = count === 0;
            hint.hidden = count > 0;
            emptyButton.disabled = count === 0;
            restoreButton.disabled = selected === null;
            opener.classList.toggle('is-empty', count === 0);
            status.textContent = count ? copy.recycleCount.replace('{count}', count) : copy.recycleEmptyStatus;
            fileButtons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.recycleFile === selected)));
            detail.hidden = !count || (!selected && !restored);
            if (selected) {
                detailTitle.textContent = copy[`recycle${selected}`];
                detailText.textContent = copy[`recycle${selected}Detail`];
            } else if (restored) {
                detailTitle.textContent = copy.recycleRestored;
                detailText.textContent = copy[`recycle${restored}Restored`];
            }
        };

        opener.addEventListener('click', entry.show);
        fileButtons.forEach(button => button.addEventListener('click', () => {
            selected = button.dataset.recycleFile;
            restored = null;
            render();
        }));
        restoreButton.addEventListener('click', () => {
            const button = fileButtons.find(item => item.dataset.recycleFile === selected);
            button.parentElement.hidden = true;
            restored = selected;
            selected = null;
            render();
            const next = fileButtons.find(item => !item.parentElement.hidden);
            (next || resetButton).focus({ preventScroll: true });
        });
        emptyButton.addEventListener('click', () => {
            fileButtons.forEach(button => { button.parentElement.hidden = true; });
            selected = null;
            restored = null;
            render();
            closeButton.focus({ preventScroll: true });
        });
        resetButton.addEventListener('click', () => {
            fileButtons.forEach(button => { button.parentElement.hidden = false; });
            selected = null;
            restored = null;
            render();
            fileButtons[0].focus({ preventScroll: true });
        });
        window.addEventListener('portfolio-language-change', render);
        render();
    };
})();
