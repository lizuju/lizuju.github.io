(() => {
    const desktopApi = window.GavinDesktop;
    const { t } = desktopApi;

    // When the desktop runs inside the 3D monitor, forward input to the parent scene and
    // mirror its audio mute state in the taskbar tray.
    function setupParentEventBridge() {
        const audioToggle = document.querySelector('[data-audio-toggle]');
        const audioToggleIcon = document.querySelector('[data-audio-toggle-icon]');
        if (window.parent === window || desktopApi.isMobileHomepage()) return;

        let muted = false;
        const updateAudioToggle = (nextMuted) => {
            muted = Boolean(nextMuted);
            if (!audioToggle || !audioToggleIcon) return;
            const label = muted ? t().taskbarAudioUnmute : t().taskbarAudioMute;
            audioToggle.hidden = false;
            audioToggle.classList.toggle('is-muted', muted);
            audioToggle.setAttribute('aria-pressed', String(muted));
            audioToggle.setAttribute('aria-label', label);
            audioToggle.setAttribute('title', label);
            audioToggleIcon.setAttribute('src', muted
                ? '../textures/UI/volume_off.svg'
                : '../textures/UI/volume_on.svg');
        };

        audioToggle?.addEventListener('click', () => {
            window.parent.postMessage({
                source: 'gavin-portfolio',
                type: 'audio-mute-toggle'
            }, window.location.origin);
        });

        window.addEventListener('message', (event) => {
            if (
                event.origin !== window.location.origin
                || event.source !== window.parent
                || event.data?.source !== 'gavin-shell'
                || event.data?.type !== 'audio-mute-state'
            ) return;

            updateAudioToggle(event.data.muted);
        });

        window.addEventListener('portfolio-language-change', () => updateAudioToggle(muted));
        window.parent.postMessage({
            source: 'gavin-portfolio',
            type: 'audio-mute-ready'
        }, window.location.origin);

        let pendingMouseMove;
        let animationFrame;
        document.addEventListener('mousemove', (event) => {
            pendingMouseMove = {
                source: 'gavin-portfolio',
                type: 'mousemove',
                clientX: event.clientX,
                clientY: event.clientY
            };
            if (animationFrame) return;
            animationFrame = window.requestAnimationFrame(() => {
                window.parent.postMessage(pendingMouseMove, window.location.origin);
                animationFrame = null;
            });
        });

        ['mousedown', 'mouseup'].forEach((type) => {
            document.addEventListener(type, (event) => {
                window.parent.postMessage({
                    source: 'gavin-portfolio',
                    type,
                    clientX: event.clientX,
                    clientY: event.clientY
                }, window.location.origin);
            });
        });

        ['keydown', 'keyup'].forEach((type) => {
            document.addEventListener(type, (event) => {
                window.parent.postMessage({
                    source: 'gavin-portfolio',
                    type,
                    key: event.key
                }, window.location.origin);
            });
        });
    }

    desktopApi.setupParentEventBridge = setupParentEventBridge;
})();
