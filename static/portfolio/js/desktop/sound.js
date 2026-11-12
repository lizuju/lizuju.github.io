(() => {
    const desktopApi = window.GavinDesktop;
    // The system mute (taskbar button or the 3D scene) silences the sound of every app.
    const isMuted = () => Boolean(desktopApi.isAudioMuted?.());

    // Every <audio>/<video> that plays on the desktop is silenced while the system is muted. It
    // keeps playing at the volume the person chose, and only an element muted here is unmuted again.
    const mediaElements = new Set();
    const mutedHere = new WeakSet();
    const applyMedia = (element) => {
        if (isMuted()) {
            if (!element.muted) {
                element.muted = true;
                mutedHere.add(element);
            }
        } else if (mutedHere.has(element)) {
            mutedHere.delete(element);
            element.muted = false;
        }
    };
    const trackMedia = (element) => {
        if (!(element instanceof HTMLMediaElement)) return;
        if (![...mediaElements].some((reference) => reference.deref() === element)) {
            mediaElements.add(new WeakRef(element));
            // Unmuting from the player's own controls does not override the system mute.
            element.addEventListener('volumechange', () => {
                if (isMuted() && !element.muted) applyMedia(element);
            });
        }
        applyMedia(element);
    };
    document.addEventListener('play', (event) => trackMedia(event.target), true);

    window.addEventListener('gavin:audio-mute-change', () => {
        for (const reference of mediaElements) {
            const element = reference.deref();
            if (element) applyMedia(element);
            else mediaElements.delete(reference);
        }
    });

    desktopApi.sound = { isMuted };
})();
