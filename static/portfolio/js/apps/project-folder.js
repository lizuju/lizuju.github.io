(() => {
    const desktopApi = window.GavinDesktop;
    const { t } = desktopApi;

    // Project folder (Explorer) window, the RoboMaster photo folder inside it and the image
    // preview window that photos open in.
    function setupProjectFolder(manager) {
        const projectFolderWindow = document.querySelector('[data-project-folder-window]');
        const projectFolderTitlebar = document.querySelector('[data-project-folder-drag]');
        const projectFolderResizeHandle = document.querySelector('[data-project-folder-resize]');
        const projectFolderTask = document.querySelector('[data-project-folder-task]');
        const projectFolderTitle = document.querySelector('[data-project-folder-window-title]');
        const projectFolderAddress = document.querySelector('[data-project-folder-address]');
        const projectFolderStatus = document.querySelector('[data-project-folder-status]');
        const projectFolderRoot = document.querySelector('[data-project-folder-root]');
        const robomasterFolderView = document.querySelector('[data-robomaster-folder-view]');
        const robomasterFolderButton = document.querySelector('[data-open-robomaster-folder]');
        const projectFolderBack = document.querySelector('[data-project-folder-back]');
        const imagePreviewWindow = document.querySelector('[data-image-preview-window]');
        const imagePreviewTitle = document.querySelector('[data-image-preview-title]');
        const imagePreviewSource = document.querySelector('[data-image-preview-source]');
        const imagePreviewImage = document.querySelector('[data-image-preview-image]');
        const imagePreviewCaption = document.querySelector('[data-image-preview-caption]');
        const imagePreviewStatus = document.querySelector('[data-image-preview-status]');
        const imagePreviewTitlebar = document.querySelector('[data-image-preview-drag]');
        const imagePreviewResizeHandle = document.querySelector('[data-image-preview-resize]');
        const imagePreviewTask = document.querySelector('[data-image-preview-task]');
        const imagePreviewTaskTitle = document.querySelector('[data-image-preview-task-title]');
        if (!projectFolderWindow || !projectFolderTitlebar || !projectFolderResizeHandle || !projectFolderTask
            || !projectFolderTitle || !projectFolderAddress || !projectFolderStatus || !projectFolderRoot
            || !robomasterFolderView || !robomasterFolderButton || !projectFolderBack || !imagePreviewWindow
            || !imagePreviewTitle || !imagePreviewImage || !imagePreviewCaption || !imagePreviewStatus
            || !imagePreviewTitlebar || !imagePreviewResizeHandle || !imagePreviewTask
            || !imagePreviewTaskTitle) return null;

        let robomasterFolderOpen = false;
        let selectedImageButton;
        const robomasterImageButtons = Array.from(document.querySelectorAll('[data-robomaster-image]'));

        const folderEntry = manager.registerWindow({
            id: 'project-folder',
            element: projectFolderWindow,
            task: projectFolderTask,
            titlebar: projectFolderTitlebar,
            resizeHandle: projectFolderResizeHandle,
            actionAttribute: 'data-project-folder-action',
            minWidth: 440,
            minHeight: 320,
            focusTarget: () => (
                manager.isFocusable(selectedImageButton)
                    ? selectedImageButton
                    : projectFolderBack.hidden
                        ? projectFolderWindow.querySelector('[data-open-robomaster-folder]')
                        : projectFolderBack
            )
        });
        const previewEntry = manager.registerWindow({
            id: 'image-preview',
            element: imagePreviewWindow,
            task: imagePreviewTask,
            titlebar: imagePreviewTitlebar,
            resizeHandle: imagePreviewResizeHandle,
            actionAttribute: 'data-image-preview-action',
            minWidth: 380,
            minHeight: 300,
            focusTarget: () => imagePreviewWindow.querySelector('[data-image-preview-action="close"]')
        });

        const getPhotoCopy = (button, key) => {
            const suffix = document.documentElement.lang === 'en' ? 'En' : 'Zh';
            return button.dataset[`${key}${suffix}`] || '';
        };

        const selectPhoto = (button) => {
            if (!button) return;
            selectedImageButton = button;
            robomasterImageButtons.forEach((candidate) => {
                candidate.classList.toggle('is-selected', candidate === button);
            });
        };

        const selectAllFolderItems = () => {
            if (robomasterFolderOpen) {
                robomasterImageButtons.forEach((button) => button.classList.add('is-selected'));
                selectedImageButton = robomasterImageButtons[0];
                return;
            }
            robomasterFolderButton.classList.add('is-selected');
        };

        const clearFolderSelection = () => {
            robomasterFolderButton.classList.remove('is-selected');
            robomasterImageButtons.forEach((button) => button.classList.remove('is-selected'));
            selectedImageButton = undefined;
        };

        const getPhotoColumnCount = () => {
            if (!robomasterImageButtons.length) return 1;

            const firstRowTop = robomasterImageButtons[0].offsetTop;
            const nextRowIndex = robomasterImageButtons.findIndex((button, index) => (
                index > 0 && button.offsetTop !== firstRowTop
            ));
            return nextRowIndex === -1 ? robomasterImageButtons.length : nextRowIndex;
        };

        const getPhotoNavigationTarget = (key) => {
            if (!robomasterImageButtons.length) return null;
            if (!selectedImageButton) return robomasterImageButtons[0];

            const currentIndex = robomasterImageButtons.indexOf(selectedImageButton);
            const columnCount = getPhotoColumnCount();
            if (currentIndex < 0) return robomasterImageButtons[0];

            if (key === 'ArrowLeft') {
                return currentIndex % columnCount === 0
                    ? selectedImageButton
                    : robomasterImageButtons[currentIndex - 1];
            }
            if (key === 'ArrowRight') {
                return currentIndex % columnCount === columnCount - 1
                    || currentIndex === robomasterImageButtons.length - 1
                    ? selectedImageButton
                    : robomasterImageButtons[currentIndex + 1];
            }
            if (key === 'ArrowUp') {
                return currentIndex < columnCount
                    ? selectedImageButton
                    : robomasterImageButtons[currentIndex - columnCount];
            }
            if (key === 'ArrowDown') {
                return currentIndex + columnCount >= robomasterImageButtons.length
                    ? selectedImageButton
                    : robomasterImageButtons[currentIndex + columnCount];
            }
            return null;
        };

        const updatePhotoCopy = () => {
            const copy = t();
            robomasterImageButtons.forEach((button) => {
                const label = getPhotoCopy(button, 'photoLabel');
                const alt = getPhotoCopy(button, 'photoAlt');
                button.querySelector('[data-photo-label]').textContent = label;
                button.querySelector('[data-photo-type]').textContent = copy.previewImageType;
                button.querySelector('[data-robomaster-thumbnail]').alt = alt;
            });

            if (!selectedImageButton) {
                imagePreviewTitle.textContent = copy.previewWindowTitle;
                imagePreviewTaskTitle.textContent = copy.previewTaskTitle;
                imagePreviewStatus.textContent = copy.previewStatus;
                return;
            }

            const label = getPhotoCopy(selectedImageButton, 'photoLabel');
            imagePreviewTitle.textContent = `${copy.previewWindowTitle} - ${label}`;
            imagePreviewTaskTitle.textContent = `${copy.previewTaskTitle}: ${label}`;
            imagePreviewCaption.textContent = label;
            imagePreviewStatus.textContent = copy.previewImageType;
            imagePreviewImage.alt = getPhotoCopy(selectedImageButton, 'photoAlt');
        };

        const setProjectFolderView = (showRoboMaster) => {
            robomasterFolderOpen = showRoboMaster;
            const copy = t();
            projectFolderRoot.hidden = showRoboMaster;
            robomasterFolderView.hidden = !showRoboMaster;
            projectFolderBack.hidden = !showRoboMaster;
            projectFolderTitle.textContent = showRoboMaster ? copy.folderPhotoWindowTitle : copy.folderWindowTitle;
            projectFolderAddress.textContent = showRoboMaster ? copy.folderPhotoAddress : copy.folderAddress;
            projectFolderStatus.textContent = showRoboMaster ? copy.folderPhotoStatus : copy.folderStatus;

            if (showRoboMaster) {
                document.querySelectorAll('[data-robomaster-thumbnail]').forEach((thumbnail) => {
                    if (!thumbnail.getAttribute('src')) thumbnail.src = thumbnail.dataset.thumbnailSrc;
                });
            }

            updatePhotoCopy();
        };

        const openRoboMasterFolder = () => {
            setProjectFolderView(true);
            folderEntry.show();
        };

        const updateImagePreview = (button) => {
            selectPhoto(button);
            imagePreviewSource.srcset = button.dataset.imageSrc.replace(/\.jpg$/i, '.webp');
            imagePreviewImage.decoding = 'async';
            imagePreviewImage.src = button.dataset.imageSrc;
            updatePhotoCopy();
        };

        const openImagePreview = (button) => {
            updateImagePreview(button);
            previewEntry.show();
        };

        const openProjectFolder = () => {
            setProjectFolderView(false);
            folderEntry.show();
        };

        const openSelectedFolderItem = () => {
            if (!robomasterFolderOpen) {
                openRoboMasterFolder();
                return;
            }
            openImagePreview(selectedImageButton || robomasterImageButtons[0]);
        };

        manager.addMenuActions({
            'portfolio-project-files': openProjectFolder,
            'portfolio-robomaster': openRoboMasterFolder,
            'folder-open': openSelectedFolderItem,
            'folder-up': () => setProjectFolderView(false),
            'folder-close': () => folderEntry.hide('is-closed'),
            'folder-select-all': selectAllFolderItems,
            'folder-clear-selection': clearFolderSelection,
            'folder-refresh': () => setProjectFolderView(robomasterFolderOpen),
            'folder-toggle-size': folderEntry.toggleMaximize,
            'folder-info': () => {
                projectFolderStatus.textContent = t().folderHelpStatus;
            }
        });

        document.querySelectorAll('[data-open-project-folder]').forEach((button) => {
            button.addEventListener('click', openProjectFolder);
        });
        robomasterFolderButton.addEventListener('click', openRoboMasterFolder);
        projectFolderBack.addEventListener('click', () => setProjectFolderView(false));
        robomasterImageButtons.forEach((button) => {
            button.addEventListener('click', () => openImagePreview(button));
        });

        // Arrow keys move through the photo grid; Enter opens the selected photo. In the preview
        // window the arrows switch photos instead.
        document.addEventListener('keydown', (event) => {
            if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
            if (!robomasterFolderOpen || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter'].includes(event.key)) {
                return;
            }
            if (event.target instanceof HTMLElement && event.target.matches('input, textarea, select, [contenteditable="true"]')) {
                return;
            }

            const previewActive = manager.isWindowVisible(imagePreviewWindow)
                && imagePreviewWindow.classList.contains('is-active');
            const folderActive = manager.isWindowVisible(projectFolderWindow)
                && projectFolderWindow.classList.contains('is-active');
            if (!previewActive && !folderActive) return;
            if (previewActive && !imagePreviewWindow.contains(event.target)) return;
            if (folderActive && !event.target.closest('[data-robomaster-image]')) return;

            if (event.key === 'Enter') {
                if (previewActive || !selectedImageButton) return;
                event.preventDefault();
                openImagePreview(selectedImageButton);
                return;
            }

            const targetPhoto = getPhotoNavigationTarget(event.key);
            if (!targetPhoto) return;
            event.preventDefault();

            if (previewActive) {
                updateImagePreview(targetPhoto);
                return;
            }

            selectPhoto(targetPhoto);
            targetPhoto.focus({ preventScroll: true });
        });

        window.addEventListener('portfolio-language-change', () => {
            setProjectFolderView(robomasterFolderOpen);
        });

        manager.onSession({
            save: () => ({
                folderOpen: robomasterFolderOpen,
                selectedImageIndex: selectedImageButton ? robomasterImageButtons.indexOf(selectedImageButton) : null
            }),
            restore: (savedState) => {
                setProjectFolderView(Boolean(savedState.folderOpen));
                const selectedImage = robomasterImageButtons[savedState.selectedImageIndex];
                if (selectedImage) updateImagePreview(selectedImage);
            }
        });

        return { open: openProjectFolder };
    }

    desktopApi.apps.projectFolder = setupProjectFolder;
})();
