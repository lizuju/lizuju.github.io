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
    audio.preload = 'none';
    audio.setAttribute('playsinline', '');
    audio.hidden = true;
    element.append(button, duration, audio);
    let capability = null;
    let version = 0;
    let disposed = false;
    let loading = false;

    const updateLanguage = () => {
        const label = translate('syncVoiceMessage');
        element.setAttribute('aria-label', `${label} ${duration.textContent}`);
        audio.setAttribute('aria-label', label);
        button.textContent = translate(loading ? 'syncVoiceLoading' : 'syncVoicePlay');
        button.title = translate(element.dataset.state === 'failed' ? 'syncVoicePlaybackFailed' : 'syncVoicePlay');
    };
    const pause = () => {
        version++;
        loading = false;
        audio.onerror = null;
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
        audio.hidden = true;
        capability?.dispose();
        capability = null;
        button.hidden = false;
        button.disabled = disposed;
        element.dataset.state = 'idle';
        updateLanguage();
    };
    const fail = (error, request) => {
        if (request !== version || disposed) return;
        pause();
        if (error.name === 'AbortError' || !canPlay()) return;
        element.dataset.state = 'failed';
        updateLanguage();
        onError(error);
    };
    button.addEventListener('click', async () => {
        if (disposed || loading || !canPlay()) return;
        onStart();
        const request = ++version;
        loading = true;
        button.disabled = true;
        element.dataset.state = 'loading';
        updateLanguage();
        try {
            const opened = await load();
            if (request !== version || disposed || !canPlay()) {
                opened.dispose();
                if (request === version && !disposed) pause();
                return;
            }
            capability = opened;
            loading = false;
            audio.onerror = () => fail(new Error('voice_playback_failed'), request);
            audio.src = opened.url;
            audio.hidden = false;
            button.hidden = true;
            element.dataset.state = 'ready';
            updateLanguage();
            try { await audio.play(); }
            catch (error) {
                if (error.name !== 'NotAllowedError') fail(error, request);
            }
        } catch (error) { fail(error, request); }
    });
    audio.addEventListener('play', () => {
        if (disposed || !capability || !canPlay()) { pause(); return; }
        onStart();
    });
    audio.addEventListener('ended', pause);
    updateLanguage();
    return {
        element,
        pause,
        dispose() {
            disposed = true;
            pause();
        },
        updateLanguage
    };
}
