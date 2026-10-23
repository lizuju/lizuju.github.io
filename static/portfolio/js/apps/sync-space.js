(() => {
    const desktopApi = window.GavinDesktop;
    const CREDENTIAL_KEY = 'portfolio-sync-space';

    desktopApi.apps.syncSpace = (manager) => {
        const app = document.querySelector('[data-sync-window]');
        const find = (name) => app.querySelector(`[data-sync-${name}]`);
        const setup = find('setup');
        const room = find('room');
        const input = find('input');
        const messages = find('messages');
        const feed = find('feed');
        const status = find('status');
        const notice = find('notice');
        let credentials = null;
        let deviceId = null;
        let history = [];
        let socket = null;
        let retryTimer = null;
        let pingTimer = null;
        let pairTimer = null;
        let retryDelay = 1000;
        let online = false;
        let busy = false;
        let sending = false;
        let active = false;
        let pending = null;
        let configPromise = null;

        const loadConfig = () => {
            if (!configPromise) {
                configPromise = fetch(new URL('sync-config.json', document.baseURI), { cache: 'no-store', signal: AbortSignal.timeout(15000) })
                    .then(async (response) => {
                        const value = response.ok ? await response.json() : null;
                        if (!value?.apiBase) throw new Error('unavailable');
                        const url = new URL(value.apiBase);
                        if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('invalid_endpoint');
                        return url.href.replace(/\/$/, '');
                    }).catch(() => {
                        configPromise = null;
                        return null;
                    });
            }
            return configPromise;
        };

        const setText = (element, key, state = '') => {
            element.dataset.i18n = key;
            element.dataset.state = state;
            element.textContent = desktopApi.t()[key];
        };
        const setNotice = (key, error = false) => setText(notice, key, error ? 'error' : '');
        const updateControls = () => {
            find('create').disabled = busy || sending;
            find('join').disabled = busy || sending;
            find('code').disabled = busy || sending;
            find('pair').disabled = busy || !online;
            find('clear').disabled = busy || !online || !history.length;
            find('leave').disabled = busy || sending;
            find('send').disabled = busy || sending || !online || !input.value.trim();
        };
        const setConnection = (value) => {
            online = value;
            setText(status, value ? 'syncOnline' : 'syncOffline', value ? 'online' : 'offline');
            updateControls();
        };
        const showError = (error) => {
            const keys = {
                unavailable: 'syncUnavailable',
                storage: 'syncStorageError',
                rate_limited: 'syncRateLimited',
                invalid_code: 'syncInvalidCode',
                code_expired: 'syncInvalidCode',
                storage_full: 'syncStorageFull',
                storage_cleaning: 'syncStorageCleaning'
            };
            setNotice(keys[error.code] || 'syncError', true);
        };
        const api = async (path, options = {}, session = credentials) => {
            const base = await loadConfig();
            if (!base) throw Object.assign(new Error('unavailable'), { code: 'unavailable' });
            const response = await fetch(base + path, {
                ...options,
                headers: {
                    'Content-Type': 'application/json',
                    ...(session ? { Authorization: `Bearer ${session.token}` } : {})
                },
                signal: AbortSignal.timeout(15000)
            });
            const result = await response.json();
            if (!response.ok) throw Object.assign(new Error(result.error), { code: result.error });
            return result;
        };
        const roomPath = (suffix = '') => `/v1/spaces/${credentials.roomId}${suffix}`;
        const draftKey = () => `portfolio-sync-draft:${credentials.roomId}`;
        const saveDraft = () => {
            if (!credentials) return;
            try {
                sessionStorage.setItem(draftKey(), JSON.stringify({ text: input.value, pending }));
            } catch {
                setNotice('syncStorageError', true);
            }
        };
        const render = (scroll = false) => {
            const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
            const fragment = document.createDocumentFragment();
            for (const message of history) {
                const item = document.createElement('li');
                item.className = 'sync-message' + (message.deviceId === deviceId ? ' is-own' : '');
                const meta = document.createElement('small');
                meta.className = 'sync-message-meta';
                meta.textContent = `${desktopApi.t()[message.deviceId === deviceId ? 'syncMessageYou' : 'syncMessageDevice']} · ${new Date(message.createdAt).toLocaleString(desktopApi.getLanguage())}`;
                const text = document.createElement('p');
                text.className = 'sync-message-text';
                text.textContent = message.text;
                item.append(meta, text);
                fragment.append(item);
            }
            messages.replaceChildren(fragment);
            find('empty').hidden = history.length !== 0;
            if (scroll || nearBottom) feed.scrollTop = feed.scrollHeight;
            updateControls();
        };
        const addMessage = (message) => {
            if (!history.some((item) => item.id === message.id)) {
                history = [...history, message].sort((a, b) => a.id - b.id).slice(-500);
                render();
            }
        };
        const disconnect = () => {
            clearTimeout(retryTimer);
            clearInterval(pingTimer);
            retryTimer = null;
            const previous = socket;
            socket = null;
            previous?.close();
            setConnection(false);
        };
        const connect = async () => {
            if (!active || !credentials || socket) return;
            const session = credentials;
            const base = await loadConfig();
            if (!active || credentials !== session || socket) return;
            if (!base) {
                setNotice('syncUnavailable', true);
                return;
            }
            const url = new URL(base + roomPath('/socket'));
            url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
            const connection = new WebSocket(url);
            let awaitingPong = false;
            socket = connection;
            setText(status, 'syncConnecting', 'connecting');
            connection.addEventListener('open', () => {
                if (socket === connection) connection.send(JSON.stringify({ type: 'auth', token: session.token }));
            });
            connection.addEventListener('message', (event) => {
                if (socket !== connection) return;
                if (event.data === 'pong') {
                    awaitingPong = false;
                    return;
                }
                let data;
                try { data = JSON.parse(event.data); } catch { return; }
                if (data.type === 'ready') {
                    deviceId = data.deviceId;
                    history = data.messages;
                    retryDelay = 1000;
                    setConnection(true);
                    render(true);
                    clearInterval(pingTimer);
                    pingTimer = setInterval(() => {
                        if (awaitingPong) connection.close();
                        else if (connection.readyState === WebSocket.OPEN) {
                            awaitingPong = true;
                            connection.send('ping');
                        }
                    }, 30000);
                } else if (data.type === 'message') {
                    addMessage(data.message);
                } else if (data.type === 'history') {
                    history = data.messages;
                    render();
                } else if (data.type === 'cleared') {
                    history = [];
                    render();
                    setNotice('syncCleared');
                }
            });
            connection.addEventListener('close', (event) => {
                if (socket !== connection) return;
                clearInterval(pingTimer);
                socket = null;
                setConnection(false);
                if (event.code === 4001) {
                    reset();
                    setNotice('syncRejoin', true);
                    return;
                }
                if (active && credentials === session) {
                    retryTimer = setTimeout(connect, retryDelay);
                    retryDelay = Math.min(retryDelay * 2, 30000);
                }
            });
        };
        const showPairing = ({ code, expiresAt }) => {
            clearTimeout(pairTimer);
            find('pairing').hidden = false;
            find('pair-code').textContent = code;
            pairTimer = setTimeout(() => {
                find('pairing').hidden = true;
                setNotice('syncCodeExpired');
            }, Math.max(0, expiresAt - Date.now()));
        };
        const enter = (session) => {
            credentials = { roomId: session.roomId, token: session.token };
            setup.hidden = true;
            room.hidden = false;
            try {
                const draft = JSON.parse(sessionStorage.getItem(draftKey()) || 'null');
                input.value = draft?.text || '';
                pending = draft?.pending || null;
            } catch {
                input.value = '';
                pending = null;
            }
            if (session.code) showPairing(session);
            render();
            connect();
        };
        const reset = () => {
            disconnect();
            clearTimeout(pairTimer);
            credentials = null;
            deviceId = null;
            pending = null;
            history = [];
            input.value = '';
            find('pairing').hidden = true;
            room.hidden = true;
            setup.hidden = false;
            try { localStorage.removeItem(CREDENTIAL_KEY); } catch { /* Storage may be blocked. */ }
            updateControls();
        };

        const entry = manager.registerWindow({
            id: 'sync-space', element: app, task: document.querySelector('[data-sync-task]'),
            titlebar: find('titlebar'), resizeHandle: find('resize'),
            actionAttribute: 'data-sync-action', minWidth: 320, minHeight: 350,
            focusTarget: () => credentials ? input : find('code'),
            show: () => {
                manager.showWindow(app, entry.task, { revealTask: true });
                active = true;
                connect();
            },
            hide: (state) => {
                manager.hideWindow(app, entry.task, state, { hideTask: state === 'is-closed' });
                if (state === 'is-closed') {
                    active = false;
                    disconnect();
                }
            }
        });
        document.querySelectorAll('[data-open-sync-space]').forEach((button) => button.addEventListener('click', entry.show));
        const pair = async (path, body) => {
            if (busy) return;
            busy = true;
            updateControls();
            setNotice(path === '/v1/spaces' ? 'syncCreating' : 'syncJoining');
            try {
                // Check persistence before creating a space that this browser could immediately lose.
                localStorage.setItem(CREDENTIAL_KEY, 'null');
                const session = await api(path, { method: 'POST', body: JSON.stringify(body) }, null);
                localStorage.setItem(CREDENTIAL_KEY, JSON.stringify({ roomId: session.roomId, token: session.token }));
                enter(session);
                setNotice(session.code ? 'syncPaired' : 'syncJoined');
                input.focus({ preventScroll: true });
            } catch (error) {
                if (error.name === 'QuotaExceededError' || error.name === 'SecurityError') error.code = 'storage';
                showError(error);
            } finally {
                busy = false;
                updateControls();
            }
        };
        find('create').addEventListener('click', () => pair('/v1/spaces', {}));
        find('join-form').addEventListener('submit', (event) => {
            event.preventDefault();
            if (find('join-form').reportValidity()) pair('/v1/pair', { code: find('code').value });
        });
        find('pair').addEventListener('click', async () => {
            const session = credentials;
            busy = true;
            updateControls();
            try {
                const pairing = await api(roomPath('/pair-code'), { method: 'POST' });
                if (credentials !== session) return;
                showPairing(pairing);
                setNotice('syncPaired');
            } catch (error) { if (credentials === session) showError(error); }
            finally { busy = false; updateControls(); }
        });
        find('send-form').addEventListener('submit', async (event) => {
            event.preventDefault();
            if (sending || !online || !input.value.trim() || !find('send-form').reportValidity()) return;
            const text = input.value;
            const session = credentials;
            if (pending?.text !== text) pending = { clientId: crypto.randomUUID(), text };
            saveDraft();
            sending = true;
            updateControls();
            setNotice('syncSending');
            try {
                await api(roomPath('/messages'), { method: 'POST', body: JSON.stringify(pending) });
                if (credentials !== session) return;
                if (input.value === text) input.value = '';
                pending = null;
                saveDraft();
                setNotice('syncSent');
            } catch (error) { if (credentials === session) showError(error); }
            finally { sending = false; updateControls(); }
        });
        input.maxLength = 10000;
        input.addEventListener('input', () => { saveDraft(); updateControls(); });
        input.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
            event.preventDefault();
            if (!event.repeat) find('send-form').requestSubmit();
        });
        find('clear').addEventListener('click', async () => {
            if (!window.confirm(desktopApi.t().syncClearConfirm)) return;
            const session = credentials;
            busy = true;
            updateControls();
            try {
                await api(roomPath('/messages'), { method: 'DELETE' });
                if (credentials !== session) return;
                setNotice('syncCleared');
            } catch (error) { if (credentials === session) showError(error); }
            finally { busy = false; updateControls(); }
        });
        find('leave').addEventListener('click', async () => {
            if (!window.confirm(desktopApi.t().syncLeaveConfirm)) return;
            busy = true;
            updateControls();
            try {
                await api(roomPath('/device'), { method: 'DELETE' });
                reset();
                setNotice('syncLeft');
                find('code').focus({ preventScroll: true });
            } catch (error) { showError(error); }
            finally { busy = false; updateControls(); }
        });
        window.addEventListener('online', () => { clearTimeout(retryTimer); connect(); });
        window.addEventListener('pagehide', disconnect);
        window.addEventListener('pageshow', () => { if (active) connect(); });
        window.addEventListener('portfolio-language-change', () => {
            render();
            for (const [action, key] of [['minimize', 'syncMinimize'], ['maximize', 'syncMaximize'], ['close', 'syncClose']]) {
                const button = app.querySelector(`[data-sync-action="${action}"]`);
                button.setAttribute('aria-label', desktopApi.t()[key]);
                button.title = desktopApi.t()[key];
            }
            find('resize').setAttribute('aria-label', desktopApi.t().syncResize);
            find('resize').title = desktopApi.t().syncResize;
        });
        manager.onSession({ restore: () => {
            active = !app.classList.contains('is-closed');
            if (active) connect();
        } });
        try {
            const saved = JSON.parse(localStorage.getItem(CREDENTIAL_KEY) || 'null');
            if (saved?.roomId && saved?.token) enter(saved);
        } catch { setNotice('syncStorageError', true); }
        updateControls();
        return entry;
    };
})();
