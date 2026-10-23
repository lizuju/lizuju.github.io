(() => {
    const desktopApi = window.GavinDesktop;
    const CREDENTIAL_KEY = 'portfolio-sync-space';
    const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
    const MAX_PREVIEW_BYTES = 20 * 1024 * 1024;

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
        const attachmentRequests = new Map();
        const previewUrls = new Map();
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
        let selectedFile = null;
        let pendingUpload = null;
        let uploadController = null;
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
            find('send').disabled = busy || sending || !online || (!selectedFile && (pendingUpload || !input.value.trim()));
            find('attach').disabled = busy || sending || !online;
            find('file-input').disabled = busy || sending || !online;
            find('remove-file').disabled = busy || sending;
            find('cancel-upload').hidden = !sending || !pendingUpload;
            find('cancel-upload').disabled = busy || !pendingUpload?.uploadId || pendingUpload.stage === 'syncCompletingUpload' || uploadController?.signal.aborted;
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
                storage_full: 'syncStorageFull', storage_cleaning: 'syncStorageCleaning',
                file_too_large: 'syncFileTooLarge', invalid_file: 'syncFileInvalid',
                invalid_filename: 'syncFileInvalid', invalid_file_name: 'syncFileInvalid',
                invalid_file_type: 'syncFileInvalid', invalid_file_size: 'syncFileInvalid',
                request_too_large: 'syncFileTooLarge', upload_expired: 'syncUploadFailed',
                upload_unavailable: 'syncUploadFailed', not_found: 'syncUploadFailed'
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
                headers: { 'Content-Type': 'application/json', ...options.headers, ...(session ? { Authorization: `Bearer ${session.token}` } : {}) },
                signal: options.signal || AbortSignal.timeout(15000)
            });
            const result = await response.json();
            if (!response.ok) throw Object.assign(new Error(result.error), { code: result.error, retryAfter: Number(response.headers.get('Retry-After')) });
            return result;
        };
        const roomPath = (suffix = '') => `/v1/spaces/${credentials.roomId}${suffix}`;
        const draftKey = () => `portfolio-sync-draft:${credentials.roomId}`;
        const saveDraft = () => {
            if (!credentials) return;
            const upload = pendingUpload && {
                clientId: pendingUpload.clientId, uploadId: pendingUpload.uploadId, text: pendingUpload.text, receivedBytes: pendingUpload.receivedBytes || 0,
                file: { name: pendingUpload.file.name, type: pendingUpload.file.type, size: pendingUpload.file.size, lastModified: pendingUpload.file.lastModified }
            };
            try { sessionStorage.setItem(draftKey(), JSON.stringify({ text: input.value, pending, upload })); }
            catch { setNotice('syncStorageError', true); }
        };
        const formatSize = (bytes) => bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${(bytes / 1024 ** 3).toFixed(1)} GB`;
        const updateSelectedFile = () => {
            const file = selectedFile || pendingUpload?.file;
            find('selected-file').hidden = !file;
            find('file-name').textContent = file?.name || '';
            find('file-size').textContent = file ? formatSize(file.size) : '';
            find('upload-status').hidden = !sending || !pendingUpload;
            if (sending && pendingUpload) {
                const percent = pendingUpload.file.size ? Math.floor((pendingUpload.receivedBytes || 0) / pendingUpload.file.size * 100) : 100;
                find('upload-status').textContent = translate(pendingUpload.stage || 'syncUploadProgress', { filename: pendingUpload.file.name, percent });
                find('upload-progress').value = percent;
            }
            find('upload-progress').hidden = !sending || !pendingUpload;
            updateControls();
        };
        const disposeAttachment = (id) => {
            attachmentRequests.get(id)?.controller.abort();
            attachmentRequests.delete(id);
            if (previewUrls.has(id)) URL.revokeObjectURL(previewUrls.get(id));
            previewUrls.delete(id);
            const item = messageNodes.get(id);
            const image = item?.querySelector('.sync-attachment-image');
            if (image) { image.hidden = true; image.removeAttribute('src'); }
            const button = item?.querySelector('[data-sync-preview-file]');
            if (button) button.textContent = translate('syncPreview');
        };
        const fetchAttachment = (message) => {
            if (attachmentRequests.has(message.id)) return attachmentRequests.get(message.id).promise;
            const session = credentials;
            const controller = new AbortController();
            const request = { controller };
            request.promise = (async () => {
                const base = await loadConfig();
                if (!base) throw Object.assign(new Error('unavailable'), { code: 'unavailable' });
                const response = await fetch(`${base}/v1/spaces/${session.roomId}/files/${message.id}`, {
                    headers: { Authorization: `Bearer ${session.token}` },
                    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120000)])
                });
                if (!response.ok) throw Object.assign(new Error('download'), { code: response.status === 404 ? 'attachment_expired' : 'download' });
                const blob = await response.blob();
                return credentials === session && messageNodes.has(message.id) ? blob : null;
            })().finally(() => {
                if (attachmentRequests.get(message.id) === request) attachmentRequests.delete(message.id);
            });
            attachmentRequests.set(message.id, request);
            return request.promise;
        };
        const showAttachmentError = (error) => {
            setNotice(['attachment_expired', 'not_found'].includes(error.code) ? 'syncAttachmentExpired' : 'syncDownloadFailed', true);
        };
        const downloadAttachment = async (message, button) => {
            const session = credentials;
            button.disabled = true;
            button.dataset.loading = 'true';
            button.textContent = translate('syncDownloading');
            try {
                const result = await api(`/v1/spaces/${session.roomId}/files/${message.id}/download`, { method: 'POST' }, session);
                if (credentials !== session || !messageNodes.has(message.id)) return;
                const base = await loadConfig();
                const frame = document.createElement('iframe');
                frame.hidden = true;
                frame.setAttribute('sandbox', 'allow-downloads');
                frame.src = `${base}/v1/spaces/${session.roomId}/downloads/${encodeURIComponent(result.ticket)}`;
                // Attachment responses start a native download; an HTML/JSON document means it failed.
                frame.addEventListener('load', () => {
                    if (credentials === session && messageNodes.has(message.id)) setNotice('syncDownloadFailed', true);
                    frame.remove();
                }, { once: true });
                document.body.append(frame);
                setTimeout(() => frame.remove(), 10 * 60 * 1000);
            } catch (error) {
                if (credentials === session && messageNodes.has(message.id) && error.name !== 'AbortError') showAttachmentError(error);
            } finally {
                button.disabled = false;
                delete button.dataset.loading;
                button.textContent = translate('syncDownload');
            }
        };
        const previewAttachment = async (message, button, image) => {
            if (previewUrls.has(message.id)) {
                disposeAttachment(message.id);
                return;
            }
            const session = credentials;
            button.disabled = true;
            try {
                const blob = await fetchAttachment(message);
                if (!blob) return;
                const url = URL.createObjectURL(new Blob([blob], { type: message.attachment.type }));
                previewUrls.set(message.id, url);
                image.src = url;
                await image.decode();
                if (credentials !== session || !active || previewUrls.get(message.id) !== url) return;
                image.hidden = false;
                button.textContent = translate('syncHidePreview');
            } catch (error) {
                disposeAttachment(message.id);
                if (credentials === session && active && messageNodes.has(message.id) && error.name !== 'AbortError') {
                    if (error.name === 'EncodingError') setNotice('syncPreviewFailed', true);
                    else showAttachmentError(error);
                }
            } finally { button.disabled = false; }
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
                if (!ids.has(id)) { disposeAttachment(id); item.remove(); messageNodes.delete(id); unread.delete(id); }
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
                    text.hidden = !message.text;
                    copy.hidden = !message.text;
                    item.append(meta, text);
                    if (message.attachment) {
                        const attachment = document.createElement('div');
                        attachment.className = 'sync-attachment';
                        const name = document.createElement('strong');
                        name.className = 'sync-attachment-name';
                        name.textContent = message.attachment.name;
                        const size = document.createElement('small');
                        size.className = 'sync-attachment-size';
                        size.textContent = formatSize(message.attachment.size);
                        const actions = document.createElement('div');
                        actions.className = 'sync-attachment-actions';
                        const download = document.createElement('button');
                        download.type = 'button';
                        download.className = 'sync-attachment-download';
                        download.dataset.syncDownloadFile = '';
                        download.addEventListener('click', () => downloadAttachment(message, download));
                        actions.append(download);
                        attachment.append(name, size, actions);
                        if (message.attachment.size <= MAX_PREVIEW_BYTES && ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'].includes(message.attachment.type)) {
                            const preview = document.createElement('button');
                            preview.type = 'button';
                            preview.className = 'sync-attachment-preview';
                            preview.dataset.syncPreviewFile = '';
                            const image = document.createElement('img');
                            image.className = 'sync-attachment-image';
                            image.alt = message.attachment.name;
                            image.hidden = true;
                            preview.addEventListener('click', () => previewAttachment(message, preview, image));
                            actions.prepend(preview);
                            attachment.append(image);
                        }
                        item.append(attachment);
                    }
                    messageNodes.set(message.id, item);
                }
                item.classList.toggle('is-own', message.deviceId === deviceId);
                const label = `${translate(message.deviceId === deviceId ? 'syncMessageYou' : 'syncMessageDevice')} · ${new Date(message.createdAt).toLocaleString(desktopApi.getLanguage())}`;
                if (item.firstChild.firstChild.textContent !== label) item.firstChild.firstChild.textContent = label;
                const copy = item.querySelector('[data-sync-copy-message]');
                copy.textContent = translate('syncCopy');
                const download = item.querySelector('[data-sync-download-file]');
                if (download) download.textContent = translate(download.dataset.loading ? 'syncDownloading' : 'syncDownload');
                const preview = item.querySelector('[data-sync-preview-file]');
                if (preview) preview.textContent = translate(previewUrls.has(message.id) ? 'syncHidePreview' : 'syncPreview');
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
                    uploadController?.abort(Object.assign(new Error('history_cleared'), { code: 'history_cleared' }));
                    pendingUpload = null;
                    saveDraft();
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
            uploadController?.abort();
            uploadController = null;
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
            selectedFile = null;
            pendingUpload = null;
            find('file-input').value = '';
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
            updateSelectedFile();
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
                pendingUpload = draft?.upload || null;
            } catch { input.value = ''; pending = null; pendingUpload = null; }
            if (session.code) showPairing(session);
            render();
            updateSelectedFile();
            connect();
        };
        const reconcileSession = () => {
            try {
                const saved = savedSession();
                if (!sameSession(saved, credentials)) {
                    if (saved) { enter(saved); setNotice(pendingUpload ? 'syncUploadRestored' : 'syncJoined'); }
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
                if (state === 'is-closed') {
                    active = false;
                    disconnect();
                    for (const id of new Set([...attachmentRequests.keys(), ...previewUrls.keys()])) disposeAttachment(id);
                }
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
        const discardUpload = () => {
            const upload = pendingUpload;
            pendingUpload = null;
            saveDraft();
            if (upload?.uploadId && credentials) {
                api(roomPath(`/files/uploads/${upload.uploadId}`), { method: 'DELETE' }).catch(() => {});
            }
        };
        const uploadAttachment = async (upload, session, controller) => {
            const path = `/v1/spaces/${session.roomId}/files/uploads`;
            upload.stage = 'syncPreparingUpload';
            updateSelectedFile();
            const result = await api(path, {
                method: 'POST',
                body: JSON.stringify({ clientId: upload.clientId, name: upload.file.name, type: upload.file.type || 'application/octet-stream', size: upload.file.size, text: upload.text }),
                signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)])
            }, session);
            if (credentials !== session || controller.signal.aborted || result.message) return;
            upload.uploadId = result.uploadId;
            upload.receivedBytes = result.receivedBytes;
            saveDraft();
            upload.stage = 'syncUploadProgress';
            updateSelectedFile();
            while (upload.receivedBytes < upload.file.size) {
                const offset = upload.receivedBytes;
                const chunk = upload.file.slice(offset, Math.min(offset + result.chunkSize, upload.file.size));
                let received;
                for (let attempt = 0; attempt < 3; attempt++) {
                    try {
                        received = await api(`${path}/${upload.uploadId}/chunks/${Math.floor(offset / result.chunkSize)}`, {
                            method: 'PUT', body: chunk, headers: { 'Content-Type': 'application/octet-stream' },
                            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(300000)])
                        }, session);
                        break;
                    } catch (error) {
                        if (controller.signal.aborted || credentials !== session || attempt === 2 || (error.code && !['storage_cleaning', 'rate_limited'].includes(error.code))) throw error;
                    }
                }
                if (credentials !== session || controller.signal.aborted) return;
                upload.receivedBytes = received.receivedBytes;
                updateSelectedFile();
            }
            upload.stage = 'syncCompletingUpload';
            updateSelectedFile();
            await api(`${path}/${upload.uploadId}/complete`, {
                method: 'POST', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)])
            }, session);
        };
        find('attach').addEventListener('click', () => find('file-input').click());
        find('file-input').addEventListener('change', () => {
            const file = find('file-input').files[0];
            if (!file) return;
            if (file.size > MAX_FILE_BYTES) {
                find('file-input').value = '';
                setNotice(selectedFile || pendingUpload ? 'syncFileTooLargeRetained' : 'syncFileTooLarge', true);
                return;
            }
            if (pendingUpload && !selectedFile) {
                if (['name', 'size', 'type', 'lastModified'].some((key) => file[key] !== pendingUpload.file[key])) {
                    find('file-input').value = '';
                    setNotice('syncWrongResumeFile', true);
                    return;
                }
                pendingUpload.file = file;
            } else discardUpload();
            selectedFile = file;
            saveDraft();
            updateSelectedFile();
        });
        find('remove-file').addEventListener('click', () => {
            discardUpload();
            selectedFile = null;
            find('file-input').value = '';
            updateSelectedFile();
        });
        find('cancel-upload').addEventListener('click', async () => {
            if (busy || !sending || !pendingUpload?.uploadId || !uploadController) return;
            const session = credentials;
            const uploadId = pendingUpload.uploadId;
            busy = true;
            uploadController.abort(Object.assign(new Error('upload_cancelled'), { code: 'upload_cancelled' }));
            updateSelectedFile();
            try {
                await api(`/v1/spaces/${session.roomId}/files/uploads/${uploadId}`, { method: 'DELETE' }, session);
                if (credentials === session) {
                    pendingUpload = null;
                    selectedFile = null;
                    find('file-input').value = '';
                    saveDraft();
                    setNotice('syncUploadCancelled');
                }
            } catch (error) { if (credentials === session) showError(error); }
            finally { if (credentials === session) { busy = false; updateSelectedFile(); } }
        });
        find('send-form').addEventListener('submit', async (event) => {
            event.preventDefault();
            if (busy || sending || !online || (!selectedFile && (pendingUpload || !input.value.trim())) || !find('send-form').reportValidity()) return;
            const text = input.value;
            const file = selectedFile;
            const session = credentials;
            if (file) {
                if (pendingUpload?.file !== file || pendingUpload.text !== text) {
                    discardUpload();
                    pendingUpload = { clientId: crypto.randomUUID(), file, text, receivedBytes: 0 };
                }
            } else if (pending?.text !== text) pending = { clientId: crypto.randomUUID(), text };
            saveDraft();
            sending = true;
            const controller = file ? new AbortController() : null;
            uploadController = controller;
            updateSelectedFile();
            setNotice('syncSending');
            try {
                if (file) await uploadAttachment(pendingUpload, session, controller);
                else await api(roomPath('/messages'), { method: 'POST', body: JSON.stringify(pending) });
                if (credentials !== session) return;
                controller?.signal.throwIfAborted();
                if (input.value === text) input.value = '';
                if (selectedFile === file) {
                    selectedFile = null;
                    pendingUpload = null;
                    find('file-input').value = '';
                }
                pending = null;
                saveDraft();
                setNotice('syncSent');
            } catch (error) {
                if (credentials === session) {
                    if (file && ['not_found', 'upload_unavailable'].includes(error.code)) pendingUpload = null;
                    saveDraft();
                    if (error.code === 'history_cleared') setNotice('syncCleared');
                    else if (error.code === 'upload_cancelled') return;
                    else if (file && !error.code) setNotice('syncUploadFailed', true);
                    else showError(error);
                }
            } finally {
                if (credentials === session) { sending = false; uploadController = null; updateSelectedFile(); }
            }
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
            updateSelectedFile();
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
