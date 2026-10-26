const cachedPlayers = new Map();

export function createVoicePlayer({ durationMs, load, canPlay, onStart, onError, translate }) {
    const element = document.createElement('div');
    element.className = 'sync-voice-message';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sync-button sync-voice-toggle';
    button.dataset.syncVoicePlay = '';
    const progress = document.createElement('input');
    progress.type = 'range';
    progress.className = 'sync-voice-progress';
    progress.min = '0';
    progress.step = '0.1';
    progress.value = '0';
    progress.disabled = true;
    const duration = document.createElement('span');
    duration.className = 'sync-voice-duration';
    const audio = document.createElement('audio');
    audio.preload = 'auto';
    audio.setAttribute('playsinline', '');
    audio.hidden = true;
    element.append(button, progress, duration, audio);
    let capability = null;
    let controller = null;
    let objectUrl = null;
    let version = 0;
    let disposed = false;
    let loading = false;
    let autoplay = false;

    const formatTime = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
    const updateProgress = () => {
        const total = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : durationMs / 1000;
        const current = Math.min(audio.currentTime, total);
        progress.max = String(total);
        progress.value = String(current);
        duration.textContent = `${formatTime(audio.ended ? Math.ceil(total) : current)} / ${formatTime(Math.ceil(total))}`;
        progress.setAttribute('aria-valuetext', duration.textContent);
    };
    const updateLanguage = () => {
        const label = translate('syncVoiceMessage');
        element.setAttribute('aria-label', `${label} ${formatTime(Math.ceil(durationMs / 1000))}`);
        audio.setAttribute('aria-label', label);
        const action = loading ? 'syncVoiceLoading' : audio.paused ? 'syncVoicePlay' : 'syncVoicePause';
        button.textContent = loading ? '…' : audio.paused ? '▶' : 'Ⅱ';
        button.setAttribute('aria-label', translate(action));
        button.title = translate(element.dataset.state === 'failed' ? 'syncVoicePlaybackFailed' : action);
        progress.setAttribute('aria-label', translate('syncVoiceSeek'));
        element.setAttribute('aria-busy', String(loading));
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
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        objectUrl = null;
        cachedPlayers.delete(element);
        button.disabled = disposed;
        progress.disabled = true;
        element.dataset.state = 'idle';
        updateProgress();
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
        if (objectUrl) {
            if (!audio.paused) { pause(); return; }
            const request = version;
            autoplay = true;
            if (audio.ended) audio.currentTime = 0;
            try { await audio.play(); }
            catch (error) {
                if (!['NotAllowedError', 'AbortError'].includes(error.name)) fail(error, request);
            }
            return;
        }
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
            button.disabled = false;
            progress.disabled = false;
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
        updateLanguage();
    });
    progress.addEventListener('input', () => {
        if (!objectUrl || !canPlay()) return;
        audio.currentTime = Number(progress.value);
        updateProgress();
    });
    ['loadedmetadata', 'durationchange', 'timeupdate', 'ended'].forEach(event => audio.addEventListener(event, updateProgress));
    audio.addEventListener('pause', updateLanguage);
    audio.addEventListener('ended', pause);
    updateProgress();
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
