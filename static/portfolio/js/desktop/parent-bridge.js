(() => {
    const desktopApi = window.GavinDesktop;
    const { t } = desktopApi;

    // The taskbar tray's system mute button. Inside the 3D monitor it mirrors and toggles the
    // scene's mute, and input is forwarded to the parent scene; opened directly, the desktop keeps
    // its own mute state. Every desktop sound follows it (see desktop/sound.js).
    function setupParentEventBridge() {
        const audioToggle = document.querySelector('[data-audio-toggle]');
        const audioToggleIcon = document.querySelector('[data-audio-toggle-icon]');
        if (desktopApi.isMobileHomepage()) return;
        const embedded = window.parent !== window;

        let muted = false;
        desktopApi.isAudioMuted = () => muted;
        const updateAudioToggle = (nextMuted) => {
            const changed = muted !== Boolean(nextMuted);
            muted = Boolean(nextMuted);
            if (changed) window.dispatchEvent(new Event('gavin:audio-mute-change'));
            if (!audioToggle || !audioToggleIcon) return;
            const label = muted ? t().taskbarSoundUnmute : t().taskbarSoundMute;
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
            if (!embedded) {
                updateAudioToggle(!muted);
                return;
            }
            window.parent.postMessage({
                source: 'gavin-portfolio',
                type: 'audio-mute-toggle'
            }, window.location.origin);
        });
        window.addEventListener('portfolio-language-change', () => updateAudioToggle(muted));

        if (!embedded) {
            updateAudioToggle(false);
            return;
        }

        window.addEventListener('message', (event) => {
            if (
                event.origin !== window.location.origin
                || event.source !== window.parent
                || event.data?.source !== 'gavin-shell'
                || event.data?.type !== 'audio-mute-state'
            ) return;

            updateAudioToggle(event.data.muted);
        });

        window.parent.postMessage({
            source: 'gavin-portfolio',
            type: 'audio-mute-ready'
        }, window.location.origin);

        document.addEventListener('focusin', () => {
            window.parent.postMessage({
                source: 'gavin-portfolio',
                type: 'focusin'
            }, window.location.origin);
        });

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
