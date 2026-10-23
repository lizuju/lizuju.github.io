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
        const confirmation = find('confirm-dialog');
        const devicesDialog = find('devices-dialog');
        const messageNodes = new Map();
        const unread = new Set();
        const cooldowns = { create: 0, join: 0, pair: 0 };
        let credentials = null;
        let deviceId = null;
        let devices = [];
        let history = [];
        let socket = null;
        let retryTimer = null;
        let pingTimer = null;
        let countdownTimer = null;
        let pairExpiresAt = 0;
        let retryDelay = 1000;
        let online = false;
        let busy = false;
        let sending = false;
        let active = false;
        let followOnRestore = true;
        let leavingSession = null;
        let pending = null;
        let configPromise = null;
        let sessionVersion = 0;
        let deviceRequest = 0;

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
        const translate = (key, values = {}) => Object.entries(values).reduce((text, [name, value]) => text.replace(`{${name}}`, value), desktopApi.t()[key]);
        const setText = (element, key, state = '') => {
            element.dataset.i18n = key;
            element.dataset.state = state;
            element.textContent = translate(key);
        };
        const setNotice = (key, error = false) => setText(notice, key, error ? 'error' : '');
        const secondsLeft = (until) => Math.max(0, Math.ceil((until - Date.now()) / 1000));
        const updateControls = () => {
            find('create').disabled = busy || sending || secondsLeft(cooldowns.create) > 0;
            find('join').disabled = busy || sending || secondsLeft(cooldowns.join) > 0;
            find('code').disabled = busy || sending;
            find('pair').disabled = busy || sending || !online || secondsLeft(cooldowns.pair) > 0;
            find('devices').disabled = busy || sending || !online;
            find('clear').disabled = busy || sending || !online || !history.length;
            find('leave').disabled = busy || sending;
            find('send').disabled = busy || sending || !online || !input.value.trim();
            find('copy-code').disabled = secondsLeft(pairExpiresAt) === 0;
            devicesDialog.querySelectorAll('[data-sync-device-save], [data-sync-device-remove]').forEach((button) => {
                button.disabled = busy || sending || !online;
            });
        };
        const updateCountdowns = () => {
            for (const [action, key] of [['create', 'syncCreate'], ['join', 'syncJoin'], ['pair', 'syncPair']]) {
                const seconds = secondsLeft(cooldowns[action]);
                const button = find(action);
                button.dataset.i18n = seconds ? '' : key;
                button.textContent = translate(seconds ? (action === 'pair' ? 'syncPairCooldown' : 'syncRetryAfter') : key, { seconds });
            }
            const seconds = secondsLeft(pairExpiresAt);
            if (pairExpiresAt && !seconds) {
                pairExpiresAt = 0;
                find('pairing').hidden = true;
                setNotice('syncCodeExpired');
            }
            find('pair-expiry').textContent = seconds ? translate('syncPairExpires', { minutes: Math.floor(seconds / 60), seconds: String(seconds % 60).padStart(2, '0') }) : '';
            updateControls();
            if (!seconds && !Object.values(cooldowns).some((until) => secondsLeft(until))) {
                clearInterval(countdownTimer);
                countdownTimer = null;
            }
        };
        const startCountdowns = () => {
            if (!countdownTimer) countdownTimer = setInterval(updateCountdowns, 250);
            updateCountdowns();
        };
        const setConnection = (value) => {
            online = value;
            setText(status, value ? 'syncOnline' : 'syncOffline', value ? 'online' : 'offline');
            updateControls();
        };
        const showError = (error, action) => {
            const keys = {
                unavailable: 'syncUnavailable', storage: 'syncStorageError', rate_limited: 'syncRateLimited',
                invalid_code: 'syncInvalidCode', code_expired: 'syncInvalidCode',
                storage_full: 'syncStorageFull', storage_cleaning: 'syncStorageCleaning'
            };
            if (error.code === 'rate_limited' && action && error.retryAfter > 0) {
                cooldowns[action] = Date.now() + error.retryAfter * 1000;
                startCountdowns();
            }
            setNotice(keys[error.code] || 'syncError', true);
        };
        const api = async (path, options = {}, session = credentials) => {
            const base = await loadConfig();
            if (!base) throw Object.assign(new Error('unavailable'), { code: 'unavailable' });
            const response = await fetch(base + path, {
                ...options,
                headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session.token}` } : {}) },
                signal: AbortSignal.timeout(15000)
            });
            const result = await response.json();
            if (!response.ok) throw Object.assign(new Error(result.error), { code: result.error, retryAfter: Number(response.headers.get('Retry-After')) });
            return result;
        };
        const roomPath = (suffix = '') => `/v1/spaces/${credentials.roomId}${suffix}`;
        const draftKey = () => `portfolio-sync-draft:${credentials.roomId}`;
        const saveDraft = () => {
            if (!credentials) return;
            try { sessionStorage.setItem(draftKey(), JSON.stringify({ text: input.value, pending })); }
            catch { setNotice('syncStorageError', true); }
        };
        const atBottom = () => feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
        const isReading = () => active && !document.hidden && app.classList.contains('is-active') && !app.classList.contains('is-minimized');
        const updateUnread = () => {
            const badge = document.querySelector('[data-sync-unread]');
            badge.hidden = !unread.size;
            badge.textContent = unread.size > 99 ? '99+' : String(unread.size);
            badge.setAttribute('aria-label', translate('syncUnread', { count: unread.size }));
            find('latest').hidden = !unread.size;
            find('latest').textContent = unread.size ? `${translate('syncUnread', { count: unread.size })} · ${translate('syncLatest')}` : translate('syncLatest');
            find('latest').dataset.i18n = '';
        };
        const markRead = () => {
            if (isReading() && atBottom()) {
                unread.clear();
                updateUnread();
            }
        };
        const render = (scroll = false) => {
            const follow = scroll || (atBottom() && isReading());
            const ids = new Set(history.map((message) => message.id));
            for (const [id, item] of messageNodes) {
                if (!ids.has(id)) { item.remove(); messageNodes.delete(id); unread.delete(id); }
            }
            history.forEach((message, index) => {
                let item = messageNodes.get(message.id);
                if (!item) {
                    item = document.createElement('li');
                    item.className = 'sync-message';
                    const meta = document.createElement('small');
                    meta.className = 'sync-message-meta';
                    const label = document.createElement('span');
                    const copy = document.createElement('button');
                    copy.type = 'button';
                    copy.className = 'sync-message-copy';
                    copy.dataset.syncCopyMessage = '';
                    copy.addEventListener('click', () => copyText(message.text));
                    meta.append(label, copy);
                    const text = document.createElement('p');
                    text.className = 'sync-message-text';
                    let end = 0;
                    for (const match of message.text.matchAll(/\bhttps?:\/\/[^\s<>"']+/gi)) {
                        const value = match[0].replace(/[.,!?;:，。！？；：、）)\]}]+$/, '');
                        let url;
                        try { url = new URL(value); } catch { continue; }
                        if (!['http:', 'https:'].includes(url.protocol)) continue;
                        text.append(document.createTextNode(message.text.slice(end, match.index)));
                        const link = document.createElement('a');
                        link.href = url.href;
                        link.textContent = value;
                        link.target = '_blank';
                        link.rel = 'noopener noreferrer';
                        text.append(link);
                        end = match.index + value.length;
                    }
                    text.append(document.createTextNode(message.text.slice(end)));
                    item.append(meta, text);
                    messageNodes.set(message.id, item);
                }
                item.classList.toggle('is-own', message.deviceId === deviceId);
                const label = `${translate(message.deviceId === deviceId ? 'syncMessageYou' : 'syncMessageDevice')} · ${new Date(message.createdAt).toLocaleString(desktopApi.getLanguage())}`;
                if (item.firstChild.firstChild.textContent !== label) item.firstChild.firstChild.textContent = label;
                const copy = item.querySelector('[data-sync-copy-message]');
                copy.textContent = translate('syncCopy');
                if (messages.children[index] !== item) messages.insertBefore(item, messages.children[index] || null);
            });
            find('empty').hidden = history.length !== 0;
            if (follow) feed.scrollTop = feed.scrollHeight;
            markRead();
            updateUnread();
            updateControls();
        };
        const receiveHistory = (incoming, initial = false) => {
            const known = new Set(history.map((message) => message.id));
            if (!initial && !(isReading() && atBottom())) {
                incoming.forEach((message) => { if (!known.has(message.id) && message.deviceId !== deviceId) unread.add(message.id); });
            }
            history = incoming;
            render(initial);
        };
        const addMessage = (message) => {
            if (history.some((item) => item.id === message.id)) return;
            if (message.deviceId !== deviceId && !(isReading() && atBottom())) unread.add(message.id);
            history = [...history, message].sort((a, b) => a.id - b.id).slice(-500);
            render();
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
        const retry = () => {
            if (!active || !credentials) return;
            clearTimeout(retryTimer);
            retryTimer = setTimeout(connect, retryDelay);
            retryDelay = Math.min(retryDelay * 2, 30000);
        };
        const connect = async () => {
            if (!active || !credentials || socket) return;
            const session = credentials;
            setText(status, 'syncConnecting', 'connecting');
            const base = await loadConfig();
            if (!active || credentials !== session || socket) return;
            if (!base) {
                setConnection(false);
                setNotice('syncUnavailable', true);
                retry();
                return;
            }
            const url = new URL(base + roomPath('/socket'));
            url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
            const connection = new WebSocket(url);
            let awaitingPong = false;
            socket = connection;
            connection.addEventListener('open', () => {
                if (socket === connection) connection.send(JSON.stringify({ type: 'auth', token: session.token }));
            });
            connection.addEventListener('message', (event) => {
                if (socket !== connection) return;
                if (event.data === 'pong') { awaitingPong = false; return; }
                let data;
                try { data = JSON.parse(event.data); } catch { return; }
                if (data.type === 'ready') {
                    const initial = deviceId === null;
                    deviceId = data.deviceId;
                    retryDelay = 1000;
                    setConnection(true);
                    receiveHistory(data.messages, initial);
                    if (notice.dataset.i18n === 'syncUnavailable') setNotice('syncJoined');
                    if (devicesDialog.open) loadDevices();
                    clearInterval(pingTimer);
                    pingTimer = setInterval(() => {
                        if (awaitingPong) connection.close();
                        else if (connection.readyState === WebSocket.OPEN) {
                            awaitingPong = true;
                            connection.send('ping');
                        }
                    }, 30000);
                } else if (data.type === 'message') addMessage(data.message);
                else if (data.type === 'history') receiveHistory(data.messages);
                else if (data.type === 'devices' && devicesDialog.open) loadDevices();
                else if (data.type === 'cleared') {
                    history = [];
                    unread.clear();
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
                    const left = leavingSession === session;
                    reset();
                    setNotice(left ? 'syncLeft' : 'syncRejoin', !left);
                    reconcileSession();
                    return;
                }
                if (credentials === session) retry();
            });
        };
        const showPairing = ({ code, expiresAt }) => {
            pairExpiresAt = expiresAt;
            find('pairing').hidden = false;
            find('pair-code').textContent = code;
            cooldowns.pair = Date.now() + 30000;
            startCountdowns();
        };
        const savedSession = () => {
            const saved = JSON.parse(localStorage.getItem(CREDENTIAL_KEY) || 'null');
            return typeof saved?.roomId === 'string' && typeof saved?.token === 'string' ? saved : null;
        };
        const sameSession = (a, b) => a?.roomId === b?.roomId && a?.token === b?.token;
        const reset = (forget = true) => {
            if (confirmation.open) confirmation.close();
            if (devicesDialog.open) devicesDialog.close();
            disconnect();
            if (forget) {
                try { if (sameSession(savedSession(), credentials)) localStorage.removeItem(CREDENTIAL_KEY); }
                catch { /* Storage may be blocked. */ }
            }
            sessionVersion++;
            credentials = null;
            deviceId = null;
            devices = [];
            deviceRequest++;
            find('devices-list').replaceChildren();
            pending = null;
            history = [];
            input.value = '';
            busy = false;
            sending = false;
            leavingSession = null;
            followOnRestore = true;
            pairExpiresAt = 0;
            cooldowns.pair = 0;
            unread.clear();
            find('pairing').hidden = true;
            room.hidden = true;
            setup.hidden = false;
            render();
            updateCountdowns();
        };
        const enter = (session) => {
            saveDraft();
            reset(false);
            credentials = { roomId: session.roomId, token: session.token };
            setup.hidden = true;
            room.hidden = false;
            try {
                const draft = JSON.parse(sessionStorage.getItem(draftKey()) || 'null');
                input.value = draft?.text || '';
                pending = draft?.pending || null;
            } catch { input.value = ''; pending = null; }
            if (session.code) showPairing(session);
            render();
            connect();
        };
        const reconcileSession = () => {
            try {
                const saved = savedSession();
                if (!sameSession(saved, credentials)) {
                    if (saved) { enter(saved); setNotice('syncJoined'); }
                    else { saveDraft(); reset(false); setNotice('syncReady'); }
                }
            } catch { setNotice('syncStorageError', true); }
        };
        const copyText = async (text) => {
            const session = credentials;
            try { await navigator.clipboard.writeText(text); if (credentials === session) setNotice('syncCopied'); }
            catch { if (credentials === session) setNotice('syncCopyError', true); }
        };
        const renderDevices = () => {
            const list = find('devices-list');
            const ids = new Set(devices.map((device) => device.deviceId));
            Array.from(list.children).forEach((item) => { if (!ids.has(item.dataset.deviceId)) item.remove(); });
            devices.forEach((device, index) => {
                let item = Array.from(list.children).find((node) => node.dataset.deviceId === device.deviceId);
                if (!item) {
                    item = document.createElement('li');
                    item.className = 'sync-device';
                    item.dataset.deviceId = device.deviceId;
                    const heading = document.createElement('div');
                    heading.className = 'sync-device-heading';
                    const label = document.createElement('strong');
                    const current = document.createElement('span');
                    current.className = 'sync-device-current';
                    heading.append(label, current);
                    const name = document.createElement('input');
                    name.type = 'text';
                    name.maxLength = 60;
                    name.dataset.syncDeviceName = '';
                    name.dataset.saved = device.name;
                    name.value = device.name;
                    const save = document.createElement('button');
                    save.type = 'button';
                    save.className = 'sync-button';
                    save.dataset.syncDeviceSave = '';
                    const remove = document.createElement('button');
                    remove.type = 'button';
                    remove.className = 'sync-button';
                    remove.dataset.syncDeviceRemove = '';
                    item.append(heading, name, save, remove);
                }
                item.querySelector('strong').textContent = device.name || translate('syncDeviceDefault', { id: index + 1 });
                const current = item.querySelector('.sync-device-current');
                current.textContent = translate('syncDeviceCurrent');
                current.hidden = device.deviceId !== deviceId;
                const name = item.querySelector('input');
                if (name.value === name.dataset.saved) { name.value = device.name; name.dataset.saved = device.name; }
                name.setAttribute('aria-label', translate('syncDeviceName'));
                name.placeholder = translate('syncDeviceNamePlaceholder');
                item.querySelector('[data-sync-device-save]').textContent = translate('syncDeviceSave');
                item.querySelector('[data-sync-device-remove]').textContent = translate('syncDeviceRemove');
                if (list.children[index] !== item) list.insertBefore(item, list.children[index] || null);
            });
            updateControls();
        };
        const loadDevices = async () => {
            const session = credentials;
            const request = ++deviceRequest;
            setText(find('devices-status'), 'syncDevicesLoading');
            try {
                const result = await api(roomPath('/devices'));
                if (credentials !== session || request !== deviceRequest) return false;
                devices = result.devices;
                deviceId = result.deviceId;
                renderDevices();
                find('devices-status').textContent = '';
                find('devices-status').dataset.i18n = '';
                return true;
            } catch {
                if (credentials === session && request === deviceRequest) setText(find('devices-status'), 'syncDevicesError', 'error');
                return false;
            }
        };
        const entry = manager.registerWindow({
            id: 'sync-space', element: app, task: document.querySelector('[data-sync-task]'),
            titlebar: find('titlebar'), resizeHandle: find('resize'),
            actionAttribute: 'data-sync-action', minWidth: 320, minHeight: 350,
            focusTarget: () => credentials ? input : find('code'),
            show: () => {
                manager.showWindow(app, entry.task, { revealTask: true });
                active = true;
                reconcileSession();
                connect();
                if (followOnRestore) feed.scrollTop = feed.scrollHeight;
                markRead();
            },
            hide: (state) => {
                followOnRestore = atBottom();
                if (confirmation.open) confirmation.close();
                if (devicesDialog.open) devicesDialog.close();
                manager.hideWindow(app, entry.task, state, { hideTask: state === 'is-closed' });
                if (state === 'is-closed') { active = false; disconnect(); }
            }
        });
        document.querySelectorAll('[data-open-sync-space]').forEach((button) => button.addEventListener('click', entry.show));
        const pair = async (path, body, action) => {
            if (busy || sending || secondsLeft(cooldowns[action])) return;
            const version = sessionVersion;
            busy = true;
            updateControls();
            setNotice(action === 'create' ? 'syncCreating' : 'syncJoining');
            try {
                // Check persistence without replacing another tab's paired session.
                const previous = localStorage.getItem(CREDENTIAL_KEY);
                if (previous !== null) localStorage.setItem(CREDENTIAL_KEY, previous);
                else { localStorage.setItem(CREDENTIAL_KEY, 'null'); localStorage.removeItem(CREDENTIAL_KEY); }
                const session = await api(path, { method: 'POST', body: JSON.stringify(body) }, null);
                if (version !== sessionVersion) return;
                localStorage.setItem(CREDENTIAL_KEY, JSON.stringify({ roomId: session.roomId, token: session.token }));
                enter(session);
                setNotice(session.code ? 'syncPaired' : 'syncJoined');
                input.focus({ preventScroll: true });
            } catch (error) {
                if (version !== sessionVersion) return;
                if (error.name === 'QuotaExceededError' || error.name === 'SecurityError') error.code = 'storage';
                showError(error, action);
            } finally {
                if (version === sessionVersion) { busy = false; updateControls(); }
            }
        };
        find('create').addEventListener('click', () => pair('/v1/spaces', {}, 'create'));
        find('join-form').addEventListener('submit', (event) => {
            event.preventDefault();
            if (find('join-form').reportValidity()) pair('/v1/pair', { code: find('code').value }, 'join');
        });
        find('pair').addEventListener('click', async () => {
            if (busy || sending || !online || secondsLeft(cooldowns.pair)) return;
            const session = credentials;
            busy = true;
            updateControls();
            try {
                const pairing = await api(roomPath('/pair-code'), { method: 'POST' });
                if (credentials !== session) return;
                showPairing(pairing);
                setNotice('syncPaired');
            } catch (error) { if (credentials === session) showError(error, 'pair'); }
            finally { if (credentials === session) { busy = false; updateControls(); } }
        });
        find('send-form').addEventListener('submit', async (event) => {
            event.preventDefault();
            if (busy || sending || !online || !input.value.trim() || !find('send-form').reportValidity()) return;
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
            finally { if (credentials === session) { sending = false; updateControls(); } }
        });
        input.maxLength = 10000;
        input.addEventListener('input', () => { saveDraft(); updateControls(); });
        input.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
            event.preventDefault();
            if (!event.repeat) find('send-form').requestSubmit();
        });
        find('copy-code').addEventListener('click', () => copyText(find('pair-code').textContent));
        find('latest').addEventListener('click', () => { feed.scrollTop = feed.scrollHeight; markRead(); });
        feed.addEventListener('scroll', markRead);
        new MutationObserver(markRead).observe(app, { attributes: true, attributeFilter: ['class'] });
        find('devices').addEventListener('click', () => {
            if (busy || sending || !online) return;
            find('devices').focus({ preventScroll: true });
            devicesDialog.showModal();
            loadDevices();
        });
        const showConfirmation = (action, target) => {
            if (busy || sending || !credentials) return;
            confirmation.dataset.action = action;
            confirmation.dataset.deviceId = target || '';
            const key = action === 'remove' ? 'syncDeviceRemove' : action === 'clear' ? 'syncClear' : 'syncLeave';
            setText(find('confirm-title'), key);
            setText(find('confirm-copy'), key + 'Confirm');
            setText(find('confirm-accept'), key);
            if (action !== 'remove') find(action).focus({ preventScroll: true });
            confirmation.showModal();
        };
        find('clear').addEventListener('click', () => showConfirmation('clear'));
        find('leave').addEventListener('click', () => showConfirmation('leave'));
        for (const dialog of [confirmation, devicesDialog]) {
            dialog.addEventListener('keydown', (event) => {
                event.stopPropagation();
                if (event.key !== 'Tab') return;
                event.preventDefault();
                const controls = Array.from(dialog.querySelectorAll('button:not(:disabled), input:not(:disabled)'));
                const direction = event.shiftKey ? -1 : 1;
                controls[(controls.indexOf(document.activeElement) + direction + controls.length) % controls.length].focus();
            });
            dialog.addEventListener('keyup', (event) => event.stopPropagation());
        }
        find('devices-list').addEventListener('click', async (event) => {
            const button = event.target.closest('button');
            if (!button || busy || sending || !online) return;
            const row = button.closest('[data-device-id]');
            const target = row.dataset.deviceId;
            if (button.hasAttribute('data-sync-device-remove')) { showConfirmation('remove', target); return; }
            if (!button.hasAttribute('data-sync-device-save')) return;
            const name = row.querySelector('input');
            const text = name.value;
            const session = credentials;
            busy = true;
            updateControls();
            try {
                await api(roomPath(`/devices/${target}`), { method: 'PATCH', body: JSON.stringify({ name: text }) });
                if (credentials !== session) return;
                if (name.value === text) { name.value = text.trim(); name.dataset.saved = text.trim(); }
                const loaded = await loadDevices();
                if (loaded && credentials === session) setText(find('devices-status'), 'syncDeviceSaved');
            } catch (error) { if (credentials === session) showError(error); }
            finally { if (credentials === session) { busy = false; updateControls(); } }
        });
        find('confirm-accept').addEventListener('click', async () => {
            if (busy || sending || !credentials) return;
            const action = confirmation.dataset.action;
            const target = confirmation.dataset.deviceId;
            confirmation.close();
            const session = credentials;
            if (action === 'leave' || (action === 'remove' && target === deviceId)) leavingSession = session;
            busy = true;
            updateControls();
            try {
                const suffix = action === 'clear' ? '/messages' : action === 'remove' ? `/devices/${target}` : '/device';
                await api(roomPath(suffix), { method: 'DELETE' });
                if (credentials !== session) return;
                if (action === 'clear') {
                    setNotice('syncCleared');
                    input.focus({ preventScroll: true });
                } else if (action === 'remove' && target !== deviceId) {
                    devices = devices.filter((device) => device.deviceId !== target);
                    renderDevices();
                    const loaded = await loadDevices();
                    if (loaded && credentials === session) setText(find('devices-status'), 'syncDeviceRemoved');
                } else { reset(); setNotice('syncLeft'); }
            } catch (error) { if (credentials === session) showError(error); }
            finally {
                if (credentials === session) { busy = false; leavingSession = null; updateControls(); }
                if (!credentials) find('code').focus({ preventScroll: true });
            }
        });
        window.addEventListener('online', () => { clearTimeout(retryTimer); connect(); });
        window.addEventListener('storage', (event) => { if (event.key === CREDENTIAL_KEY || event.key === null) reconcileSession(); });
        window.addEventListener('pagehide', () => { saveDraft(); disconnect(); });
        window.addEventListener('pageshow', () => { reconcileSession(); if (active) connect(); });
        document.addEventListener('visibilitychange', markRead);
        window.addEventListener('portfolio-language-change', () => {
            render();
            renderDevices();
            updateCountdowns();
            updateUnread();
            for (const [action, key] of [['minimize', 'syncMinimize'], ['maximize', 'syncMaximize'], ['close', 'syncClose']]) {
                const button = app.querySelector(`[data-sync-action="${action}"]`);
                button.setAttribute('aria-label', translate(key));
                button.title = translate(key);
            }
            find('resize').setAttribute('aria-label', translate('syncResize'));
            find('resize').title = translate('syncResize');
            find('confirm-close').setAttribute('aria-label', translate('syncDialogClose'));
            find('devices-close').setAttribute('aria-label', translate('syncDevicesDialogClose'));
        });
        manager.onSession({ restore: () => {
            active = !app.classList.contains('is-closed');
            reconcileSession();
            if (active) connect();
        } });
        reconcileSession();
        updateControls();
        return entry;
    };
})();
