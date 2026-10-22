(() => {
    const desktopApi = window.GavinDesktop;
    const { t } = desktopApi;

    // Project folders and their image and video preview windows.
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
        const musicFolderView = document.querySelector('[data-music-folder-view]');
        const musicVideoButton = document.querySelector('[data-music-video]');
        const folderButtons = Array.from(projectFolderRoot.querySelectorAll('[data-folder]'));
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
        const videoPreviewWindow = document.querySelector('[data-video-preview-window]');
        const videoPreviewTask = document.querySelector('[data-video-preview-task]');
        const video = document.querySelector('[data-music-player]');
        if (!projectFolderWindow || !projectFolderTitlebar || !projectFolderResizeHandle || !projectFolderTask
            || !projectFolderTitle || !projectFolderAddress || !projectFolderStatus || !projectFolderRoot
            || !robomasterFolderView || !robomasterFolderButton || !projectFolderBack || !imagePreviewWindow
            || !imagePreviewTitle || !imagePreviewImage || !imagePreviewCaption || !imagePreviewStatus
            || !imagePreviewTitlebar || !imagePreviewResizeHandle || !imagePreviewTask
            || !imagePreviewTaskTitle) return null;

        let currentFolder = 'root';
        let selectedFolderButton = robomasterFolderButton;
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
                currentFolder === 'photos' && manager.isFocusable(selectedImageButton)
                    ? selectedImageButton
                    : currentFolder === 'music'
                        ? musicVideoButton
                        : currentFolder === 'root' ? selectedFolderButton : projectFolderBack
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
        const loadVideo = () => {
            if (video.hasAttribute('src')) return;
            video.poster = 'assets/music-portfolio/poster.webp';
            video.preload = 'metadata';
            video.src = video.dataset.videoSrc;
        };
        const videoEntry = manager.registerWindow({
            id: 'video-preview',
            element: videoPreviewWindow,
            task: videoPreviewTask,
            titlebar: document.querySelector('[data-video-preview-drag]'),
            resizeHandle: document.querySelector('[data-video-preview-resize]'),
            actionAttribute: 'data-video-preview-action',
            minWidth: 360,
            minHeight: 300,
            show: () => {
                loadVideo();
                manager.showWindow(videoPreviewWindow, videoPreviewTask, { revealTask: true });
            },
            hide: (state) => {
                video.pause();
                manager.hideWindow(videoPreviewWindow, videoPreviewTask, state, { hideTask: state === 'is-closed' });
            },
            focusTarget: () => video
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
            if (currentFolder === 'photos') {
                robomasterImageButtons.forEach((button) => button.classList.add('is-selected'));
                selectedImageButton = robomasterImageButtons[0];
                return;
            }
            if (currentFolder === 'music') musicVideoButton.classList.add('is-selected');
            else folderButtons.forEach((button) => button.classList.add('is-selected'));
        };

        const clearFolderSelection = () => {
            folderButtons.forEach((button) => button.classList.remove('is-selected'));
            musicVideoButton.classList.remove('is-selected');
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

        const setProjectFolderView = (folder) => {
            currentFolder = folder;
            const copy = t();
            projectFolderRoot.hidden = folder !== 'root';
            robomasterFolderView.hidden = folder !== 'photos';
            musicFolderView.hidden = folder !== 'music';
            projectFolderBack.hidden = folder === 'root';
            const prefix = folder === 'photos' ? 'folderPhoto' : folder === 'music' ? 'folderMusic' : 'folder';
            projectFolderTitle.textContent = copy[`${prefix}WindowTitle`];
            projectFolderAddress.textContent = copy[`${prefix}Address`];
            projectFolderStatus.textContent = copy[`${prefix}Status`];

            if (folder === 'photos') {
                document.querySelectorAll('[data-robomaster-thumbnail]').forEach((thumbnail) => {
                    if (!thumbnail.getAttribute('src')) thumbnail.src = thumbnail.dataset.thumbnailSrc;
                });
            } else if (folder === 'music') {
                const thumbnail = musicVideoButton.querySelector('[data-music-thumbnail]');
                if (!thumbnail.getAttribute('src')) thumbnail.src = thumbnail.dataset.thumbnailSrc;
            }

            updatePhotoCopy();
        };

        const openRoboMasterFolder = () => {
            setProjectFolderView('photos');
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
            setProjectFolderView('root');
            folderEntry.show();
        };

        const openSelectedFolderItem = () => {
            if (currentFolder === 'root') {
                setProjectFolderView(selectedFolderButton.dataset.folder);
                folderEntry.show();
                return;
            }
            if (currentFolder === 'music') videoEntry.show();
            else openImagePreview(selectedImageButton || robomasterImageButtons[0]);
        };

        manager.addMenuActions({
            'portfolio-project-files': openProjectFolder,
            'portfolio-robomaster': openRoboMasterFolder,
            'folder-open': openSelectedFolderItem,
            'folder-up': () => {
                setProjectFolderView('root');
                selectedFolderButton.focus({ preventScroll: true });
            },
            'folder-close': () => folderEntry.hide('is-closed'),
            'folder-select-all': selectAllFolderItems,
            'folder-clear-selection': clearFolderSelection,
            'folder-refresh': () => setProjectFolderView(currentFolder),
            'folder-toggle-size': folderEntry.toggleMaximize,
            'folder-info': () => {
                projectFolderStatus.textContent = t().folderHelpStatus;
            }
        });

        document.querySelectorAll('[data-open-project-folder]').forEach((button) => {
            button.addEventListener('click', openProjectFolder);
        });
        folderButtons.forEach((button) => {
            button.addEventListener('focus', () => { selectedFolderButton = button; });
            button.addEventListener('click', () => {
                setProjectFolderView(button.dataset.folder);
                folderEntry.show();
            });
        });
        projectFolderBack.addEventListener('click', () => {
            setProjectFolderView('root');
            selectedFolderButton.focus({ preventScroll: true });
        });
        musicVideoButton.addEventListener('click', () => {
            musicVideoButton.classList.add('is-selected');
            videoEntry.show();
        });
        new MutationObserver(() => {
            if (videoPreviewWindow.inert) video.pause();
        }).observe(videoPreviewWindow, { attributes: true, attributeFilter: ['inert'] });
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) video.pause();
        });
        robomasterImageButtons.forEach((button) => {
            button.addEventListener('click', () => openImagePreview(button));
        });

        // Arrow keys move through the photo grid; Enter opens the selected photo. In the preview
        // window the arrows switch photos instead.
        document.addEventListener('keydown', (event) => {
            if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
            if (currentFolder !== 'photos' || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter'].includes(event.key)) {
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
            setProjectFolderView(currentFolder);
        });

        manager.onSession({
            save: () => ({
                folderView: currentFolder,
                selectedImageIndex: selectedImageButton ? robomasterImageButtons.indexOf(selectedImageButton) : null
            }),
            restore: (savedState) => {
                setProjectFolderView(savedState.folderView || 'root');
                const selectedImage = robomasterImageButtons[savedState.selectedImageIndex];
                if (selectedImage) updateImagePreview(selectedImage);
                if (manager.isWindowVisible(videoPreviewWindow)) loadVideo();
            }
        });

        return { open: openProjectFolder };
    }

    desktopApi.apps.projectFolder = setupProjectFolder;
})();
