import { PreviewZoom } from './preview-zoom.js';
import { ProjectImageCache } from './project-image-cache.js';

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
        const folderSearch = document.querySelector('[data-project-folder-search]');
        const honorsCategory = document.querySelector('[data-honors-category]');
        const folderScroll = projectFolderWindow.querySelector('.project-folder-scroll');
        const folderEmpty = document.querySelector('[data-project-folder-empty]');
        const projectFolderRoot = document.querySelector('[data-project-folder-root]');
        const robomasterFolderView = document.querySelector('[data-robomaster-folder-view]');
        const robomasterFolderButton = document.querySelector('[data-open-robomaster-folder]');
        const musicFolderView = document.querySelector('[data-music-folder-view]');
        const musicVideoButton = document.querySelector('[data-music-video]');
        const papersFolderView = document.querySelector('[data-papers-folder-view]');
        const honorsFolderView = document.querySelector('[data-honors-folder-view]');
        const honorsGrid = document.querySelector('[data-honors-grid]');
        const honorsLoading = document.querySelector('[data-honors-loading]');
        const honorsRetry = document.querySelector('[data-honors-retry]');
        const openHonorsLink = document.querySelector('[data-open-honors]');
        const standaloneHonors = document.body.classList.contains('standalone-honors');
        const honorsAssetRoot = new URL('assets/honors/', new URL(document.body.dataset.assetRoot || './', document.baseURI));
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
        const imagePrevious = imagePreviewWindow.querySelector('[data-image-previous]');
        const imageNext = imagePreviewWindow.querySelector('[data-image-next]');
        const imageCounter = imagePreviewWindow.querySelector('[data-image-counter]');
        const imageShare = imagePreviewWindow.querySelector('[data-image-share]');
        const imageShareUrl = imagePreviewWindow.querySelector('[data-image-share-url]');
        const imageError = imagePreviewWindow.querySelector('[data-image-error]');
        const imageLoading = imagePreviewWindow.querySelector('[data-image-loading]');
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
        let previewImageButton;
        let imageRequest = 0;
        let imagePreloadTimer;
        const compactImageCache = window.matchMedia('(max-width: 600px), (pointer: coarse)').matches;
        const imageCache = new ProjectImageCache({
            maxBytes: (compactImageCache ? 24 : 48) * 1024 * 1024,
            maxEntries: compactImageCache ? 4 : 6
        });
        let selectedPaperButton = paperButtons[0];
        let previewPaperButton;
        let pendingPaperScrollTop;
        let pendingFolderScrollTop;
        const robomasterImageButtons = Array.from(document.querySelectorAll('[data-robomaster-image]'));
        const imageButtons = [...robomasterImageButtons];
        let previewImages = robomasterImageButtons;
        const folderItems = { root: folderButtons, photos: robomasterImageButtons, music: [musicVideoButton], papers: paperButtons, honors: [] };
        let honorsRequest;
        let pendingImageRestore;
        let sharedCertificate = standaloneHonors ? new URLSearchParams(location.search).get('certificate') : null;
        let videoPosition = 0;
        try {
            const saved = Number(localStorage.getItem('portfolio-music-position'));
            if (Number.isFinite(saved) && saved > 0) videoPosition = saved;
        } catch {}
        const saveVideoPosition = () => {
            if (!video.readyState) return;
            videoPosition = video.ended ? 0 : video.currentTime;
            try { localStorage.setItem('portfolio-music-position', String(videoPosition)); } catch {}
        };

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
        video.addEventListener('loadedmetadata', layoutVideo);
        video.addEventListener('loadedmetadata', () => {
            if (videoPosition > 0 && videoPosition < video.duration) video.currentTime = videoPosition;
        });
        for (const event of ['pause', 'seeked', 'ended']) video.addEventListener(event, saveVideoPosition);
        window.addEventListener('pagehide', saveVideoPosition);
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
            show: () => {
                manager.showWindow(projectFolderWindow, projectFolderTask, { revealTask: true });
                if (pendingFolderScrollTop !== undefined && (currentFolder !== 'honors' || folderItems.honors.length)) {
                    folderScroll.scrollTop = pendingFolderScrollTop;
                    pendingFolderScrollTop = undefined;
                }
            },
            hide: (state) => {
                pendingFolderScrollTop = folderScroll.scrollTop;
                manager.hideWindow(projectFolderWindow, projectFolderTask, state, { hideTask: state === 'is-closed' });
            },
            focusTarget: () => (
                ['photos', 'honors'].includes(currentFolder) && manager.isFocusable(selectedImageButton)
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
            hide: (state) => {
                manager.hideWindow(imagePreviewWindow, imagePreviewTask, state, { hideTask: state === 'is-closed' });
                if (standaloneHonors && state === 'is-closed') {
                    const url = new URL(location.href);
                    url.searchParams.delete('certificate');
                    history.replaceState(null, '', url);
                }
            },
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
                if (video.paused && videoPosition > 0 && videoPosition < video.duration) video.currentTime = videoPosition;
            },
            hide: (state) => {
                saveVideoPosition();
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
            paperPreviewPages.querySelectorAll('[data-paper-retry]').forEach(button => {
                button.textContent = copy.paperPreviewRetry;
                button.previousElementSibling.textContent = copy.paperPreviewFailed;
            });
        };

        const retryPaperPage = image => {
            image.parentElement.classList.remove('has-error');
            image.nextElementSibling.hidden = true;
            const src = image.getAttribute('src');
            image.removeAttribute('src');
            image.src = src;
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
                    const error = document.createElement('div');
                    error.className = 'paper-preview-error';
                    error.hidden = true;
                    const notice = document.createElement('p');
                    const retry = document.createElement('button');
                    retry.type = 'button';
                    retry.className = 'folder-up-button';
                    retry.dataset.paperRetry = '';
                    retry.addEventListener('click', () => retryPaperPage(image));
                    error.append(notice, retry);
                    image.addEventListener('error', () => { figure.classList.add('has-error'); error.hidden = false; });
                    image.addEventListener('load', () => { figure.classList.remove('has-error'); error.hidden = true; });
                    image.src = `${button.dataset.paperPreview}/page-${String(index + 1).padStart(2, '0')}.webp`;
                    const caption = document.createElement('figcaption');
                    caption.textContent = `${index + 1} / ${count}`;
                    figure.append(image, error, caption);
                    return figure;
                }));
                paperZoom.reset();
                paperPreviewPages.scrollLeft = 0;
            } else {
                paperPreviewPages.querySelectorAll('.has-error img').forEach(retryPaperPage);
            }
            updatePaperCopy();
        };

        const selectPaper = (button) => {
            selectedPaperButton = button;
            paperButtons.forEach((candidate) => candidate.classList.toggle('is-selected', candidate === button));
        };

        const openPaperPreview = (button) => {
            selectPaper(button);
            updatePaperPreview(button);
            paperEntry.show();
        };

        const getPhotoCopy = (button, key) => {
            const suffix = document.documentElement.lang === 'en' ? 'En' : 'Zh';
            return button.dataset[`${key}${suffix}`] || '';
        };

        const selectPhoto = (button) => {
            selectedImageButton = button;
            imageButtons.forEach((candidate) => {
                candidate.classList.toggle('is-selected', candidate === button);
            });
        };

        const selectAllFolderItems = () => {
            if (['photos', 'honors'].includes(currentFolder)) {
                folderItems[currentFolder].filter(button => !button.hidden).forEach((button) => button.classList.add('is-selected'));
                selectedImageButton = folderItems[currentFolder].find(button => !button.hidden);
                return;
            }
            folderItems[currentFolder].filter(button => !button.hidden).forEach(button => button.classList.add('is-selected'));
        };

        const clearFolderSelection = () => {
            folderButtons.forEach((button) => button.classList.remove('is-selected'));
            musicVideoButton.classList.remove('is-selected');
            paperButtons.forEach((button) => button.classList.remove('is-selected'));
            imageButtons.forEach((button) => button.classList.remove('is-selected'));
            selectedImageButton = undefined;
            selectedPaperButton = undefined;
        };

        const getPhotoColumnCount = (buttons) => {
            if (!buttons.length) return 1;

            const firstRowTop = buttons[0].offsetTop;
            const nextRowIndex = buttons.findIndex((button, index) => (
                index > 0 && button.offsetTop !== firstRowTop
            ));
            return nextRowIndex === -1 ? buttons.length : nextRowIndex;
        };

        const getPhotoNavigationTarget = (key, selected = selectedImageButton) => {
            const buttons = folderItems[currentFolder].filter(button => !button.hidden);
            if (!buttons.length) return null;
            if (!selected) return buttons[0];

            const currentIndex = buttons.indexOf(selected);
            const columnCount = getPhotoColumnCount(buttons);
            if (currentIndex < 0) return buttons[0];

            if (key === 'ArrowLeft') {
                return currentIndex % columnCount === 0
                    ? selected
                    : buttons[currentIndex - 1];
            }
            if (key === 'ArrowRight') {
                return currentIndex % columnCount === columnCount - 1
                    || currentIndex === buttons.length - 1
                    ? selected
                    : buttons[currentIndex + 1];
            }
            if (key === 'ArrowUp') {
                return currentIndex < columnCount
                    ? selected
                    : buttons[currentIndex - columnCount];
            }
            if (key === 'ArrowDown') {
                return currentIndex + columnCount >= buttons.length
                    ? selected
                    : buttons[currentIndex + columnCount];
            }
            return null;
        };

        const updateImageCopy = () => {
            const copy = t();
            imageShare.hidden = !previewImageButton?.hasAttribute('data-honor-image');
            imageShare.textContent = copy.honorsCopyLink;
            if (!previewImageButton) {
                imagePreviewTitle.textContent = copy.previewWindowTitle;
                imagePreviewTaskTitle.textContent = copy.previewTaskTitle;
                imagePreviewStatus.textContent = copy.previewStatus;
                return;
            }

            const label = getPhotoCopy(previewImageButton, 'photoLabel');
            imagePreviewTitle.textContent = `${copy.previewWindowTitle} - ${label}`;
            imagePreviewTaskTitle.textContent = `${copy.previewTaskTitle}: ${label}`;
            imagePreviewCaption.textContent = label;
            imagePreviewStatus.textContent = copy[previewImageButton.hasAttribute('data-honor-image') ? 'previewWebpType' : 'previewImageType'];
            imagePreviewImage.alt = getPhotoCopy(previewImageButton, 'photoAlt');
            const index = previewImages.indexOf(previewImageButton);
            imageCounter.textContent = `${index + 1} / ${previewImages.length}`;
            imagePrevious.disabled = index <= 0;
            imageNext.disabled = index >= previewImages.length - 1;
        };

        const updatePhotoCopy = () => {
            const copy = t();
            imageButtons.forEach((button) => {
                const label = getPhotoCopy(button, 'photoLabel');
                button.querySelector('[data-photo-label]').textContent = label;
                button.querySelector('[data-photo-type]').textContent = copy[button.hasAttribute('data-honor-image') ? 'previewWebpType' : 'previewImageType'];
                button.querySelector('img').alt = getPhotoCopy(button, 'photoAlt');
                button.title = label;
            });
            updateImageCopy();
        };

        const filterFolder = () => {
            const query = folderSearch.value.trim().toLocaleLowerCase();
            const items = folderItems[currentFolder];
            for (const button of items) {
                const name = button.querySelector('strong');
                const translations = name.dataset.i18n ? Object.values(window.PORTFOLIO_DATA.CONTENT).map(copy => copy[name.dataset.i18n]) : [];
                const names = [name.textContent, button.dataset.photoLabelZh, button.dataset.photoLabelEn, ...translations];
                button.hidden = (currentFolder === 'honors' && !!honorsCategory.value && button.dataset.honorCategory !== honorsCategory.value)
                    || !!query && !names.some(name => name?.toLocaleLowerCase().includes(query));
            }
            folderEmpty.hidden = currentFolder === 'honors' && !folderItems.honors.length || items.some(button => !button.hidden);
            const count = items.filter(button => !button.hidden).length;
            projectFolderStatus.textContent = t()[query || currentFolder === 'honors' && honorsCategory.value ? 'folderSearchCount' : 'folderObjectCount']
                .replace('{count}', count).replace('{total}', items.length);
            folderSearch.setAttribute('aria-label', t().folderSearch);
            if (selectedFolderButton?.hidden) selectedFolderButton = folderButtons.find(button => !button.hidden);
            if (currentFolder === 'papers' && (!selectedPaperButton || selectedPaperButton.hidden)) selectPaper(paperButtons.find(button => !button.hidden));
            if (['photos', 'honors'].includes(currentFolder) && (!items.includes(selectedImageButton) || selectedImageButton.hidden)) {
                selectPhoto(items.find(button => !button.hidden));
            }
        };
        const setProjectFolderView = (folder) => {
            if (standaloneHonors) folder = 'honors';
            if (folder !== currentFolder) {
                pendingImageRestore = undefined;
                folderSearch.value = '';
                folderScroll.scrollTop = 0;
                pendingFolderScrollTop = 0;
            }
            currentFolder = folder;
            const copy = t();
            projectFolderRoot.hidden = folder !== 'root';
            robomasterFolderView.hidden = folder !== 'photos';
            musicFolderView.hidden = folder !== 'music';
            papersFolderView.hidden = folder !== 'papers';
            honorsFolderView.hidden = folder !== 'honors';
            honorsCategory.hidden = folder !== 'honors';
            projectFolderBack.hidden = folder === 'root';
            if (openHonorsLink) openHonorsLink.hidden = folder !== 'honors' || standaloneHonors;
            if (folder !== 'root') selectedFolderButton = folderButtons.find((button) => button.dataset.folder === folder);
            const prefix = folder === 'photos' ? 'folderPhoto' : folder === 'music' ? 'folderMusic'
                : folder === 'papers' ? 'folderPapers' : folder === 'honors' ? 'folderHonors' : 'folder';
            projectFolderTitle.textContent = copy[`${prefix}WindowTitle`];
            projectFolderAddress.textContent = copy[`${prefix}Address`];
            projectFolderStatus.textContent = copy[`${prefix}Status`];

            if (folder === 'photos') {
                document.querySelectorAll('[data-robomaster-thumbnail]').forEach((thumbnail) => {
                    if (!thumbnail.getAttribute('src')) thumbnail.src = thumbnail.dataset.thumbnailSrc;
                });
            } else if (folder === 'honors') {
                honorsLoading.querySelector('span').textContent = copy[honorsRetry.hidden ? 'folderHonorsLoading' : 'folderHonorsFailed'];
                loadHonors();
            } else if (folder === 'music') {
                const thumbnail = musicVideoButton.querySelector('[data-music-thumbnail]');
                if (!thumbnail.getAttribute('src')) thumbnail.src = thumbnail.dataset.thumbnailSrc;
            }

            updatePhotoCopy();
            filterFolder();
        };

        const openRoboMasterFolder = () => {
            setProjectFolderView('photos');
            folderEntry.show();
        };

        const adjacentImageSources = () => {
            const index = previewImages.indexOf(previewImageButton);
            return previewImages.slice(Math.max(0, index - 1), index + 2)
                .map(button => button.dataset.imageSrc.replace(/\.jpg$/i, '.webp'));
        };
        const preloadAdjacentImages = async (request) => {
            const currentSource = previewImageButton.dataset.imageSrc.replace(/\.jpg$/i, '.webp');
            for (const source of adjacentImageSources()) {
                if (request !== imageRequest) return;
                if (source === currentSource) continue;
                const button = previewImages.find(item => item.dataset.imageSrc.replace(/\.jpg$/i, '.webp') === source);
                try { await imageCache.get(source, { priority: 'low', width: Number(button?.dataset.imageWidth) || 0, height: Number(button?.dataset.imageHeight) || 0 }); } catch {}
            }
        };
        const updateImagePreview = async (button) => {
            const changed = imagePreviewImage.getAttribute('src') !== button.dataset.imageSrc;
            if (!button.hidden) selectPhoto(button);
            previewImageButton = button;
            imageShareUrl.hidden = true;
            if (button.hasAttribute('data-honor-image')) {
                const url = new URL('/honors/', location.origin);
                url.searchParams.set('certificate', button.dataset.honorImage);
                imageShareUrl.value = url.href;
                if (standaloneHonors && new URLSearchParams(location.search).has('certificate')) history.replaceState(null, '', url);
            }
            updateImageCopy();
            if (!changed && imageError.hidden) return;
            const request = ++imageRequest;
            clearTimeout(imagePreloadTimer);
            imageError.hidden = true;
            imagePreviewFigure.hidden = false;
            imageLoading.hidden = false;
            imagePreviewBody.classList.add('is-image-pending');
            imagePreviewBody.setAttribute('aria-busy', 'true');
            const source = button.dataset.imageSrc.replace(/\.jpg$/i, '.webp');
            const cached = imageCache.peek(source);
            const thumbnail = button.querySelector('img');
            const placeholder = thumbnail.currentSrc || thumbnail.getAttribute('src') || thumbnail.dataset.thumbnailSrc;
            imagePreviewSource.srcset = cached?.url || placeholder;
            imagePreviewImage.decoding = 'async';
            imagePreviewImage.fetchPriority = 'high';
            imagePreviewImage.src = button.dataset.imageSrc;
            imageCache.cancelPending(source);
            imageCache.setActive(source);
            const initialDecode = imagePreviewImage.decode();
            if (!cached) {
                initialDecode.then(() => {
                    if (request !== imageRequest || imagePreviewSource.getAttribute('srcset') !== placeholder) return;
                    layoutImage();
                    imagePreviewBody.classList.remove('is-image-pending');
                }).catch(() => {});
            }
            if (changed) {
                imageZoom.reset();
                imagePreviewBody.scrollTop = 0;
                imagePreviewBody.scrollLeft = 0;
            }
            try {
                const fullImage = cached || await imageCache.get(source);
                if (request !== imageRequest) return;
                if (cached) await initialDecode;
                else {
                    imagePreviewSource.srcset = fullImage.url;
                    await imagePreviewImage.decode();
                }
                if (request !== imageRequest) return;
                imageLoading.hidden = true;
                layoutImage();
                imagePreloadTimer = setTimeout(() => preloadAdjacentImages(request), 250);
            } catch {
                if (request !== imageRequest) return;
                imageLoading.hidden = true;
                imagePreviewFigure.hidden = true;
                imageError.hidden = false;
            }
            imagePreviewBody.classList.remove('is-image-pending');
            imagePreviewBody.setAttribute('aria-busy', 'false');
        };
        window.addEventListener('pagehide', (event) => {
            clearTimeout(imagePreloadTimer);
            if (!event.persisted) {
                imageRequest++;
                imageCache.clear();
            }
        });

        const openImagePreview = (button) => {
            pendingImageRestore = undefined;
            const items = button.hasAttribute('data-honor-image') ? folderItems.honors : robomasterImageButtons;
            previewImages = items.filter(candidate => !candidate.hidden);
            if (!previewImages.includes(button)) previewImages = items;
            updateImagePreview(button);
            previewEntry.show();
        };
        const movePreview = (direction) => {
            const button = previewImages[previewImages.indexOf(previewImageButton) + direction];
            if (button) updateImagePreview(button);
        };
        imagePrevious.addEventListener('click', () => movePreview(-1));
        imageNext.addEventListener('click', () => movePreview(1));
        imageShare.addEventListener('click', async () => {
            const url = imageShareUrl.value;
            try {
                await navigator.clipboard.writeText(url);
                if (url === imageShareUrl.value) imageShare.textContent = t().honorsLinkCopied;
            } catch {
                if (url !== imageShareUrl.value) return;
                imageShare.textContent = t().honorsCopyManually;
                imageShareUrl.hidden = false;
                imageShareUrl.focus();
                imageShareUrl.select();
            }
        });
        imageError.querySelector('button').addEventListener('click', () => updateImagePreview(previewImageButton));

        const restoreImages = (savedState) => {
            previewImages = savedState.previewImageIndices?.map(index => imageButtons[index]).filter(Boolean) || robomasterImageButtons;
            const previewImage = imageButtons[savedState.previewImageIndex];
            if (previewImage) updateImagePreview(previewImage);
            selectPhoto(imageButtons[savedState.selectedImageIndex]);
            filterFolder();
            if (pendingFolderScrollTop !== undefined && manager.isWindowVisible(projectFolderWindow)) {
                folderScroll.scrollTop = pendingFolderScrollTop;
                pendingFolderScrollTop = undefined;
            }
        };

        const loadHonors = () => {
            if (honorsRequest) return honorsRequest;
            honorsRetry.hidden = true;
            honorsLoading.querySelector('span').textContent = t().folderHonorsLoading;
            honorsRequest = fetch(new URL('certificates.json', honorsAssetRoot)).then(response => {
                if (!response.ok) throw new Error('Certificates could not be loaded');
                return response.json();
            }).then(certificates => {
                folderItems.honors = certificates.map(certificate => {
                    const button = document.createElement('button');
                    button.type = 'button';
                    button.className = 'project-folder-item project-folder-item--button project-folder-item--image';
                    Object.assign(button.dataset, {
                        honorImage: certificate.id,
                        honorCategory: certificate.category,
                        imageWidth: certificate.width,
                        imageHeight: certificate.height,
                        imageSrc: new URL(encodeURIComponent(certificate.image), honorsAssetRoot).href,
                        photoLabelZh: certificate.nameZh,
                        photoLabelEn: certificate.nameEn,
                        photoAltZh: certificate.nameZh,
                        photoAltEn: certificate.nameEn
                    });
                    const icon = document.createElement('span');
                    icon.className = 'photo-file-icon';
                    const thumbnail = document.createElement('img');
                    thumbnail.loading = 'lazy';
                    thumbnail.decoding = 'async';
                    thumbnail.width = certificate.width;
                    thumbnail.height = certificate.height;
                    thumbnail.src = new URL(encodeURIComponent(certificate.thumbnail), honorsAssetRoot).href;
                    icon.append(thumbnail);
                    const label = document.createElement('strong');
                    label.dataset.photoLabel = '';
                    const type = document.createElement('small');
                    type.dataset.photoType = '';
                    button.append(icon, label, type);
                    button.addEventListener('focus', () => selectPhoto(button));
                    button.addEventListener('click', () => openImagePreview(button));
                    return button;
                });
                imageButtons.push(...folderItems.honors);
                honorsGrid.replaceChildren(...folderItems.honors);
                honorsLoading.hidden = true;
                updatePhotoCopy();
                filterFolder();
                if (pendingImageRestore) {
                    restoreImages(pendingImageRestore);
                    pendingImageRestore = undefined;
                }
                if (sharedCertificate) {
                    const button = folderItems.honors.find(item => item.dataset.honorImage === sharedCertificate);
                    sharedCertificate = null;
                    if (button) openImagePreview(button);
                    else projectFolderStatus.textContent = t().honorsNotFound;
                }
            }).catch(() => {
                honorsRequest = null;
                honorsLoading.querySelector('span').textContent = t().folderHonorsFailed;
                honorsRetry.hidden = false;
            });
            return honorsRequest;
        };
        honorsRetry.addEventListener('click', loadHonors);

        const openProjectFolder = () => {
            setProjectFolderView('root');
            folderEntry.show();
        };

        const openSelectedFolderItem = () => {
            if (!folderItems[currentFolder].some(button => !button.hidden)) return;
            if (currentFolder === 'root') {
                setProjectFolderView((selectedFolderButton || folderButtons.find(button => !button.hidden)).dataset.folder);
                folderEntry.show();
                return;
            }
            if (currentFolder === 'music') videoEntry.show();
            else if (currentFolder === 'papers') openPaperPreview(selectedPaperButton || paperButtons.find(button => !button.hidden));
            else openImagePreview(folderItems[currentFolder].includes(selectedImageButton) && !selectedImageButton.hidden
                ? selectedImageButton : folderItems[currentFolder].find(button => !button.hidden));
        };

        manager.addMenuActions({
            'portfolio-project-files': openProjectFolder,
            'portfolio-robomaster': openRoboMasterFolder,
            'folder-open': openSelectedFolderItem,
            'folder-up': () => {
                setProjectFolderView('root');
                selectedFolderButton?.focus({ preventScroll: true });
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
        folderSearch.addEventListener('input', () => {
            pendingFolderScrollTop = undefined;
            filterFolder();
        });
        honorsCategory.addEventListener('change', () => {
            pendingFolderScrollTop = undefined;
            folderScroll.scrollTop = 0;
            filterFolder();
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
            selectedFolderButton?.focus({ preventScroll: true });
        });
        musicVideoButton.addEventListener('click', () => {
            musicVideoButton.classList.add('is-selected');
            videoEntry.show();
        });
        paperButtons.forEach((button) => {
            button.addEventListener('focus', () => selectPaper(button));
            button.addEventListener('click', () => openPaperPreview(button));
        });
        new MutationObserver(() => {
            if (videoPreviewWindow.inert) video.pause();
        }).observe(videoPreviewWindow, { attributes: true, attributeFilter: ['inert'] });
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) video.pause();
        });
        robomasterImageButtons.forEach((button) => {
            button.addEventListener('focus', () => selectPhoto(button));
            button.addEventListener('click', () => openImagePreview(button));
        });

        // Arrow keys move through the photo grid; Enter opens the selected photo. In the preview
        // window the arrows switch photos instead.
        document.addEventListener('keydown', (event) => {
            if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter'].includes(event.key)) {
                return;
            }
            if (event.target instanceof HTMLElement && event.target.matches('input, textarea, select, [contenteditable="true"]')) {
                return;
            }

            const previewActive = manager.isWindowVisible(imagePreviewWindow)
                && imagePreviewWindow.classList.contains('is-active');
            const folderActive = ['photos', 'honors'].includes(currentFolder) && manager.isWindowVisible(projectFolderWindow)
                && projectFolderWindow.classList.contains('is-active');
            if (!previewActive && !folderActive) return;
            if (previewActive && !imagePreviewWindow.contains(event.target) && event.target !== document.body) return;
            if (folderActive && !event.target.closest('[data-robomaster-image], [data-honor-image]')) return;

            if (event.key === 'Enter') {
                if (previewActive || !selectedImageButton) return;
                event.preventDefault();
                openImagePreview(selectedImageButton);
                return;
            }

            if (previewActive) {
                event.preventDefault();
                movePreview(['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1);
                return;
            }
            const targetPhoto = getPhotoNavigationTarget(event.key);
            if (!targetPhoto) return;
            event.preventDefault();

            selectPhoto(targetPhoto);
            targetPhoto.focus({ preventScroll: true });
            targetPhoto.scrollIntoView({ block: 'nearest', inline: 'nearest' });
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
                folderSearch: folderSearch.value,
                honorsCategory: honorsCategory.value,
                folderScrollTop: pendingFolderScrollTop ?? folderScroll.scrollTop,
                selectedFolderIndex: folderButtons.indexOf(selectedFolderButton),
                selectedPaperIndex: paperButtons.indexOf(selectedPaperButton),
                previewPaperIndex: paperButtons.indexOf(previewPaperButton),
                paperScrollTop: pendingPaperScrollTop ?? paperPreviewPages.scrollTop,
                selectedImageIndex: pendingImageRestore?.selectedImageIndex ?? (selectedImageButton ? imageButtons.indexOf(selectedImageButton) : null),
                previewImageIndex: pendingImageRestore?.previewImageIndex ?? (previewImageButton ? imageButtons.indexOf(previewImageButton) : null),
                previewImageIndices: pendingImageRestore?.previewImageIndices ?? previewImages.map(button => imageButtons.indexOf(button))
            }),
            restore: (savedState) => {
                setProjectFolderView(savedState.folderView || 'root');
                folderSearch.value = savedState.folderSearch || '';
                honorsCategory.value = savedState.honorsCategory || '';
                selectedFolderButton = folderButtons[savedState.selectedFolderIndex] || selectedFolderButton;
                selectPaper(paperButtons[savedState.selectedPaperIndex]);
                filterFolder();
                pendingFolderScrollTop = savedState.folderScrollTop || 0;
                const needsHonors = currentFolder === 'honors'
                    || [savedState.selectedImageIndex, savedState.previewImageIndex, ...(savedState.previewImageIndices || [])]
                        .some(index => index >= robomasterImageButtons.length);
                if (needsHonors && !folderItems.honors.length) {
                    pendingImageRestore = savedState;
                    loadHonors();
                } else restoreImages(savedState);
                if (manager.isWindowVisible(videoPreviewWindow)) loadVideo();
                if (!paperPreviewWindow.classList.contains('is-closed')) {
                    updatePaperPreview(paperButtons[savedState.previewPaperIndex] || selectedPaperButton || paperButtons[0]);
                    if (manager.isWindowVisible(paperPreviewWindow)) {
                        paperPreviewPages.scrollTop = savedState.paperScrollTop || 0;
                        pendingPaperScrollTop = undefined;
                    } else pendingPaperScrollTop = savedState.paperScrollTop || 0;
                }
            }
        });

        return {
            open: openProjectFolder,
            showHonors: () => {
                setProjectFolderView('honors');
                folderEntry.show();
            }
        };
    }

    desktopApi.apps.projectFolder = setupProjectFolder;
})();
