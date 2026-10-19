(() => {
    const desktopApi = window.GavinDesktop;

    desktopApi.apps.recycleBin = () => {
        const opener = document.querySelector('[data-open-recycle-bin]');
        const dialog = document.getElementById('recycle-bin-dialog');
        const files = dialog.querySelector('[data-recycle-files]');
        const hint = dialog.querySelector('[data-recycle-hint]');
        const emptyButton = dialog.querySelector('[data-recycle-empty]');
        const status = dialog.querySelector('[data-recycle-status]');

        const updateStatus = () => {
            status.textContent = desktopApi.t()[files.hidden ? 'recycleEmptyStatus' : 'recycleCount'];
        };

        opener.addEventListener('click', () => dialog.showModal());
        dialog.addEventListener('close', () => opener.focus());
        dialog.querySelectorAll('[data-recycle-close]').forEach((button) => {
            button.addEventListener('click', () => dialog.close());
        });
        emptyButton.addEventListener('click', () => {
            files.hidden = true;
            hint.hidden = false;
            emptyButton.disabled = true;
            opener.classList.add('is-empty');
            updateStatus();
            dialog.querySelector('.recycle-actions [data-recycle-close]').focus();
        });
        ['keydown', 'keyup'].forEach((type) => {
            dialog.addEventListener(type, (event) => event.stopPropagation());
        });
        window.addEventListener('portfolio-language-change', updateStatus);
        updateStatus();
    };
})();
