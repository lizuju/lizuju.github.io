import { createKeyring, createDeviceIdentity, encryptPayload, decryptPayload, createFileMetadata, encryptFileChunk,
    keyedFingerprint, FILE_PLAIN_CHUNK_SIZE, FILE_CIPHER_CHUNK_SIZE, saveLocalSession, loadLocalSession,
    deleteLocalSession, createKeyRotation, acceptKeyRotation } from './sync-crypto.js';
import { EncryptedPairing } from './sync-pairing.js';
import { openEncryptedFile } from './sync-e2ee-files.js';

(() => {
    const desktopApi = window.GavinDesktop;
    const CREDENTIAL_KEY = 'portfolio-sync-space-e2ee1';
    const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
    try {
        const old = JSON.parse(localStorage.getItem('portfolio-sync-space') || 'null');
        if (old?.roomId) sessionStorage.removeItem(`portfolio-sync-draft:${old.roomId}`);
        localStorage.removeItem('portfolio-sync-space');
    } catch { /* Storage availability is reported when opening a space. */ }

    desktopApi.apps.syncSpace = (manager, attachmentPreview) => {
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
        let historyState = null;
        let reconnectCursor = null;
        let loadingOlder = false;
        let historyRequest = 0;
        let searchTimer;
        let searchController;
        let catchupController;
        let catchingUp = false;
        let socket = null;
        let retryTimer = null;
        let pingTimer = null;
        let countdownTimer = null;
        let pairExpiresAt = 0;
        let pairingRevision = 0;
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
        let searchScrollTop = null;
        let searchAnchor = null;
        let fileDragDepth = 0;
        let previewRequest = 0;
        const downloadTickets = new Map();
        const fileCapabilities = new Map();
        let keyRefresh;
        let draftRevision = 0;
        let rotationTask;

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
            find('cancel-upload').disabled = busy || !uploadController || pendingUpload?.completing || uploadController.signal.aborted;
            find('copy-code').disabled = secondsLeft(pairExpiresAt) === 0;
            find('history-more').hidden = !historyState || !history.length || history[0].id <= historyState.oldestId;
            find('history-more').disabled = !online || loadingOlder;
            setText(find('history-more'), loadingOlder ? 'syncLoadingOlder' : 'syncLoadOlder');
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
                find('pair-code').textContent = '';
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
                invalid_name: 'syncDeviceNameTooLong',
                storage_full: 'syncStorageFull', storage_cleaning: 'syncStorageCleaning',
                file_too_large: 'syncFileTooLarge', invalid_file: 'syncFileInvalid',
                invalid_filename: 'syncFileInvalid', invalid_file_name: 'syncFileInvalid',
                invalid_file_type: 'syncFileInvalid', invalid_file_size: 'syncFileInvalid',
                request_too_large: 'syncFileTooLarge', upload_expired: 'syncUploadFailed',
                upload_unavailable: 'syncUploadFailed', not_found: 'syncUploadFailed',
                upload_conflict: 'syncUploadConflict',
                invalid_ciphertext: 'syncDecryptFailed', key_unavailable: 'syncKeyUnavailable', key_changed: 'syncKeyChanged', rekey_required: 'syncKeyChanged',
                pairing_limited: 'syncPairLimited', pairing_ambiguous: 'syncPairAmbiguous', pairing_busy: 'syncPairBusy',
                encryption_unavailable: 'syncEncryptionUnavailable'
            };
            if (error.code === 'rate_limited' && action && error.retryAfter > 0) {
                cooldowns[action] = Date.now() + error.retryAfter * 1000;
                startCountdowns();
            }
            setNotice(keys[error.code] || 'syncError', true);
        };
        const decodeMessage = async (message, session) => {
            try {
                const payload = await decryptPayload(session.keyring, session.roomId, `message:${message.deviceId}:${message.clientId}`, message.text);
                if (typeof payload.text !== 'string' || payload.text.length > 10000) throw new Error('invalid_message');
                if (payload.attachment && (typeof payload.attachment.name !== 'string' || typeof payload.attachment.key !== 'string'
                    || !Number.isSafeInteger(payload.attachment.size) || payload.attachment.size < 0 || payload.attachment.size > MAX_FILE_BYTES)) throw new Error('invalid_attachment');
                return { ...message, text: payload.text, attachment: payload.attachment || null };
            } catch {
                setNotice('syncDecryptFailed', true);
                return { ...message, text: translate('syncDecryptFailed'), attachment: null, decryptionFailed: true };
            }
        };
        const api = async (path, options = {}, session = credentials) => {
            const base = await loadConfig();
            if (!base) throw Object.assign(new Error('unavailable'), { code: 'unavailable' });
            const headers = { 'Content-Type': 'application/json', ...(session ? {
                Authorization: `Bearer ${session.token}`, 'X-Sync-Key-Id': session.keyring.currentKeyId
            } : {}), ...options.headers };
            const signal = options.signal || AbortSignal.timeout(15000);
            const response = options.uploadProgress ? await new Promise((resolve, reject) => {
                signal.throwIfAborted();
                const xhr = new XMLHttpRequest();
                const cleanup = () => signal.removeEventListener('abort', abort);
                const abort = () => { xhr.abort(); cleanup(); reject(signal.reason); };
                xhr.open(options.method, base + path);
                for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
                xhr.upload.addEventListener('progress', (event) => options.uploadProgress(event.loaded));
                xhr.addEventListener('load', () => {
                    cleanup();
                    resolve(new Response(xhr.responseText, { status: xhr.status, headers: { 'Retry-After': xhr.getResponseHeader('Retry-After') || '' } }));
                });
                xhr.addEventListener('error', () => { cleanup(); reject(new TypeError('Upload network request failed')); });
                signal.addEventListener('abort', abort, { once: true });
                xhr.send(options.body);
            }) : await fetch(base + path, { ...options, headers, signal });
            const result = await response.json();
            if (!response.ok) {
                if (result.error === 'key_changed' && session === credentials) await refreshKeys(session);
                const retryAfter = response.headers.get('Retry-After');
                const seconds = Number(retryAfter);
                throw Object.assign(new Error(result.error), {
                    code: result.error,
                    retryAfter: Number.isFinite(seconds) ? seconds : Math.max(0, (Date.parse(retryAfter) - Date.now()) / 1000)
                });
            }
            if (session?.keyring) {
                if (result.messages) result.messages = await Promise.all(result.messages.map(message => decodeMessage(message, session)));
                if (result.message) result.message = await decodeMessage(result.message, session);
                if (result.clientId && result.text) return decodeMessage(result, session);
                if (result.devices) result.devices = await Promise.all(result.devices.map(async (device) => {
                    const profile = device.name ? await decryptPayload(session.keyring, session.roomId, `device:${device.deviceId}`, device.name) : { name: '', publicKey: '' };
                    if (typeof profile.name !== 'string' || Array.from(profile.name).length > 8) throw new Error('invalid_device');
                    return { ...device, name: profile.name, publicKey: profile.publicKey };
                }));
            }
            return result;
        };
        const persistSession = async (session) => {
            const descriptor = await saveLocalSession(session);
            session.vaultId = descriptor.vaultId;
            session.revision = crypto.randomUUID();
            localStorage.setItem(CREDENTIAL_KEY, JSON.stringify({ ...descriptor, revision: session.revision }));
        };
        const pairing = new EncryptedPairing({ api, getSession: () => credentials, onAccepted: async (session) => {
            if (credentials !== session) return;
            await refreshKeys(session);
        }, onExpired: () => {
            if (!credentials) return;
            api(roomPath('/pair-code'), { method: 'DELETE' }).catch(() => {});
            pairExpiresAt = 0;
            find('pairing').hidden = true;
            setNotice('syncPairLimited', true);
        } });
        const refreshKeys = (session = credentials) => {
            if (keyRefresh?.session === session) return keyRefresh.promise;
            const entry = { session };
            entry.promise = (async () => {
                const revoked = new Set(session.revokedDevices);
                for (;;) {
                    const result = await api(`/v1/spaces/${session.roomId}/key-grants`, {}, session);
                    if (credentials !== session) return;
                    for (const grant of result.grants) {
                        const next = await acceptKeyRotation(session, grant);
                        session.keyring = next.keyring;
                        session.trustedDevices = next.trustedDevices;
                        session.revokedDevices = next.revokedDevices;
                        if (pendingUpload && session.revokedDevices.some(id => !revoked.has(id))) {
                            uploadController?.abort(Object.assign(new Error('key_changed'), { code: 'key_changed' }));
                            discardUpload();
                        }
                    }
                    if (result.grants.length) {
                        await persistSession(session);
                        await api(`/v1/spaces/${session.roomId}/key-grants`, { method: 'DELETE', body: JSON.stringify({ through: result.grants.at(-1).id }) }, session);
                        pairing.reset();
                    }
                    if (!result.hasMore) break;
                }
            })().finally(() => { if (keyRefresh === entry) keyRefresh = null; });
            keyRefresh = entry;
            return entry.promise;
        };
        const roomPath = (suffix = '') => `/v1/spaces/${credentials.roomId}${suffix}`;
        const draftKey = () => `portfolio-sync-draft:${credentials.roomId}`;
        const saveDraft = () => {
            if (!credentials) return;
            const session = credentials;
            const revision = ++draftRevision;
            const upload = pendingUpload && {
                clientId: pendingUpload.clientId, uploadId: pendingUpload.uploadId, text: pendingUpload.text, fingerprint: pendingUpload.fingerprint, receivedBytes: pendingUpload.receivedBytes || 0,
                encryption: pendingUpload.encryption, encryptedText: pendingUpload.encryptedText, keyId: pendingUpload.keyId, revokedDevices: pendingUpload.revokedDevices,
                file: { name: pendingUpload.file.name, type: pendingUpload.file.type, size: pendingUpload.file.size, lastModified: pendingUpload.file.lastModified }
            };
            const key = draftKey();
            return encryptPayload(session.keyring, session.roomId, `draft:${session.deviceId}`, { text: input.value, pending, upload })
                .then(encrypted => { if (revision === draftRevision) sessionStorage.setItem(key, encrypted); })
                .catch(() => { if (credentials === session) setNotice('syncStorageError', true); });
        };
        const formatSize = (bytes) => bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${(bytes / 1024 ** 3).toFixed(1)} GB`;
        const updateSelectedFile = () => {
            const file = selectedFile || pendingUpload?.file;
            find('selected-file').hidden = !file;
            find('file-name').textContent = file?.name || '';
            find('file-size').textContent = file ? formatSize(file.size) : '';
            find('upload-status').hidden = !sending || !pendingUpload;
            if (sending && pendingUpload) {
                const wireBytes = (pendingUpload.receivedBytes || 0) + (pendingUpload.inflightBytes || 0);
                const transferred = Math.min(pendingUpload.file.size, Math.floor(wireBytes / FILE_CIPHER_CHUNK_SIZE) * FILE_PLAIN_CHUNK_SIZE + Math.min(wireBytes % FILE_CIPHER_CHUNK_SIZE, FILE_PLAIN_CHUNK_SIZE));
                const percent = pendingUpload.file.size ? Math.floor(transferred / pendingUpload.file.size * 100) : 100;
                let text = translate(pendingUpload.stage || 'syncUploadProgress', { filename: pendingUpload.file.name, percent });
                if (pendingUpload.stage === 'syncUploadWaiting') text = translate('syncUploadWaiting', { seconds: Math.max(1, Math.ceil((pendingUpload.retryAt - Date.now()) / 1000)) });
                if (pendingUpload.stage === 'syncUploadProgress') {
                    text += ` · ${pendingUpload.bytesPerSecond > 0 ? translate('syncUploadRate', {
                        speed: formatSize(pendingUpload.bytesPerSecond),
                        seconds: Math.ceil((pendingUpload.file.size - transferred) / pendingUpload.bytesPerSecond)
                    }) : translate('syncUploadRatePending')}`;
                }
                find('upload-status').textContent = text;
                find('upload-progress').value = percent;
            }
            find('upload-progress').hidden = !sending || !pendingUpload;
            updateControls();
        };
        const disposeAttachment = (id) => {
            downloadTickets.delete(id);
            for (const [key, promise] of fileCapabilities) {
                if (!key.startsWith(`${id}:`)) continue;
                promise.then(capability => capability.dispose()).catch(() => {});
                fileCapabilities.delete(key);
            }
            attachmentPreview.remove(id);
        };
        const previewKind = (attachment) => {
            const type = attachment.type;
            const extension = attachment.name.split('.').pop().toLowerCase();
            if (['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence'].includes(type) || ['heic', 'heif', 'hif'].includes(extension)) return 'heic';
            if (['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'].includes(type) || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif'].includes(extension)) return 'image';
            if (['video/mp4', 'video/webm', 'video/ogg'].includes(type) || ['mp4', 'webm', 'ogg', 'ogv'].includes(extension)) return 'video';
            if (type === 'application/pdf' || extension === 'pdf') return 'pdf';
            if (extension === 'docx') return 'word';
            if (['xlsx', 'xls', 'ods', 'csv', 'tsv'].includes(extension)) return 'spreadsheet';
            if (['txt', 'md', 'json', 'log', 'xml', 'yaml', 'yml'].includes(extension)) return 'text';
            return null;
        };
        const showAttachmentError = (error) => {
            setNotice(['attachment_expired', 'not_found'].includes(error.code) ? 'syncAttachmentExpired' : 'syncDownloadFailed', true);
        };
        const attachmentTicket = async (message, session) => {
            let entry = downloadTickets.get(message.id);
            if (!entry || entry.session !== session || (entry.expiresAt && entry.expiresAt <= Date.now() + 60000)) {
                entry = { session };
                entry.promise = api(`/v1/spaces/${session.roomId}/files/${message.id}/download`, { method: 'POST' }, session)
                    .then((result) => { entry.expiresAt = result.expiresAt; return result; })
                    .catch((error) => {
                        if (downloadTickets.get(message.id) === entry) downloadTickets.delete(message.id);
                        throw error;
                    });
                downloadTickets.set(message.id, entry);
            }
            return entry.promise;
        };
        const attachmentUrl = async (message, session) => {
            const base = await loadConfig();
            for (let attempt = 0; attempt < 2; attempt++) {
                const result = await attachmentTicket(message, session);
                const url = `${base}/v1/spaces/${session.roomId}/downloads/${encodeURIComponent(result.ticket)}`;
                const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(15000) });
                if (response.ok) return url;
                if ([401, 404].includes(response.status)) {
                    downloadTickets.delete(message.id);
                    if (!attempt) continue;
                }
                throw Object.assign(new Error('download_unavailable'), { code: response.status === 404 ? 'attachment_expired' : 'download_unavailable' });
            }
        };
        const encryptedFile = async (message, session, download) => {
            const key = `${message.id}:${crypto.randomUUID()}`;
            {
                const promise = attachmentUrl(message, session)
                    .then(url => openEncryptedFile({ url, metadata: message.attachment, download }))
                    .then(capability => {
                        if (credentials !== session || !messageNodes.has(message.id)) { capability.dispose(); throw new DOMException('Session ended', 'AbortError'); }
                        const dispose = capability.dispose;
                        capability.dispose = () => {
                            dispose();
                            if (fileCapabilities.get(key) === promise) fileCapabilities.delete(key);
                        };
                        capability.closed.then(() => { if (fileCapabilities.get(key) === promise) fileCapabilities.delete(key); });
                        return capability;
                    }).catch(error => { if (fileCapabilities.get(key) === promise) fileCapabilities.delete(key); throw error; });
                fileCapabilities.set(key, promise);
            }
            return fileCapabilities.get(key);
        };
        const downloadAttachment = async (message, button) => {
            const session = credentials;
            button.disabled = true;
            button.dataset.loading = 'true';
            button.textContent = translate('syncDownloading');
            try {
                const capability = await encryptedFile(message, session, true);
                if (credentials !== session || !messageNodes.has(message.id)) { capability.dispose(); return; }
                const frame = document.createElement('iframe');
                frame.hidden = true;
                frame.src = capability.url;
                frame.addEventListener('load', () => frame.remove(), { once: true });
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
        const previewAttachment = async (message, button) => {
            const session = credentials;
            const request = ++previewRequest;
            const kind = previewKind(message.attachment);
            const limit = ['image', 'heic'].includes(kind) ? 20 : kind === 'text' ? 2 : 25;
            if (!['pdf', 'video'].includes(kind) && message.attachment.size > limit * 1024 * 1024) {
                setNotice('syncPreviewTooLarge', true);
                return;
            }
            button.disabled = true;
            try {
                const capability = await encryptedFile(message, session, false);
                if (request !== previewRequest || credentials !== session || !active || !messageNodes.has(message.id)) { capability.dispose(); return; }
                if (!app.classList.contains('is-active')) { capability.dispose(); setNotice('syncPreviewReady'); return; }
                attachmentPreview.open({
                    id: message.id, name: message.attachment.name, kind,
                    url: capability.url, cleanup: capability.dispose
                });
            } catch (error) {
                if (credentials === session && active && messageNodes.has(message.id)) showAttachmentError(error);
            } finally { button.disabled = false; }
        };
        const atBottom = () => feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
        const isReading = () => active && !document.hidden && app.classList.contains('is-active') && !app.classList.contains('is-minimized') && !find('search').value.trim() && !devicesDialog.open && !confirmation.open;
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
        const applySearch = () => {
            const query = find('search').value.trim().toLocaleLowerCase();
            let count = 0;
            for (const message of history) {
                const name = devices.find((device) => device.deviceId === message.deviceId)?.name
                    || translate(message.deviceId === deviceId ? 'syncMessageYou' : 'syncMessageDevice');
                const match = !query || [message.text, message.attachment?.name || '', name].some((value) => value.toLocaleLowerCase().includes(query));
                messageNodes.get(message.id).hidden = !match;
                if (match) count++;
            }
            find('empty').hidden = history.length !== 0 || !!query;
            find('no-results').hidden = !query || count !== 0;
            setText(find('no-results'), searchController && !searchController.signal.aborted ? 'syncSearching'
                : historyState && history[0]?.id > historyState.oldestId ? 'syncSearchIncomplete' : 'syncNoResults');
        };
        const render = (scroll = false, preserve = false) => {
            const follow = !preserve && (scroll || (atBottom() && isReading()));
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
                    copy.hidden = !message.text || message.decryptionFailed;
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
                        if (previewKind(message.attachment)) {
                            const preview = document.createElement('button');
                            preview.type = 'button';
                            preview.className = 'sync-attachment-preview';
                            preview.dataset.syncPreviewFile = '';
                            preview.addEventListener('click', () => previewAttachment(message, preview));
                            actions.prepend(preview);
                        }
                        item.append(attachment);
                    }
                    messageNodes.set(message.id, item);
                }
                item.classList.toggle('is-own', message.deviceId === deviceId);
                const name = devices.find((device) => device.deviceId === message.deviceId)?.name
                    || translate(message.deviceId === deviceId ? 'syncMessageYou' : 'syncMessageDevice');
                const label = `${name} · ${new Date(message.createdAt).toLocaleString(desktopApi.getLanguage())}`;
                if (item.firstChild.firstChild.textContent !== label) item.firstChild.firstChild.textContent = label;
                const copy = item.querySelector('[data-sync-copy-message]');
                copy.textContent = translate('syncCopy');
                const download = item.querySelector('[data-sync-download-file]');
                if (download) download.textContent = translate(download.dataset.loading ? 'syncDownloading' : 'syncDownload');
                const preview = item.querySelector('[data-sync-preview-file]');
                if (preview) preview.textContent = translate('syncPreview');
                if (messages.children[index] !== item) messages.insertBefore(item, messages.children[index] || null);
            });
            applySearch();
            if (follow) feed.scrollTop = feed.scrollHeight;
            markRead();
            updateUnread();
            updateControls();
        };
        const reconcileUpload = (incoming) => {
            const upload = pendingUpload;
            if (!upload || !incoming.some((message) => message.clientId === upload.clientId && message.deviceId === deviceId)) return;
            upload.confirmed = true;
            pendingUpload = null;
            if (input.value === upload.text) input.value = '';
            if (selectedFile === upload.file) {
                selectedFile = null;
                find('file-input').value = '';
            }
            uploadController?.abort();
            saveDraft();
            updateSelectedFile();
            setNotice('syncSent');
        };
        const receiveHistory = (incoming, initial = false, mode = 'replace', metadata = null) => {
            reconcileUpload(incoming);
            const known = new Set(history.map((message) => message.id));
            if (!initial && mode !== 'prepend' && !(isReading() && atBottom())) {
                incoming.forEach((message) => { if (!known.has(message.id) && message.deviceId !== deviceId) unread.add(message.id); });
            }
            const scrollTop = feed.scrollTop;
            const previousHeight = feed.scrollHeight;
            if (mode === 'replace') {
                searchController?.abort();
                catchupController?.abort();
                catchingUp = false;
                historyRequest++;
                loadingOlder = false;
                history = incoming;
            } else history = [...history, ...incoming.filter((message) => !known.has(message.id))].sort((a, b) => a.id - b.id);
            if (metadata) {
                historyState = historyState?.generation === metadata.generation
                    ? { ...metadata, latestId: Math.max(historyState.latestId || 0, metadata.latestId || 0) || null }
                    : metadata;
                history = history.filter((message) => metadata.oldestId === null || message.id >= metadata.oldestId);
            }
            if (mode !== 'prepend') reconnectCursor = metadata?.continuationId ?? incoming.at(-1)?.id ?? null;
            render(initial, mode === 'prepend');
            if (mode === 'prepend') {
                const addedHeight = feed.scrollHeight - previousHeight;
                if (searchScrollTop !== null) searchScrollTop += addedHeight;
                feed.scrollTop = scrollTop + addedHeight;
            }
            if (mode === 'replace' && find('search').value.trim()) {
                clearTimeout(searchTimer);
                searchTimer = setTimeout(searchHistory, 180);
            }
        };
        const loadOlder = async (signal) => {
            if (!online || loadingOlder || !history.length || !historyState || history[0].id <= historyState.oldestId) return false;
            const session = credentials;
            const request = ++historyRequest;
            const firstId = history[0].id;
            loadingOlder = true;
            updateControls();
            try {
                const query = new URLSearchParams({ before: firstId, generation: historyState.generation, limit: 50 });
                const result = await api(roomPath(`/messages?${query}`), signal ? { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) } : {});
                if (credentials !== session || request !== historyRequest || signal?.aborted) return false;
                receiveHistory(result.messages, false, result.historyMode, result.history);
                return history.length > 0 && history[0].id < firstId;
            } catch (error) {
                if (credentials === session && request === historyRequest && error.name !== 'AbortError') showError(error);
                return false;
            } finally {
                if (credentials === session && request === historyRequest) { loadingOlder = false; updateControls(); }
            }
        };
        const searchHistory = async () => {
            if (!find('search').value.trim() || !active || !online) return;
            if (loadingOlder) { searchTimer = setTimeout(searchHistory, 180); return; }
            searchController?.abort();
            const controller = new AbortController();
            searchController = controller;
            applySearch();
            try {
                for (let page = 0; page < 10 && !controller.signal.aborted; page++) {
                    if (!await loadOlder(controller.signal)) break;
                }
            } finally {
                if (searchController === controller) { searchController = null; applySearch(); }
            }
        };
        const catchUp = async (metadata) => {
            catchupController?.abort();
            if (!metadata?.hasNewer) { catchupController = null; catchingUp = false; return; }
            const controller = new AbortController();
            catchupController = controller;
            catchingUp = true;
            const session = credentials;
            let cursor = metadata.continuationId;
            try {
                for (let page = 0; page < 10 && !controller.signal.aborted; page++) {
                    const query = new URLSearchParams({ after: cursor, generation: metadata.generation, limit: 50 });
                    const result = await api(roomPath(`/messages?${query}`), { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) }, session);
                    if (credentials !== session || controller.signal.aborted) return;
                    receiveHistory(result.messages, false, result.historyMode, result.history);
                    if (!result.history.hasNewer) { catchingUp = false; return; }
                    if (result.history.continuationId <= cursor) break;
                    cursor = result.history.continuationId;
                }
            } catch (error) {
                if (credentials === session && !controller.signal.aborted) showError(error);
            } finally {
                if (catchupController === controller) {
                    catchupController = null;
                    if (catchingUp && !controller.signal.aborted && credentials === session) socket?.close();
                }
            }
        };
        const addMessage = (message, metadata = null, advanceCursor = true) => {
            reconcileUpload([message]);
            const known = history.some((item) => item.id === message.id);
            if (metadata) {
                if (historyState && metadata.generation !== historyState.generation) {
                    searchController?.abort();
                    catchupController?.abort();
                    if (catchingUp) socket?.close();
                    historyRequest++;
                    loadingOlder = false;
                }
                historyState = metadata;
                history = history.filter((item) => item.id >= metadata.oldestId);
            }
            if (advanceCursor && !catchingUp) reconnectCursor = Math.max(reconnectCursor || 0, message.id);
            if (known) { render(); return; }
            if (message.deviceId !== deviceId && !(isReading() && atBottom())) unread.add(message.id);
            history = [...history, message].sort((a, b) => a.id - b.id).slice(-500);
            render();
        };
        const disconnect = () => {
            searchController?.abort();
            catchupController?.abort();
            catchupController = null;
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
            retryTimer = setTimeout(connect, retryDelay + Math.random() * retryDelay * 0.25);
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
            if (historyState && reconnectCursor !== null) {
                url.searchParams.set('after', reconnectCursor);
                url.searchParams.set('generation', historyState.generation);
            }
            url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
            const connection = new WebSocket(url, ['sync', `auth.${session.token}`]);
            let incoming = Promise.resolve();
            let awaitingPong = false;
            let authenticated = false;
            let initialized = false;
            socket = connection;
            connection.addEventListener('open', () => {
                if (socket === connection) connection.send(JSON.stringify({ type: 'auth', token: session.token }));
            });
            const receive = async (event) => {
                if (socket !== connection) return;
                if (event.data === 'pong') { awaitingPong = false; return; }
                let data;
                try { data = JSON.parse(event.data); } catch { return; }
                if (data.type === 'ready') {
                    authenticated = true;
                    const initial = deviceId === null;
                    deviceId = data.deviceId;
                    await refreshKeys(session);
                    if (data.rekeyRequired) await rotateKeys(null);
                    if (socket !== connection || credentials !== session) return;
                    retryDelay = 1000;
                    await showPairing(data.pairing);
                    receiveHistory(await Promise.all(data.messages.map(message => decodeMessage(message, session))), initial, data.historyMode, data.history);
                    catchUp(data.history);
                    if (find('search').value.trim()) {
                        clearTimeout(searchTimer);
                        searchTimer = setTimeout(searchHistory, 180);
                    }
                    if (notice.dataset.i18n === 'syncUnavailable') setNotice('syncJoined');
                    loadDevices();
                    pairing.resume().catch(error => { if (credentials === session && error.code !== 'invalid_code') showError(error); });
                    clearInterval(pingTimer);
                    pingTimer = setInterval(() => {
                        if (awaitingPong) connection.close();
                        else if (connection.readyState === WebSocket.OPEN) {
                            awaitingPong = true;
                            connection.send('ping');
                        }
                    }, 30000);
                    initialized = true;
                    setConnection(true);
                } else if (data.type === 'message') addMessage(await decodeMessage(data.message, session), data.history);
                else if (data.type === 'pairing') await showPairing(data.pairing);
                else if (data.type === 'pair-request' || data.type === 'pair-finish') await pairing.handle(data);
                else if (data.type === 'key-rotation') { await refreshKeys(session); await loadDevices(); }
                else if (data.type === 'rekey-required') await rotateKeys(null);
                else if (data.type === 'history') receiveHistory(await Promise.all(data.messages.map(message => decodeMessage(message, session))), false, data.historyMode, data.history);
                else if (data.type === 'devices') loadDevices();
                else if (data.type === 'cleared') {
                    uploadController?.abort(Object.assign(new Error('history_cleared'), { code: 'history_cleared' }));
                    pendingUpload = null;
                    saveDraft();
                    unread.clear();
                    receiveHistory([], false, 'replace', data.history);
                    setNotice('syncCleared');
                }
            };
            connection.addEventListener('message', event => {
                incoming = incoming.then(() => receive(event)).catch(error => {
                    if (credentials === session && socket === connection) {
                        if (error.code !== 'invalid_code') showError(error);
                        if (!initialized) connection.close();
                    }
                });
            });
            connection.addEventListener('close', async (event) => {
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
                if (!authenticated && event.code === 1006) {
                    try { await api(`/v1/spaces/${session.roomId}/devices`, {}, session); }
                    catch (error) {
                        if (credentials !== session) return;
                        if (['unauthorized', 'not_found'].includes(error.code)) {
                            reset();
                            setNotice('syncRejoin', true);
                            reconcileSession();
                            return;
                        }
                    }
                }
                if (credentials === session) retry();
            });
        };
        const showPairing = async (value) => {
            const revision = ++pairingRevision;
            const session = credentials;
            const offer = await pairing.readOffer(value, session);
            if (revision !== pairingRevision || session !== credentials) return;
            pairExpiresAt = offer?.expiresAt || 0;
            find('pairing').hidden = !offer;
            find('pair-code').textContent = offer?.code || '';
            startCountdowns();
        };
        const savedSession = () => {
            const saved = JSON.parse(localStorage.getItem(CREDENTIAL_KEY) || 'null');
            return typeof saved?.roomId === 'string' && typeof saved?.token === 'string' && typeof saved?.vaultId === 'string' ? saved : null;
        };
        const sameSession = (a, b) => a?.roomId === b?.roomId && a?.token === b?.token && a?.revision === b?.revision;
        const reset = (forget = true) => {
            previewRequest++;
            downloadTickets.clear();
            fileCapabilities.forEach(promise => promise.then(capability => capability.dispose()).catch(() => {}));
            fileCapabilities.clear();
            pairing.reset();
            attachmentPreview.close();
            if (confirmation.open) confirmation.close();
            if (devicesDialog.open) devicesDialog.close();
            disconnect();
            uploadController?.abort();
            uploadController = null;
            if (forget) {
                try { if (sameSession(savedSession(), credentials)) localStorage.removeItem(CREDENTIAL_KEY); }
                catch { /* Storage may be blocked. */ }
                if (credentials?.vaultId) deleteLocalSession(credentials.vaultId).catch(() => {});
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
            historyState = null;
            reconnectCursor = null;
            catchingUp = false;
            historyRequest++;
            loadingOlder = false;
            input.value = '';
            find('search').value = '';
            searchScrollTop = null;
            searchAnchor = null;
            fileDragDepth = 0;
            app.classList.remove('is-dragging-files');
            busy = false;
            sending = false;
            leavingSession = null;
            followOnRestore = true;
            pairExpiresAt = 0;
            pairingRevision++;
            cooldowns.pair = 0;
            unread.clear();
            find('pairing').hidden = true;
            find('pair-code').textContent = '';
            room.hidden = true;
            setup.hidden = false;
            render();
            updateSelectedFile();
            updateCountdowns();
        };
        const enter = async (session) => {
            saveDraft();
            reset(false);
            credentials = session;
            setup.hidden = true;
            room.hidden = false;
            try {
                const encrypted = sessionStorage.getItem(draftKey());
                const draft = encrypted ? await decryptPayload(session.keyring, session.roomId, `draft:${session.deviceId}`, encrypted) : null;
                if (credentials !== session) return;
                input.value = draft?.text || '';
                pending = draft?.pending || null;
                pendingUpload = draft?.upload || null;
                if (pendingUpload && session.revokedDevices.some(id => !(pendingUpload.revokedDevices || []).includes(id))) pendingUpload = null;
            } catch { input.value = ''; pending = null; pendingUpload = null; }
            showPairing(session.pairing);
            render();
            updateSelectedFile();
            connect();
        };
        const reconcileSession = async () => {
            try {
                const saved = savedSession();
                if (!sameSession(saved, credentials)) {
                    if (saved) {
                        const version = sessionVersion;
                        const session = await loadLocalSession(saved);
                        if (version !== sessionVersion) return;
                        await enter({ ...session, revision: saved.revision });
                        setNotice(pendingUpload ? 'syncUploadRestored' : 'syncJoined');
                    }
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
                    const limitName = (event) => {
                        if (event.isComposing) return;
                        const characters = Array.from(name.value);
                        if (characters.length > 8) name.value = characters.slice(0, 8).join('');
                    };
                    name.addEventListener('input', limitName);
                    name.addEventListener('compositionend', limitName);
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
            const showStatus = devicesDialog.open;
            if (showStatus) setText(find('devices-status'), 'syncDevicesLoading');
            try {
                const result = await api(roomPath('/devices'));
                if (credentials !== session || request !== deviceRequest) return false;
                devices = result.devices.filter(device => session.trustedDevices[device.deviceId]
                    && !session.revokedDevices.includes(device.deviceId)
                    && session.trustedDevices[device.deviceId] === device.publicKey);
                deviceId = result.deviceId;
                renderDevices();
                render();
                if (showStatus) {
                    find('devices-status').textContent = '';
                    find('devices-status').dataset.i18n = '';
                }
                return true;
            } catch {
                if (credentials === session && request === deviceRequest && showStatus) setText(find('devices-status'), 'syncDevicesError', 'error');
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
                followOnRestore = !find('search').value.trim() && atBottom();
                if (confirmation.open) confirmation.close();
                if (devicesDialog.open) devicesDialog.close();
                manager.hideWindow(app, entry.task, state, { hideTask: state === 'is-closed' });
                if (state === 'is-closed') {
                    clearTimeout(searchTimer);
                    previewRequest++;
                    active = false;
                    fileDragDepth = 0;
                    app.classList.remove('is-dragging-files');
                    disconnect();
                    attachmentPreview.close();
                }
            }
        });
        document.querySelectorAll('[data-open-sync-space]').forEach((button) => button.addEventListener('click', entry.show));
        const pair = async (path, body, action) => {
            if (busy || sending || secondsLeft(cooldowns[action])) return;
            let version = sessionVersion;
            busy = true;
            updateControls();
            setNotice(action === 'create' ? 'syncCreating' : 'syncJoining');
            try {
                // Check persistence without replacing another tab's paired session.
                const previous = localStorage.getItem(CREDENTIAL_KEY);
                if (previous !== null) localStorage.setItem(CREDENTIAL_KEY, previous);
                else { localStorage.setItem(CREDENTIAL_KEY, 'null'); localStorage.removeItem(CREDENTIAL_KEY); }
                let session;
                if (action === 'create') {
                    const [keyring, identity] = await Promise.all([createKeyring(), createDeviceIdentity()]);
                    session = { ...await api(path, { method: 'POST', body: JSON.stringify({ keyId: keyring.currentKeyId }) }, null), keyring, identity, trustedDevices: {}, revokedDevices: [] };
                    session.trustedDevices[session.deviceId] = identity.publicKey;
                    const name = await encryptPayload(keyring, session.roomId, `device:${session.deviceId}`, { name: '', publicKey: identity.publicKey });
                    await api(`/v1/spaces/${session.roomId}/devices/${session.deviceId}`, { method: 'PATCH', body: JSON.stringify({ name }) }, session);
                } else session = await pairing.join(body.code);
                if (version !== sessionVersion) return;
                await persistSession(session);
                await enter(session);
                version = sessionVersion;
                busy = true;
                updateControls();
                if (action === 'create') await showPairing(await pairing.createOffer());
                setNotice(action === 'create' ? 'syncPaired' : 'syncJoined');
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
            const revision = pairingRevision;
            busy = true;
            updateControls();
            try {
                const offer = await pairing.createOffer();
                if (credentials !== session) return;
                if (pairingRevision === revision) await showPairing(offer);
                if (secondsLeft(pairExpiresAt)) setNotice('syncPaired');
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
            upload.completing = false;
            const request = async (url, options, timeout) => {
                for (let attempt = 0; ; attempt++) {
                    controller.signal.throwIfAborted();
                    try {
                        return await api(url, {
                            ...options, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)])
                        }, session);
                    } catch (error) {
                        if (controller.signal.aborted || credentials !== session || attempt === 2 || (error.code && !['storage_cleaning', 'rate_limited'].includes(error.code))) throw error;
                        upload.inflightBytes = 0;
                        const stage = upload.stage;
                        upload.retryAt = Date.now() + Math.max(error.retryAfter || 0, 2 ** attempt) * 1000;
                        upload.stage = 'syncUploadWaiting';
                        updateSelectedFile();
                        const countdown = setInterval(updateSelectedFile, 1000);
                        try {
                            await new Promise((resolve, reject) => {
                                const finish = () => { controller.signal.removeEventListener('abort', abort); resolve(); };
                                const timer = setTimeout(finish, upload.retryAt - Date.now());
                                const abort = () => { clearTimeout(timer); reject(controller.signal.reason); };
                                controller.signal.addEventListener('abort', abort, { once: true });
                            });
                        } finally {
                            clearInterval(countdown);
                            upload.stage = stage;
                            updateSelectedFile();
                        }
                    }
                }
            };
            upload.stage = 'syncPreparingUpload';
            updateSelectedFile();
            const fingerprint = await new Promise((resolve, reject) => {
                controller.signal.throwIfAborted();
                const worker = new Worker(new URL('./sync-upload-fingerprint-worker.js', import.meta.url), { type: 'module', name: 'upload-fingerprint' });
                const cleanup = () => { worker.terminate(); controller.signal.removeEventListener('abort', abort); };
                const abort = () => { cleanup(); reject(controller.signal.reason); };
                worker.onmessage = ({ data }) => { cleanup(); data.error ? reject(new Error(data.error)) : resolve(data.fingerprint); };
                worker.onerror = (event) => { cleanup(); reject(new Error(event.message)); };
                controller.signal.addEventListener('abort', abort, { once: true });
                worker.postMessage(upload.file);
            });
            controller.signal.throwIfAborted();
            if (upload.fingerprint && upload.fingerprint !== fingerprint) throw Object.assign(new Error('upload_conflict'), { code: 'upload_conflict' });
            upload.fingerprint = fingerprint;
            if (!upload.encryption) {
                upload.encryption = createFileMetadata(upload.file);
                upload.revokedDevices = [...session.revokedDevices];
            }
            const wireSize = upload.file.size + Math.ceil(upload.file.size / FILE_PLAIN_CHUNK_SIZE) * 16;
            const wireFingerprint = await keyedFingerprint(upload.encryption, fingerprint);
            for (;;) {
                upload.completing = false;
                try {
                    if (!upload.encryptedText || upload.keyId !== session.keyring.currentKeyId) {
                        const keyring = session.keyring;
                        upload.encryptedText = await encryptPayload(keyring, session.roomId, `message:${session.deviceId}:${upload.clientId}`, { text: upload.text, attachment: upload.encryption });
                        upload.keyId = keyring.currentKeyId;
                    }
                    saveDraft();
                    const result = await request(path, {
                        method: 'POST',
                        headers: { 'X-Sync-Key-Id': upload.keyId },
                        body: JSON.stringify({ clientId: upload.clientId, name: upload.encryption.fileId, type: 'application/octet-stream', size: wireSize, text: upload.encryptedText, fingerprint: wireFingerprint })
                    }, 30000);
                    if (credentials !== session || controller.signal.aborted || pendingUpload !== upload) return;
                    if (result.message) return result.message;
                    upload.uploadId = result.uploadId;
                    upload.receivedBytes = result.receivedBytes;
                    upload.inflightBytes = 0;
                    upload.baselineBytes = result.receivedBytes;
                    upload.startedAt = performance.now();
                    upload.bytesPerSecond = 0;
                    saveDraft();
                    upload.stage = 'syncUploadProgress';
                    updateSelectedFile();
                    if (result.chunkSize !== FILE_CIPHER_CHUNK_SIZE) throw new Error('invalid_chunk_size');
                    while (upload.receivedBytes < wireSize && upload.keyId === session.keyring.currentKeyId) {
                        const offset = upload.receivedBytes;
                        const index = Math.floor(offset / FILE_CIPHER_CHUNK_SIZE);
                        const plainOffset = index * FILE_PLAIN_CHUNK_SIZE;
                        const plaintext = await upload.file.slice(plainOffset, Math.min(plainOffset + FILE_PLAIN_CHUNK_SIZE, upload.file.size)).arrayBuffer();
                        const chunk = await encryptFileChunk(upload.encryption, index, plaintext);
                        controller.signal.throwIfAborted();
                        const received = await request(`${path}/${upload.uploadId}/chunks/${index}`, {
                            method: 'PUT', body: chunk, headers: { 'Content-Type': 'application/octet-stream' },
                            uploadProgress: (bytes) => {
                                if (pendingUpload !== upload || controller.signal.aborted) return;
                                upload.inflightBytes = bytes;
                                const elapsed = (performance.now() - upload.startedAt) / 1000;
                                upload.bytesPerSecond = elapsed > 0 ? (offset + bytes - upload.baselineBytes) / elapsed : 0;
                                updateSelectedFile();
                            }
                        }, 300000);
                        if (credentials !== session || controller.signal.aborted || pendingUpload !== upload) return;
                        upload.receivedBytes = received.receivedBytes;
                        upload.inflightBytes = 0;
                        const elapsed = (performance.now() - upload.startedAt) / 1000;
                        upload.bytesPerSecond = elapsed > 0 ? (upload.receivedBytes - upload.baselineBytes) / elapsed : 0;
                        updateSelectedFile();
                    }
                    if (upload.keyId !== session.keyring.currentKeyId) continue;
                    upload.completing = true;
                    upload.stage = 'syncCompletingUpload';
                    updateSelectedFile();
                    return await request(`${path}/${upload.uploadId}/complete`, { method: 'POST' }, 30000);
                } catch (error) {
                    if (error.code !== 'key_changed' || upload.keyId === session.keyring.currentKeyId
                        || controller.signal.aborted || credentials !== session) throw error;
                }
            }
        };
        find('attach').addEventListener('click', () => find('file-input').click());
        const selectFile = (file) => {
            if (busy || sending || !online) { setNotice('syncAttachUnavailable', true); return; }
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
            setNotice('syncFileReady');
        };
        find('file-input').addEventListener('change', () => {
            const file = find('file-input').files[0];
            if (file) selectFile(file);
        });
        app.addEventListener('dragenter', (event) => {
            if (!event.dataTransfer.types.includes('Files')) return;
            event.preventDefault();
            fileDragDepth++;
            if (online && !busy && !sending) app.classList.add('is-dragging-files');
        });
        app.addEventListener('dragover', (event) => {
            if (!event.dataTransfer.types.includes('Files')) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = online && !busy && !sending ? 'copy' : 'none';
        });
        app.addEventListener('dragleave', (event) => {
            if (!event.dataTransfer.types.includes('Files')) return;
            fileDragDepth = Math.max(0, fileDragDepth - 1);
            if (!fileDragDepth) app.classList.remove('is-dragging-files');
        });
        app.addEventListener('drop', (event) => {
            if (!event.dataTransfer.types.includes('Files')) return;
            event.preventDefault();
            fileDragDepth = 0;
            app.classList.remove('is-dragging-files');
            const files = Array.from(event.dataTransfer.files);
            if (files.length !== 1) { setNotice('syncOneFileOnly', true); return; }
            selectFile(files[0]);
        });
        input.addEventListener('paste', (event) => {
            const files = Array.from(event.clipboardData.items)
                .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
                .map((item) => item.getAsFile()).filter(Boolean);
            if (!files.length) return;
            if (files.length !== 1) { setNotice('syncOneFileOnly', true); return; }
            selectFile(files[0]);
        });
        find('remove-file').addEventListener('click', () => {
            discardUpload();
            selectedFile = null;
            find('file-input').value = '';
            updateSelectedFile();
        });
        find('cancel-upload').addEventListener('click', async () => {
            if (busy || !sending || !pendingUpload || !uploadController) return;
            const session = credentials;
            const uploadId = pendingUpload.uploadId;
            busy = true;
            uploadController.abort(Object.assign(new Error('upload_cancelled'), { code: 'upload_cancelled' }));
            updateSelectedFile();
            try {
                if (uploadId) await api(`/v1/spaces/${session.roomId}/files/uploads/${uploadId}`, { method: 'DELETE' }, session);
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
            const upload = file ? pendingUpload : null;
            const textDraft = file ? null : pending;
            saveDraft();
            sending = true;
            const controller = file ? new AbortController() : null;
            uploadController = controller;
            updateSelectedFile();
            setNotice('syncSending');
            try {
                if (file) {
                    const message = await uploadAttachment(upload, session, controller);
                    if (credentials === session && message && !controller.signal.aborted && pendingUpload === upload) addMessage(message, null, false);
                } else {
                    if (!textDraft.encrypted || textDraft.keyId !== session.keyring.currentKeyId) {
                        const keyring = session.keyring;
                        textDraft.encrypted = await encryptPayload(keyring, session.roomId, `message:${session.deviceId}:${textDraft.clientId}`, { text });
                        textDraft.keyId = keyring.currentKeyId;
                        saveDraft();
                    }
                    const message = await api(roomPath('/messages'), { method: 'POST', headers: { 'X-Sync-Key-Id': textDraft.keyId }, body: JSON.stringify({ clientId: textDraft.clientId, text: textDraft.encrypted }) });
                    if (credentials === session) addMessage(message, null, false);
                }
                if (credentials !== session) return;
                if (upload?.confirmed || (file && pendingUpload !== upload)) return;
                controller?.signal.throwIfAborted();
                if (input.value === text) input.value = '';
                if (file && selectedFile === file) {
                    selectedFile = null;
                    pendingUpload = null;
                    find('file-input').value = '';
                }
                if (!file && pending === textDraft) pending = null;
                saveDraft();
                setNotice('syncSent');
            } catch (error) {
                if (credentials === session) {
                    if (upload?.confirmed) return;
                    if (file && pendingUpload === upload && ['not_found', 'upload_unavailable', 'upload_conflict'].includes(error.code)) {
                        if (error.code === 'upload_conflict') discardUpload();
                        else pendingUpload = null;
                    }
                    saveDraft();
                    if (error.code === 'history_cleared') setNotice('syncCleared');
                    else if (error.code === 'upload_cancelled') return;
                    else if (file && !error.code) setNotice('syncUploadFailed', true);
                    else showError(error);
                }
            } finally {
                if (credentials === session && uploadController === controller) { sending = false; uploadController = null; updateSelectedFile(); }
            }
        });
        input.maxLength = 10000;
        input.addEventListener('input', () => { saveDraft(); updateControls(); });
        input.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
            event.preventDefault();
            if (!event.repeat) find('send-form').requestSubmit();
        });
        find('copy-code').addEventListener('click', () => {
            if (secondsLeft(pairExpiresAt)) copyText(find('pair-code').textContent);
            else updateCountdowns();
        });
        find('search').addEventListener('input', () => {
            clearTimeout(searchTimer);
            searchController?.abort();
            if (find('search').value.trim() && searchScrollTop === null) {
                searchScrollTop = feed.scrollTop;
                const top = feed.getBoundingClientRect().top;
                const anchor = [...messageNodes].find(([, node]) => node.getBoundingClientRect().bottom > top);
                searchAnchor = anchor ? { id: anchor[0], offset: anchor[1].getBoundingClientRect().top - top } : null;
            }
            applySearch();
            if (find('search').value.trim()) feed.scrollTop = 0;
            else {
                feed.scrollTop = searchScrollTop ?? feed.scrollTop;
                const anchor = messageNodes.get(searchAnchor?.id);
                if (anchor) feed.scrollTop += anchor.getBoundingClientRect().top - feed.getBoundingClientRect().top - searchAnchor.offset;
                searchScrollTop = null;
                searchAnchor = null;
                markRead();
            }
            if (find('search').value.trim()) searchTimer = setTimeout(searchHistory, 180);
        });
        find('latest').addEventListener('click', () => {
            find('search').value = '';
            searchScrollTop = null;
            searchAnchor = null;
            applySearch();
            feed.scrollTop = feed.scrollHeight;
            markRead();
        });
        find('history-more').addEventListener('click', () => loadOlder());
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
        find('devices-form').addEventListener('submit', (event) => event.preventDefault());
        for (const name of ['devices-close', 'devices-dismiss']) find(name).addEventListener('click', () => devicesDialog.close());
        for (const dialog of [confirmation, devicesDialog]) {
            dialog.addEventListener('close', markRead);
            dialog.addEventListener('keydown', (event) => {
                event.stopPropagation();
                if (event.key === 'Enter' && event.target.matches('[data-sync-device-name]') && !event.isComposing && event.keyCode !== 229) {
                    event.preventDefault();
                    if (!event.repeat) event.target.closest('[data-device-id]').querySelector('[data-sync-device-save]').click();
                    return;
                }
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
            if (Array.from(text.trim()).length > 8) { setText(find('devices-status'), 'syncDeviceNameTooLong', 'error'); return; }
            const session = credentials;
            busy = true;
            updateControls();
            try {
                const profile = devices.find(device => device.deviceId === target);
                const keyring = session.keyring;
                const encryptedName = await encryptPayload(keyring, session.roomId, `device:${target}`, { name: text.trim(), publicKey: profile.publicKey });
                await api(roomPath(`/devices/${target}`), { method: 'PATCH', headers: { 'X-Sync-Key-Id': keyring.currentKeyId }, body: JSON.stringify({ name: encryptedName }) });
                if (credentials !== session) return;
                if (name.value === text) { name.value = text.trim(); name.dataset.saved = text.trim(); }
                const loaded = await loadDevices();
                if (loaded && credentials === session) setText(find('devices-status'), 'syncDeviceSaved');
            } catch (error) { if (credentials === session) showError(error); }
            finally { if (credentials === session) { busy = false; updateControls(); } }
        });
        const rotateKeys = (removedDeviceId) => {
            if (rotationTask?.session === credentials) return rotationTask.promise;
            const session = credentials;
            const task = { session };
            task.promise = (async () => {
                await refreshKeys(session);
                if (credentials !== session) return;
                const result = await api(`/v1/spaces/${session.roomId}/devices`, {}, session);
                if (credentials !== session) return;
                const remaining = result.devices.filter(device => device.deviceId !== removedDeviceId
                    && !session.revokedDevices.includes(device.deviceId)
                    && session.trustedDevices[device.deviceId] === device.publicKey);
                const { rotationId, previousKeyId, newKeyId, grants } = await createKeyRotation(session, remaining);
                try {
                    await api(roomPath('/key-rotation'), { method: 'POST', headers: { 'X-Sync-Key-Id': previousKeyId }, body: JSON.stringify({ rotationId, removedDeviceId, newKeyId, grants }) }, session);
                } catch (error) { if (error.code !== 'key_changed') throw error; }
                if (credentials === session) await refreshKeys(session);
            })().finally(() => { if (rotationTask === task) rotationTask = null; });
            rotationTask = task;
            return task.promise;
        };
        find('confirm-accept').addEventListener('click', async () => {
            if (busy || sending || !credentials) return;
            const action = confirmation.dataset.action;
            const target = confirmation.dataset.deviceId;
            confirmation.close();
            const session = credentials;
            if (action === 'leave' || (action === 'remove' && target === deviceId)) leavingSession = session;
            busy = true;
            updateControls();
            const focusAtRequest = document.activeElement;
            try {
                if (action === 'clear') await api(roomPath('/messages'), { method: 'DELETE' });
                else {
                    const removedDeviceId = action === 'remove' ? target : session.deviceId;
                    if (removedDeviceId === session.deviceId) await api(roomPath('/device'), { method: 'DELETE' });
                    else await rotateKeys(removedDeviceId);
                }
                if (credentials !== session) return;
                if (action === 'clear') {
                    setNotice('syncCleared');
                    if (app.classList.contains('is-active') && document.activeElement === focusAtRequest) input.focus({ preventScroll: true });
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
        document.addEventListener('visibilitychange', () => {
            markRead();
            if (!document.hidden) { updateCountdowns(); connect(); }
        });
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
