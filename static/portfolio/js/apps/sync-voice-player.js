const cachedPlayers = new Map();

export function createVoicePlayer({ durationMs, load, canPlay, onStart, onError, translate }) {
    const element = document.createElement('div');
    element.className = 'sync-voice-message';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sync-button';
    button.dataset.syncVoicePlay = '';
    const duration = document.createElement('span');
    duration.className = 'sync-voice-duration';
    const seconds = Math.ceil(durationMs / 1000);
    duration.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.preload = 'auto';
    audio.setAttribute('playsinline', '');
    audio.hidden = true;
    element.append(button, duration, audio);
    let capability = null;
    let controller = null;
    let objectUrl = null;
    let version = 0;
    let disposed = false;
    let loading = false;
    let autoplay = false;

    const updateLanguage = () => {
        const label = translate('syncVoiceMessage');
        element.setAttribute('aria-label', `${label} ${duration.textContent}`);
        audio.setAttribute('aria-label', label);
        button.textContent = translate(loading ? 'syncVoiceLoading' : 'syncVoicePlay');
        button.title = translate(element.dataset.state === 'failed' ? 'syncVoicePlaybackFailed' : 'syncVoicePlay');
    };
    const pause = () => {
        autoplay = false;
        audio.pause();
    };
    const release = () => {
        version++;
        loading = false;
        audio.onerror = null;
        pause();
        controller?.abort();
        controller = null;
        capability?.dispose();
        capability = null;
        audio.removeAttribute('src');
        audio.load();
        audio.hidden = true;
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        objectUrl = null;
        cachedPlayers.delete(element);
        button.hidden = false;
        button.disabled = disposed;
        element.dataset.state = 'idle';
        updateLanguage();
    };
    const retain = () => {
        cachedPlayers.delete(element);
        cachedPlayers.set(element, release);
        // A voice is at most 60 seconds of 16 kHz mono PCM: eight entries stay below 16 MiB.
        while (cachedPlayers.size > 8) cachedPlayers.values().next().value();
    };
    const fail = (error, request) => {
        if (request !== version || disposed) return;
        release();
        if (error.name === 'AbortError') return;
        element.dataset.state = 'failed';
        updateLanguage();
        if (canPlay()) onError(error);
    };
    button.addEventListener('click', async () => {
        if (disposed || loading || !canPlay()) return;
        onStart();
        const request = ++version;
        controller = new AbortController();
        const signal = controller.signal;
        loading = true;
        autoplay = true;
        button.disabled = true;
        element.dataset.state = 'loading';
        retain();
        updateLanguage();
        try {
            const opened = await load();
            if (request !== version || disposed) { opened.dispose(); return; }
            capability = opened;
            let blob;
            try {
                const response = await fetch(opened.url, { signal });
                if (!response.ok) throw new Error('voice_playback_failed');
                blob = await response.blob();
            } finally {
                opened.dispose();
                if (capability === opened) capability = null;
            }
            if (request !== version || disposed) return;
            controller = null;
            objectUrl = URL.createObjectURL(blob);
            loading = false;
            audio.onerror = () => fail(new Error('voice_playback_failed'), request);
            audio.src = objectUrl;
            audio.hidden = false;
            button.hidden = true;
            element.dataset.state = 'ready';
            updateLanguage();
            if (autoplay && canPlay()) {
                try { await audio.play(); }
                catch (error) {
                    if (!['NotAllowedError', 'AbortError'].includes(error.name)) fail(error, request);
                }
            }
        } catch (error) { fail(error, request); }
    });
    audio.addEventListener('play', () => {
        if (disposed || !objectUrl || !canPlay()) { pause(); return; }
        retain();
        onStart();
    });
    audio.addEventListener('ended', pause);
    updateLanguage();
    return {
        element,
        pause,
        release,
        dispose() {
            disposed = true;
            release();
        },
        updateLanguage
    };
}
