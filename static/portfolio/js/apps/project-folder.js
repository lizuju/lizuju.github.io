import { PreviewZoom } from './preview-zoom.js';

(() => {
    const desktopApi = window.GavinDesktop;
    const { t } = desktopApi;

    // Project folders and their media preview windows.
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
        const papersFolderView = document.querySelector('[data-papers-folder-view]');
        const paperButtons = Array.from(document.querySelectorAll('[data-modeling-paper]'));
        const paperPreviewWindow = document.querySelector('[data-paper-preview-window]');
        const paperPreviewTask = document.querySelector('[data-paper-preview-task]');
        const paperPreviewTitle = document.querySelector('[data-paper-preview-title]');
        const paperPreviewTaskTitle = document.querySelector('[data-paper-preview-task-title]');
        const paperPreviewPages = document.querySelector('[data-paper-preview-pages]');
        const paperPreviewStatus = document.querySelector('[data-paper-preview-status]');
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
        const imagePreviewBody = imagePreviewWindow.querySelector('.image-preview-body');
        const imagePreviewFigure = imagePreviewWindow.querySelector('figure');
        const videoPreviewWindow = document.querySelector('[data-video-preview-window]');
        const videoPreviewTask = document.querySelector('[data-video-preview-task]');
        const videoPreviewBody = videoPreviewWindow.querySelector('.video-preview-body');
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
        let selectedPaperButton = paperButtons[0];
        let previewPaperButton;
        let pendingPaperScrollTop;
        const robomasterImageButtons = Array.from(document.querySelectorAll('[data-robomaster-image]'));

        const layoutImage = () => {
            if (!imagePreviewBody.clientWidth || !imagePreviewImage.naturalWidth) return;
            const width = Math.max(1, imagePreviewBody.clientWidth - 16);
            const height = Math.max(1, imagePreviewBody.clientHeight - 16 - imagePreviewCaption.offsetHeight);
            const fit = Math.min(width / imagePreviewImage.naturalWidth, height / imagePreviewImage.naturalHeight);
            imagePreviewFigure.style.width = `${imagePreviewImage.naturalWidth * fit * imageZoom.value + 2}px`;
            imagePreviewImage.parentElement.style.height = `${imagePreviewImage.naturalHeight * fit * imageZoom.value}px`;
        };
        const layoutVideo = () => {
            if (!videoPreviewBody.clientWidth) return;
            const width = Math.max(1, videoPreviewBody.clientWidth - 8);
            const height = Math.max(1, videoPreviewBody.clientHeight - 8);
            const mediaWidth = video.videoWidth || 16;
            const mediaHeight = video.videoHeight || 9;
            const fit = Math.min(width / mediaWidth, height / mediaHeight);
            video.style.width = `${mediaWidth * fit * videoZoom.value}px`;
            video.style.height = `${mediaHeight * fit * videoZoom.value}px`;
        };
        const layoutPaper = () => {
            if (!paperPreviewPages.clientWidth) return;
            paperPreviewPages.style.setProperty('--project-paper-width', `${Math.max(1, paperPreviewPages.clientWidth - 32) * paperZoom.value}px`);
        };
        const imageZoom = new PreviewZoom({ toolbar: document.querySelector('[data-image-preview-toolbar]'), onChange: layoutImage });
        const videoZoom = new PreviewZoom({ toolbar: document.querySelector('[data-video-preview-toolbar]'), onChange: layoutVideo });
        const paperZoom = new PreviewZoom({ toolbar: document.querySelector('[data-paper-preview-toolbar]'), onChange: layoutPaper });
        imagePreviewImage.addEventListener('load', layoutImage);
        video.addEventListener('loadedmetadata', layoutVideo);
        new ResizeObserver(layoutImage).observe(imagePreviewBody);
        new ResizeObserver(layoutVideo).observe(videoPreviewBody);
        new ResizeObserver(layoutPaper).observe(paperPreviewPages);

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
                        : currentFolder === 'papers' ? selectedPaperButton
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
                if (state === 'is-closed') {
                    video.removeAttribute('src');
                    video.load();
                }
                manager.hideWindow(videoPreviewWindow, videoPreviewTask, state, { hideTask: state === 'is-closed' });
            },
            focusTarget: () => video
        });
        const paperEntry = manager.registerWindow({
            id: 'paper-preview',
            element: paperPreviewWindow,
            task: paperPreviewTask,
            titlebar: document.querySelector('[data-paper-preview-drag]'),
            resizeHandle: document.querySelector('[data-paper-preview-resize]'),
            actionAttribute: 'data-paper-preview-action',
            minWidth: 440,
            minHeight: 320,
            show: () => {
                manager.showWindow(paperPreviewWindow, paperPreviewTask, { revealTask: true });
                if (pendingPaperScrollTop !== undefined) {
                    paperPreviewPages.scrollTop = pendingPaperScrollTop;
                    pendingPaperScrollTop = undefined;
                }
            },
            hide: (state) => {
                pendingPaperScrollTop = paperPreviewPages.scrollTop;
                manager.hideWindow(paperPreviewWindow, paperPreviewTask, state, { hideTask: state === 'is-closed' });
            },
            focusTarget: () => paperPreviewPages
        });

        const updatePaperCopy = () => {
            if (!previewPaperButton) return;
            const copy = t();
            const name = previewPaperButton.querySelector('strong').textContent;
            const title = `${copy.paperPreviewTitle} - ${name}`;
            paperPreviewTitle.textContent = title;
            paperPreviewTaskTitle.textContent = title;
            paperPreviewPages.setAttribute('aria-label', title);
            paperPreviewStatus.textContent = `${previewPaperButton.dataset.paperPages} ${copy.paperPreviewPages} · ${copy.paperPreviewHint}`;
            paperPreviewPages.querySelectorAll('img').forEach((image, index) => {
                image.alt = `${name} — ${index + 1} / ${previewPaperButton.dataset.paperPages}`;
            });
        };

        const updatePaperPreview = (button) => {
            if (previewPaperButton !== button) {
                previewPaperButton = button;
                pendingPaperScrollTop = 0;
                const count = Number(button.dataset.paperPages);
                paperPreviewPages.replaceChildren(...Array.from({ length: count }, (_, index) => {
                    const figure = document.createElement('figure');
                    figure.className = 'paper-preview-page';
                    const image = document.createElement('img');
                    image.width = 1600;
                    image.height = 2263;
                    image.loading = index === 0 ? 'eager' : 'lazy';
                    image.decoding = 'async';
                    image.src = `${button.dataset.paperPreview}/page-${String(index + 1).padStart(2, '0')}.webp`;
                    const caption = document.createElement('figcaption');
                    caption.textContent = `${index + 1} / ${count}`;
                    figure.append(image, caption);
                    return figure;
                }));
                paperZoom.reset();
                paperPreviewPages.scrollLeft = 0;
            }
            updatePaperCopy();
        };

        const openPaperPreview = (button) => {
            selectedPaperButton = button;
            paperButtons.forEach((candidate) => candidate.classList.toggle('is-selected', candidate === button));
            updatePaperPreview(button);
            paperEntry.show();
        };

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
            else if (currentFolder === 'papers') paperButtons.forEach((button) => button.classList.add('is-selected'));
            else folderButtons.forEach((button) => button.classList.add('is-selected'));
        };

        const clearFolderSelection = () => {
            folderButtons.forEach((button) => button.classList.remove('is-selected'));
            musicVideoButton.classList.remove('is-selected');
            paperButtons.forEach((button) => button.classList.remove('is-selected'));
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
            papersFolderView.hidden = folder !== 'papers';
            projectFolderBack.hidden = folder === 'root';
            if (folder !== 'root') selectedFolderButton = folderButtons.find((button) => button.dataset.folder === folder);
            const prefix = folder === 'photos' ? 'folderPhoto' : folder === 'music' ? 'folderMusic'
                : folder === 'papers' ? 'folderPapers' : 'folder';
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
            const changed = imagePreviewImage.getAttribute('src') !== button.dataset.imageSrc;
            selectPhoto(button);
            imagePreviewSource.srcset = button.dataset.imageSrc.replace(/\.jpg$/i, '.webp');
            imagePreviewImage.decoding = 'async';
            imagePreviewImage.src = button.dataset.imageSrc;
            updatePhotoCopy();
            if (changed) {
                imageZoom.reset();
                imagePreviewBody.scrollTop = 0;
                imagePreviewBody.scrollLeft = 0;
            }
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
            else if (currentFolder === 'papers') openPaperPreview(selectedPaperButton);
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
        paperButtons.forEach((button) => {
            button.addEventListener('focus', () => { selectedPaperButton = button; });
            button.addEventListener('click', () => openPaperPreview(button));
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
            updatePaperCopy();
            [imagePreviewWindow, videoPreviewWindow, paperPreviewWindow].forEach((previewWindow) => {
                previewWindow.querySelectorAll('[data-i18n-aria]').forEach((element) => {
                    element.setAttribute('aria-label', t()[element.dataset.i18nAria]);
                });
            });
        });

        manager.onSession({
            save: () => ({
                folderView: currentFolder,
                selectedPaperIndex: paperButtons.indexOf(selectedPaperButton),
                previewPaperIndex: paperButtons.indexOf(previewPaperButton),
                paperScrollTop: pendingPaperScrollTop ?? paperPreviewPages.scrollTop,
                selectedImageIndex: selectedImageButton ? robomasterImageButtons.indexOf(selectedImageButton) : null
            }),
            restore: (savedState) => {
                selectedPaperButton = paperButtons[savedState.selectedPaperIndex] || paperButtons[0];
                setProjectFolderView(savedState.folderView || 'root');
                const selectedImage = robomasterImageButtons[savedState.selectedImageIndex];
                if (selectedImage) updateImagePreview(selectedImage);
                if (manager.isWindowVisible(videoPreviewWindow)) loadVideo();
                if (!paperPreviewWindow.classList.contains('is-closed')) {
                    updatePaperPreview(paperButtons[savedState.previewPaperIndex] || selectedPaperButton);
                    if (manager.isWindowVisible(paperPreviewWindow)) {
                        paperPreviewPages.scrollTop = savedState.paperScrollTop || 0;
                        pendingPaperScrollTop = undefined;
                    } else pendingPaperScrollTop = savedState.paperScrollTop || 0;
                }
            }
        });

        return { open: openProjectFolder };
    }

    desktopApi.apps.projectFolder = setupProjectFolder;
})();
