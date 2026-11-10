(() => {
    const desktopApi = window.GavinDesktop;

    desktopApi.apps.recycleBin = (manager) => {
        const opener = document.querySelector('[data-open-recycle-bin]');
        const recycleWindow = document.querySelector('[data-recycle-window]');
        const closeButton = recycleWindow.querySelector('.window-controls [data-recycle-action="close"]');
        const content = recycleWindow.querySelector('.recycle-content');
        const files = recycleWindow.querySelector('[data-recycle-files]');
        const fileButtons = [...files.querySelectorAll('[data-recycle-file]')];
        const hint = recycleWindow.querySelector('[data-recycle-hint]');
        const emptyButton = recycleWindow.querySelector('[data-recycle-empty]');
        const restoreButton = recycleWindow.querySelector('[data-recycle-restore]');
        const resetButton = recycleWindow.querySelector('[data-recycle-reset]');
        const status = recycleWindow.querySelector('[data-recycle-status]');
        const selectionStatus = recycleWindow.querySelector('[data-recycle-selection-status]');
        const detail = recycleWindow.querySelector('[data-recycle-detail]');
        const detailTitle = recycleWindow.querySelector('[data-recycle-detail-title]');
        const detailText = recycleWindow.querySelector('[data-recycle-detail-text]');
        const context = recycleWindow.querySelector('[data-recycle-context]');
        const dialog = recycleWindow.querySelector('[data-recycle-dialog]');
        const confirmButton = dialog.querySelector('[data-recycle-confirm]');
        const properties = dialog.querySelector('[data-recycle-properties]');
        const selected = new Set();
        const deletedAt = new Date();
        let anchor = null;
        let restored = null;
        let propertyFile = null;
        let pendingDeletion = [];
        let contextTarget = null;
        let dialogTarget = null;

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

        const remainingFiles = () => fileButtons.filter(button => !button.parentElement.hidden);
        const closeContext = (restoreFocus = false) => {
            context.hidden = true;
            if (restoreFocus) (contextTarget || closeButton).focus({ preventScroll: true });
        };
        const render = () => {
            const copy = desktopApi.t();
            const remaining = remainingFiles();
            const count = remaining.length;
            const date = deletedAt.toLocaleString(desktopApi.getLanguage(), {
                year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
            });
            files.hidden = count === 0;
            content.querySelector('.recycle-intro').hidden = count === 0;
            hint.hidden = count > 0;
            emptyButton.disabled = count === 0;
            restoreButton.disabled = selected.size === 0;
            for (const action of ['restore', 'delete', 'properties', 'clear-selection']) {
                recycleWindow.querySelector(`[data-menu-action="recycle-${action}"]`).disabled = selected.size === 0;
            }
            recycleWindow.querySelector('[data-menu-action="recycle-select-all"]').disabled = count === 0;
            recycleWindow.querySelector('[data-menu-action="recycle-empty"]').disabled = count === 0;
            for (const command of context.querySelectorAll('[data-recycle-command]')) {
                command.disabled = command.dataset.recycleCommand === 'empty' ? count === 0 : selected.size === 0;
            }
            opener.classList.toggle('is-empty', count === 0);
            status.textContent = count ? copy.recycleCount.replace('{count}', count) : copy.recycleEmptyStatus;
            selectionStatus.textContent = selected.size ? copy.recycleSelected.replace('{count}', selected.size) : copy.recycleStatusHint;
            fileButtons.forEach(button => {
                button.setAttribute('aria-pressed', String(selected.has(button)));
                button.tabIndex = button === ([...selected][0] || remaining[0]) ? 0 : -1;
            });
            detail.hidden = !count || !restored;
            if (restored) {
                detailTitle.textContent = copy.recycleRestored;
                detailText.textContent = copy[`recycle${restored}Restored`] || copy.recycleManyRestored;
            }
            if (dialog.open) {
                dialog.querySelector('[data-recycle-dialog-title]').textContent = propertyFile
                    ? `${copy.recycleProperties} — ${copy[`recycle${propertyFile.dataset.recycleFile}`]}` : copy.recycleConfirmTitle;
                dialog.querySelector('[data-recycle-dialog-copy]').textContent = propertyFile
                    ? copy[`recycle${propertyFile.dataset.recycleFile}Detail`]
                    : copy.recycleConfirmCopy.replace('{count}', pendingDeletion.length);
                properties.hidden = !propertyFile;
                confirmButton.hidden = Boolean(propertyFile);
                dialog.querySelector('[data-recycle-cancel]').textContent = propertyFile ? copy.menuClose : copy.recycleCancel;
                if (propertyFile) {
                    properties.querySelector('[data-recycle-property="location"]').textContent = propertyFile.dataset.recycleLocation;
                    properties.querySelector('[data-recycle-property="date"]').textContent = date;
                    properties.querySelector('[data-recycle-property="type"]').textContent = copy[`recycle${propertyFile.dataset.recycleFile}Type`];
                }
            }
        };
        const selectFile = (button, event = {}) => {
            const remaining = remainingFiles();
            if (event.shiftKey && remaining.includes(anchor)) {
                const start = remaining.indexOf(anchor);
                const end = remaining.indexOf(button);
                if (!event.ctrlKey && !event.metaKey) selected.clear();
                remaining.slice(Math.min(start, end), Math.max(start, end) + 1).forEach(item => selected.add(item));
            } else if (event.ctrlKey || event.metaKey) {
                if (selected.has(button)) selected.delete(button);
                else selected.add(button);
                anchor = button;
            } else {
                selected.clear();
                selected.add(button);
                anchor = button;
            }
            restored = null;
            render();
        };
        const restoreSelected = () => {
            if (!selected.size) return;
            restored = selected.size === 1 ? [...selected][0].dataset.recycleFile : 'Many';
            selected.forEach(button => { button.parentElement.hidden = true; });
            selected.clear();
            anchor = null;
            render();
            (remainingFiles()[0] || resetButton).focus({ preventScroll: true });
        };
        const confirmDeletion = (all = false) => {
            pendingDeletion = all ? remainingFiles() : [...selected];
            if (!pendingDeletion.length) return;
            propertyFile = null;
            dialogTarget = all ? emptyButton : [...selected].at(-1);
            dialog.showModal();
            render();
            dialog.querySelector('[data-recycle-cancel]').focus({ preventScroll: true });
        };
        const showProperties = (button = [...selected].at(-1)) => {
            if (!button) return;
            propertyFile = button;
            pendingDeletion = [];
            dialogTarget = button;
            dialog.showModal();
            render();
            dialog.querySelector('[data-recycle-cancel]').focus({ preventScroll: true });
        };
        const showContext = (button, x, y) => {
            document.dispatchEvent(new Event('gavin:close-window-menus'));
            if (button && !selected.has(button)) selectFile(button);
            if (!button) {
                selected.clear();
                render();
            }
            contextTarget = button || emptyButton;
            context.hidden = false;
            const bounds = recycleWindow.getBoundingClientRect();
            const left = (x - bounds.left) * recycleWindow.offsetWidth / bounds.width;
            const top = (y - bounds.top) * recycleWindow.offsetHeight / bounds.height;
            context.style.left = `${Math.max(2, Math.min(left, recycleWindow.clientWidth - context.offsetWidth - 4))}px`;
            context.style.top = `${Math.max(2, Math.min(top, recycleWindow.clientHeight - context.offsetHeight - 4))}px`;
            context.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
        };

        opener.addEventListener('click', entry.show);
        fileButtons.forEach(button => {
            button.addEventListener('click', event => selectFile(button, event));
            button.addEventListener('dblclick', () => showProperties(button));
        });
        files.addEventListener('keydown', event => {
            const button = event.target.closest('[data-recycle-file]');
            if (!button) return;
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
                event.preventDefault();
                remainingFiles().forEach(item => selected.add(item));
                render();
            } else if (event.key === 'Delete') {
                event.preventDefault();
                confirmDeletion();
            } else if (event.key === 'Enter') {
                event.preventDefault();
                showProperties(button);
            } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                event.preventDefault();
                const bounds = button.getBoundingClientRect();
                showContext(button, bounds.left + 16, bounds.bottom);
            } else if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                event.preventDefault();
                const remaining = remainingFiles();
                const nextRow = remaining.findIndex(item => item.offsetTop !== remaining[0].offsetTop);
                const columns = nextRow < 0 ? remaining.length : nextRow;
                const offset = { ArrowUp: -columns, ArrowDown: columns, ArrowLeft: -1, ArrowRight: 1 }[event.key];
                const index = event.key === 'Home' ? 0 : event.key === 'End' ? remaining.length - 1
                    : Math.max(0, Math.min(remaining.length - 1, remaining.indexOf(button) + offset));
                const next = remaining[index];
                if (!event.ctrlKey && !event.metaKey) selectFile(next, event);
                next.focus({ preventScroll: true });
                next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            }
        });
        content.addEventListener('click', event => {
            if (event.target.closest('button, .recycle-detail')) return;
            selected.clear();
            restored = null;
            render();
        });
        content.addEventListener('contextmenu', event => {
            event.preventDefault();
            showContext(event.target.closest('[data-recycle-file]'), event.clientX, event.clientY);
        });
        restoreButton.addEventListener('click', restoreSelected);
        emptyButton.addEventListener('click', () => confirmDeletion(true));
        resetButton.addEventListener('click', () => {
            fileButtons.forEach(button => { button.parentElement.hidden = false; });
            selected.clear();
            anchor = null;
            restored = null;
            render();
            fileButtons[0].focus({ preventScroll: true });
        });
        context.addEventListener('click', event => {
            const button = event.target.closest('[data-recycle-command]');
            if (!button || button.disabled) return;
            closeContext(true);
            const command = button.dataset.recycleCommand;
            if (command === 'restore') restoreSelected();
            else if (command === 'properties') showProperties();
            else confirmDeletion(command === 'empty');
        });
        context.addEventListener('keydown', event => {
            if (event.key === 'Escape' || event.key === 'Tab') {
                if (event.key === 'Escape') event.preventDefault();
                closeContext(true);
            } else if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
                event.preventDefault();
                const items = [...context.querySelectorAll('button:not(:disabled)')];
                const index = items.indexOf(document.activeElement);
                const target = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
                    : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
                items[target]?.focus({ preventScroll: true });
            }
        });
        document.addEventListener('pointerdown', event => {
            if (!context.contains(event.target)) closeContext();
        });
        document.addEventListener('focusin', event => {
            if (!context.contains(event.target)) closeContext();
        });
        content.addEventListener('scroll', () => closeContext());
        window.addEventListener('resize', () => closeContext());
        new MutationObserver(() => {
            if (recycleWindow.classList.contains('is-closed') || recycleWindow.classList.contains('is-minimized')) closeContext();
        }).observe(recycleWindow, { attributes: true, attributeFilter: ['class'] });
        dialog.querySelector('[data-recycle-dismiss]').addEventListener('click', () => dialog.close('cancel'));
        dialog.querySelector('form').addEventListener('submit', event => {
            if (event.submitter !== confirmButton) return;
            event.preventDefault();
            pendingDeletion.forEach(button => {
                button.parentElement.hidden = true;
                selected.delete(button);
            });
            restored = null;
            anchor = null;
            render();
            dialog.close('confirm');
        });
        dialog.addEventListener('close', () => {
            propertyFile = null;
            pendingDeletion = [];
            render();
            const focus = dialogTarget && !dialogTarget.disabled && !dialogTarget.closest('[hidden]') ? dialogTarget : closeButton;
            focus?.focus({ preventScroll: true });
        });
        manager.addMenuActions({
            'recycle-restore': restoreSelected,
            'recycle-delete': () => confirmDeletion(),
            'recycle-properties': () => showProperties(),
            'recycle-empty': () => confirmDeletion(true),
            'recycle-close': () => entry.hide('is-closed'),
            'recycle-select-all': () => {
                remainingFiles().forEach(button => selected.add(button));
                render();
            },
            'recycle-clear-selection': () => {
                selected.clear();
                restored = null;
                render();
            },
            'recycle-toggle-size': entry.toggleMaximize,
            'recycle-reset': () => resetButton.click(),
            'recycle-info': () => { status.textContent = desktopApi.t().recycleHelp; }
        });
        window.addEventListener('portfolio-language-change', () => {
            closeContext();
            render();
        });
        render();
    };
})();
