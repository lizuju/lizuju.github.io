import { createKeyring, createDeviceIdentity, encryptPayload, decryptPayload, createFileMetadata, encryptFileChunk,
    keyedFingerprint, FILE_PLAIN_CHUNK_SIZE, FILE_CIPHER_CHUNK_SIZE, saveLocalSession, loadLocalSession,
    deleteLocalSession, createKeyRotation, acceptKeyRotation } from './sync-crypto.js';
import { EncryptedPairing } from './sync-pairing.js';
import { openEncryptedFile } from './sync-e2ee-files.js';
import { createInlineGif } from './sync-inline-image.js';

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
        const inlineGifs = new Map();
        const readReceipts = new Map();
        const outbox = new Map();
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
        let followLatest = true;
        let lastFeedScrollTop = 0;
        let scrollFrame = null;
        let readTimer = null;
        let readCandidate = null;
        let sentReadId = 0;
        let lastInteraction = -Infinity;
        let interactionRevision = 0;
        let readAfterInteraction = 0;
        let browserFocused = document.hasFocus();
        let leavingSession = null;
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
        let soundEnabled = true;
        try { soundEnabled = localStorage.getItem('portfolio-sync-notification-sound') !== 'off'; } catch { /* Use the current session preference. */ }
        const messageSound = new Audio(new URL('assets/sync-notification.wav', document.baseURI).href);
        messageSound.preload = 'auto';
        messageSound.volume = 0.35;
        let soundReady = false;
        let soundUnlocking = false;
        let soundVersion = 0;
        let lastSoundAt = -Infinity;

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
        const updateSoundToggle = () => {
            const label = translate(soundEnabled ? 'syncSoundMute' : 'syncSoundUnmute');
            find('sound').setAttribute('aria-pressed', String(soundEnabled));
            find('sound').setAttribute('aria-label', label);
            find('sound').title = label;
            find('sound-icon').src = `../textures/UI/volume_${soundEnabled ? 'on' : 'off'}.svg`;
        };
        const unlockSound = () => {
            if (!soundEnabled || soundReady || soundUnlocking) return;
            const version = ++soundVersion;
            soundUnlocking = true;
            messageSound.muted = true;
            messageSound.play().then(() => {
                if (version !== soundVersion) return;
                messageSound.pause();
                messageSound.currentTime = 0;
                messageSound.muted = false;
                soundReady = true;
            }).catch(() => {}).finally(() => { if (version === soundVersion) soundUnlocking = false; });
        };
        const notifyMessage = () => {
            if (!soundEnabled || !soundReady || performance.now() - lastSoundAt < 750) return;
            lastSoundAt = performance.now();
            const version = soundVersion;
            messageSound.currentTime = 0;
            messageSound.play().catch(error => {
                if (version === soundVersion && error.name === 'NotAllowedError') soundReady = false;
            });
        };
        find('sound').addEventListener('click', () => {
            soundEnabled = !soundEnabled;
            try { localStorage.setItem('portfolio-sync-notification-sound', soundEnabled ? 'on' : 'off'); } catch { /* Keep the current session preference. */ }
            if (soundEnabled) unlockSound();
            else {
                soundVersion++;
                soundUnlocking = false;
                messageSound.pause();
                messageSound.currentTime = 0;
            }
            updateSoundToggle();
        });
        for (const type of ['pointerdown', 'keydown', 'touchstart']) document.addEventListener(type, event => {
            if (event.isTrusted && document.hasFocus() && !document.hidden) unlockSound();
        }, { passive: true });
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
            for (const message of outbox.values()) {
                const retry = messageNodes.get(message.id)?.querySelector('[data-sync-retry-message]');
                if (retry) retry.disabled = busy || sending || !online || (!!message.attachment && !(pendingUpload?.clientId === message.clientId && pendingUpload.file instanceof File));
            }
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
                pairing_limited: 'syncPairLimited', pairing_ambiguous: 'syncPairAmbiguous', pairing_busy: 'syncPairBusy', pairing_timeout: 'syncPairTimeout',
                encryption_unavailable: 'syncEncryptionUnavailable'
            };
            if (['rate_limited', 'pairing_limited'].includes(error.code) && action && error.retryAfter > 0) {
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
            const result = await response.json().catch(error => {
                if (response.ok) throw error;
                return { error: 'unavailable' };
            });
            if (!response.ok) {
                if (result.error === 'key_changed' && session === credentials) await refreshKeys(session);
                const retryAfter = response.headers.get('Retry-After');
                const seconds = Number(retryAfter);
                throw Object.assign(new Error(result.error), {
                    code: result.error,
                    status: response.status,
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
            if (session === credentials && result.readReceipts) mergeReadReceipts(result.readReceipts);
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
                            discardUpload(true);
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
            return encryptPayload(session.keyring, session.roomId, `draft:${session.deviceId}`, { text: input.value, outbox: [...outbox.values()], upload })
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
            inlineGifs.get(id)?.dispose();
            inlineGifs.delete(id);
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
        const isReading = () => active && browserFocused && document.hasFocus() && !document.hidden
            && performance.now() - lastInteraction < 60000 && app.classList.contains('is-active')
            && !app.classList.contains('is-minimized') && !find('search').value.trim()
            && !devicesDialog.open && !confirmation.open;
        const updateReadReceipts = () => {
            const otherReadId = Math.max(0, ...[...readReceipts].filter(([id]) => id !== deviceId
                && credentials?.trustedDevices[id] && !credentials.revokedDevices.includes(id)).map(([, id]) => id));
            for (const message of [...history, ...outbox.values()]) {
                const receipt = messageNodes.get(message.id)?.querySelector('.sync-message-read');
                if (!receipt) continue;
                receipt.hidden = message.deviceId !== deviceId || !!message.sendState;
                const read = !message.sendState && message.id <= otherReadId;
                receipt.dataset.state = read ? 'read' : 'sent';
                receipt.title = translate(read ? 'syncRead' : 'syncMessageSent');
                receipt.setAttribute('aria-label', receipt.title);
            }
        };
        const mergeReadReceipts = (receipts) => {
            for (const receipt of receipts) readReceipts.set(receipt.deviceId, Math.max(readReceipts.get(receipt.deviceId) || 0, receipt.messageId));
            updateReadReceipts();
        };
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
            const latest = history.at(-1);
            const rect = latest && messageNodes.get(latest.id)?.getBoundingClientRect();
            const viewport = feed.getBoundingClientRect();
            const visible = rect && Math.min(rect.bottom, viewport.bottom, innerHeight) - Math.max(rect.top, viewport.top, 0) >= Math.min(40, rect.height)
                && Math.min(rect.right, viewport.right, innerWidth) > Math.max(rect.left, viewport.left, 0);
            if (!isReading() || interactionRevision < readAfterInteraction || !atBottom() || !visible || latest.decryptionFailed) {
                clearTimeout(readTimer);
                readTimer = null;
                readCandidate = null;
                return;
            }
            if (!unread.size && latest.id <= Math.max(sentReadId, readReceipts.get(deviceId) || 0)) return;
            if (readCandidate === latest.id && readTimer) return;
            clearTimeout(readTimer);
            readCandidate = latest.id;
            readTimer = setTimeout(() => {
                readTimer = null;
                if (!isReading() || interactionRevision < readAfterInteraction || !atBottom() || history.at(-1)?.id !== latest.id) return;
                unread.clear();
                updateUnread();
                if (online && socket?.readyState === WebSocket.OPEN && latest.id > Math.max(sentReadId, readReceipts.get(deviceId) || 0)) {
                    sentReadId = latest.id;
                    socket.send(JSON.stringify({ type: 'read', messageId: latest.id }));
                }
            }, 600);
        };
        const scrollToLatest = () => {
            if (scrollFrame !== null) return;
            scrollFrame = requestAnimationFrame(() => {
                scrollFrame = null;
                if (!followLatest || find('search').value.trim()) return;
                feed.scrollTop = feed.scrollHeight;
                lastFeedScrollTop = feed.scrollTop;
                markRead();
            });
        };
        const applySearch = () => {
            const query = find('search').value.trim().toLocaleLowerCase();
            let count = 0;
            for (const message of [...history, ...outbox.values()]) {
                const name = devices.find((device) => device.deviceId === message.deviceId)?.name
                    || translate(message.deviceId === deviceId ? 'syncMessageYou' : 'syncMessageDevice');
                const match = !query || [message.text, message.attachment?.name || '', name].some((value) => value.toLocaleLowerCase().includes(query));
                messageNodes.get(message.id).hidden = !match;
                if (match) count++;
            }
            find('empty').hidden = history.length !== 0 || outbox.size !== 0 || !!query;
            find('no-results').hidden = !query || count !== 0;
            setText(find('no-results'), searchController && !searchController.signal.aborted ? 'syncSearching'
                : historyState && history[0]?.id > historyState.oldestId ? 'syncSearchIncomplete' : 'syncNoResults');
        };
        const render = (scroll = false, preserve = false) => {
            if (scroll) followLatest = true;
            if (preserve) followLatest = false;
            const follow = !preserve && followLatest && !find('search').value.trim();
            const rendered = [...history, ...outbox.values()];
            const ids = new Set(rendered.map((message) => message.id));
            for (const [id, item] of messageNodes) {
                if (!ids.has(id)) { disposeAttachment(id); item.remove(); messageNodes.delete(id); unread.delete(id); }
            }
            rendered.forEach((message, index) => {
                let item = messageNodes.get(message.id);
                if (!item) {
                    item = document.createElement('li');
                    item.className = 'sync-message';
                    const meta = document.createElement('small');
                    meta.className = 'sync-message-meta';
                    const label = document.createElement('span');
                    const receipt = document.createElement('span');
                    receipt.className = 'sync-message-read';
                    receipt.textContent = '✓';
                    receipt.hidden = true;
                    const copy = document.createElement('button');
                    copy.type = 'button';
                    copy.className = 'sync-message-copy';
                    copy.dataset.syncCopyMessage = '';
                    copy.addEventListener('click', () => copyText(message.text));
                    meta.append(label, receipt, copy);
                    const sendStatus = document.createElement('span');
                    sendStatus.className = 'sync-message-send-status';
                    sendStatus.hidden = true;
                    const retry = document.createElement('button');
                    retry.type = 'button';
                    retry.className = 'sync-message-copy';
                    retry.dataset.syncRetryMessage = '';
                    retry.hidden = true;
                    retry.addEventListener('click', () => sendOutgoing(message));
                    meta.append(sendStatus, retry);
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
                        download.disabled = !!message.sendState;
                        download.addEventListener('click', () => downloadAttachment(message, download));
                        actions.append(download);
                        attachment.append(name, size, actions);
                        if (previewKind(message.attachment)) {
                            const preview = document.createElement('button');
                            preview.type = 'button';
                            preview.className = 'sync-attachment-preview';
                            preview.dataset.syncPreviewFile = '';
                            preview.disabled = !!message.sendState;
                            preview.addEventListener('click', () => previewAttachment(message, preview));
                            actions.prepend(preview);
                        }
                        item.append(attachment);
                    }
                    messageNodes.set(message.id, item);
                    if (!message.sendState && message.attachment && (message.attachment.type === 'image/gif' || /\.gif$/i.test(message.attachment.name))
                        && message.attachment.size <= 20 * 1024 * 1024) {
                        const session = credentials;
                        const gif = createInlineGif({
                            name: message.attachment.name,
                            load: () => encryptedFile(message, session, false),
                            onPreview: () => previewAttachment(message, item.querySelector('[data-sync-preview-file]')),
                            onLoad: () => { if (followLatest) scrollToLatest(); }
                        });
                        item.insertBefore(gif.element, item.querySelector('.sync-attachment'));
                        inlineGifs.set(message.id, gif);
                        gif.start();
                    }
                }
                item.classList.toggle('is-own', message.deviceId === deviceId);
                item.dataset.state = message.sendState || 'sent';
                const sendStatus = item.querySelector('.sync-message-send-status');
                sendStatus.hidden = !message.sendState;
                sendStatus.textContent = translate(message.sendState === 'failed' ? 'syncMessageFailed' : 'syncSending');
                const retry = item.querySelector('[data-sync-retry-message]');
                retry.hidden = message.sendState !== 'failed';
                retry.textContent = translate('syncMessageRetry');
                const name = devices.find((device) => device.deviceId === message.deviceId)?.name
                    || translate(message.deviceId === deviceId ? 'syncMessageYou' : 'syncMessageDevice');
                const label = `${name} · ${new Date(message.createdAt).toLocaleString(desktopApi.getLanguage())}`;
                if (item.firstChild.firstChild.textContent !== label) item.firstChild.firstChild.textContent = label;
                const copy = item.querySelector('[data-sync-copy-message]');
                copy.textContent = translate('syncCopy');
                const download = item.querySelector('[data-sync-download-file]');
                if (download) {
                    download.textContent = translate(download.dataset.loading ? 'syncDownloading' : 'syncDownload');
                    download.disabled = !!message.sendState || !!download.dataset.loading;
                }
                const preview = item.querySelector('[data-sync-preview-file]');
                if (preview) preview.textContent = translate('syncPreview');
                if (messages.children[index] !== item) messages.insertBefore(item, messages.children[index] || null);
            });
            applySearch();
            updateReadReceipts();
            if (follow) {
                feed.scrollTop = feed.scrollHeight;
                lastFeedScrollTop = feed.scrollTop;
                scrollToLatest();
            }
            markRead();
            updateUnread();
            updateControls();
        };
        const reconcileUpload = (incoming) => {
            let confirmed = false;
            for (const message of incoming) {
                if (message.deviceId !== deviceId) continue;
                const outgoing = outbox.get(message.clientId);
                if (!outgoing) continue;
                outgoing.confirmed = true;
                outbox.delete(message.clientId);
                confirmed = true;
            }
            const upload = pendingUpload;
            if (!upload || !incoming.some((message) => message.clientId === upload.clientId && message.deviceId === deviceId)) {
                if (confirmed) { saveDraft(); setNotice('syncSent'); }
                return;
            }
            upload.confirmed = true;
            pendingUpload = null;
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
            if (mode !== 'prepend') {
                for (const message of incoming) {
                    if (!known.has(message.id) && message.deviceId !== deviceId && message.id > (readReceipts.get(deviceId) || 0)) {
                        unread.add(message.id);
                        readAfterInteraction = interactionRevision + 1;
                    }
                }
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
        const addMessage = (message, metadata = null, advanceCursor = true, notify = false) => {
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
            if (message.deviceId !== deviceId) {
                unread.add(message.id);
                readAfterInteraction = interactionRevision + 1;
                if (notify) notifyMessage();
            }
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
            sentReadId = 0;
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
                    mergeReadReceipts(data.readReceipts || []);
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
                    markRead();
                } else if (data.type === 'message') {
                    const message = await decodeMessage(data.message, session);
                    if (socket === connection && credentials === session) addMessage(message, data.history, true, initialized);
                }
                else if (data.type === 'read') { mergeReadReceipts([data]); }
                else if (data.type === 'pairing') await showPairing(data.pairing);
                else if (data.type === 'pair-request' || data.type === 'pair-finish') await pairing.handle(data);
                else if (data.type === 'key-rotation') { await refreshKeys(session); await loadDevices(); }
                else if (data.type === 'rekey-required') await rotateKeys(null);
                else if (data.type === 'history') {
                    mergeReadReceipts(data.readReceipts || []);
                    receiveHistory(await Promise.all(data.messages.map(message => decodeMessage(message, session))), false, data.historyMode, data.history);
                }
                else if (data.type === 'devices') loadDevices();
                else if (data.type === 'cleared') {
                    uploadController?.abort(Object.assign(new Error('history_cleared'), { code: 'history_cleared' }));
                    pendingUpload = null;
                    outbox.clear();
                    saveDraft();
                    unread.clear();
                    mergeReadReceipts(data.readReceipts || []);
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
            soundVersion++;
            soundUnlocking = false;
            messageSound.pause();
            messageSound.currentTime = 0;
            clearTimeout(readTimer);
            readTimer = null;
            readCandidate = null;
            sentReadId = 0;
            readAfterInteraction = 0;
            readReceipts.clear();
            inlineGifs.forEach(gif => gif.dispose());
            inlineGifs.clear();
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
            outbox.clear();
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
            followLatest = true;
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
                pendingUpload = draft?.upload || null;
                for (const message of draft?.outbox || []) {
                    if (!message.attachment || pendingUpload?.clientId === message.clientId) outbox.set(message.clientId, { ...message, sendState: 'failed' });
                }
                if (pendingUpload && session.revokedDevices.some(id => !(pendingUpload.revokedDevices || []).includes(id))) discardUpload(true);
            } catch { input.value = ''; outbox.clear(); pendingUpload = null; }
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
                        if (version !== sessionVersion || !sameSession(saved, savedSession())) return;
                        if (credentials && session.roomId === credentials.roomId && session.token === credentials.token
                            && session.deviceId === credentials.deviceId && session.vaultId === credentials.vaultId) {
                            if (!Object.hasOwn(session.keyring.keys, credentials.keyring.currentKeyId)) return;
                            const revoked = new Set(credentials.revokedDevices);
                            const keyChanged = session.keyring.currentKeyId !== credentials.keyring.currentKeyId;
                            Object.assign(credentials, session, { revision: saved.revision });
                            if (pendingUpload && session.revokedDevices.some(id => !revoked.has(id))) {
                                uploadController?.abort(Object.assign(new Error('key_changed'), { code: 'key_changed' }));
                                discardUpload(true);
                            }
                            if (keyChanged) { pairing.reset(); await showPairing(null); }
                            saveDraft();
                            await loadDevices();
                            return;
                        }
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
                lastInteraction = performance.now();
                interactionRevision++;
                reconcileSession();
                connect();
                if (followOnRestore) { followLatest = true; scrollToLatest(); }
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
        const discardUpload = (restart = false) => {
            const upload = pendingUpload;
            pendingUpload = null;
            if (upload) {
                const outgoing = outbox.get(upload.clientId);
                outbox.delete(upload.clientId);
                if (restart && outgoing) {
                    const clientId = crypto.randomUUID();
                    Object.assign(outgoing, { id: `pending:${clientId}`, clientId, sendState: 'failed' });
                    outbox.set(clientId, outgoing);
                    pendingUpload = { clientId, file: upload.file, text: upload.text, receivedBytes: 0 };
                }
            }
            saveDraft();
            render();
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
            if (pendingUpload) {
                if (['name', 'size', 'type', 'lastModified'].some((key) => file[key] !== pendingUpload.file[key])) {
                    if (!selectedFile) {
                        find('file-input').value = '';
                        setNotice('syncWrongResumeFile', true);
                        return;
                    }
                    discardUpload();
                } else pendingUpload.file = file;
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
                    outbox.delete(pendingUpload?.clientId);
                    pendingUpload = null;
                    selectedFile = null;
                    find('file-input').value = '';
                    saveDraft();
                    render();
                    setNotice('syncUploadCancelled');
                }
            } catch (error) { if (credentials === session) showError(error); }
            finally { if (credentials === session) { busy = false; updateSelectedFile(); } }
        });
        const sendOutgoing = async (outgoing) => {
            if (busy || sending || !online || !outbox.has(outgoing.clientId)) return;
            const session = credentials;
            const upload = outgoing.attachment ? pendingUpload : null;
            if (outgoing.attachment && (upload?.clientId !== outgoing.clientId || !(upload.file instanceof File))) return;
            const text = outgoing.text;
            outgoing.sendState = 'sending';
            sending = true;
            const controller = upload ? new AbortController() : null;
            uploadController = controller;
            saveDraft();
            render(true);
            updateSelectedFile();
            setNotice('syncSending');
            try {
                if (upload) {
                    const message = await uploadAttachment(upload, session, controller);
                    if (credentials === session && message && !controller.signal.aborted && pendingUpload === upload) addMessage(message, null, false);
                } else {
                    if (!outgoing.encrypted || outgoing.keyId !== session.keyring.currentKeyId) {
                        const keyring = session.keyring;
                        outgoing.encrypted = await encryptPayload(keyring, session.roomId, `message:${session.deviceId}:${outgoing.clientId}`, { text });
                        outgoing.keyId = keyring.currentKeyId;
                        saveDraft();
                    }
                    if (credentials !== session || outgoing.confirmed || !outbox.has(outgoing.clientId)) return;
                    const message = await api(roomPath('/messages'), { method: 'POST', headers: { 'X-Sync-Key-Id': outgoing.keyId }, body: JSON.stringify({ clientId: outgoing.clientId, text: outgoing.encrypted }) });
                    if (credentials === session) addMessage(message, null, false);
                }
                if (credentials !== session) return;
                if (upload?.confirmed || (upload && pendingUpload !== upload)) return;
                controller?.signal.throwIfAborted();
                saveDraft();
                setNotice('syncSent');
            } catch (error) {
                if (credentials === session) {
                    if (outgoing.confirmed || upload?.confirmed || !outbox.has(outgoing.clientId)) return;
                    if (upload && pendingUpload === upload && ['not_found', 'upload_unavailable', 'upload_conflict'].includes(error.code)) {
                        if (error.code === 'upload_conflict') discardUpload(true);
                        else { upload.uploadId = null; upload.receivedBytes = 0; }
                    }
                    if (outbox.has(outgoing.clientId)) outgoing.sendState = 'failed';
                    saveDraft();
                    if (error.code === 'history_cleared') setNotice('syncCleared');
                    else if (error.code === 'upload_cancelled') return;
                    else if (upload && !error.code) setNotice('syncUploadFailed', true);
                    else showError(error);
                }
            } finally {
                if (credentials === session && uploadController === controller) { sending = false; uploadController = null; render(); updateSelectedFile(); }
            }
        };
        find('send-form').addEventListener('submit', (event) => {
            event.preventDefault();
            if (busy || sending || !online || (!selectedFile && (pendingUpload || !input.value.trim())) || !find('send-form').reportValidity()) return;
            const file = selectedFile;
            const resuming = file && pendingUpload?.file === file;
            const text = resuming ? pendingUpload.text : input.value;
            if (file && !resuming) {
                discardUpload();
                pendingUpload = { clientId: crypto.randomUUID(), file, text, receivedBytes: 0 };
            }
            const clientId = file ? pendingUpload.clientId : crypto.randomUUID();
            const outgoing = outbox.get(clientId) || {
                id: `pending:${clientId}`, clientId, deviceId, text, createdAt: Date.now(),
                attachment: file ? { name: file.name, type: file.type, size: file.size } : null,
                sendState: 'sending'
            };
            outbox.set(clientId, outgoing);
            if (!resuming) input.value = '';
            sendOutgoing(outgoing);
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
            followLatest = true;
            feed.scrollTop = feed.scrollHeight;
            scrollToLatest();
            markRead();
        });
        find('history-more').addEventListener('click', () => loadOlder());
        feed.addEventListener('scroll', () => {
            if (!find('search').value.trim()) {
                if (atBottom()) followLatest = true;
                else if (feed.scrollTop < lastFeedScrollTop) followLatest = false;
            }
            lastFeedScrollTop = feed.scrollTop;
            markRead();
        });
        feed.addEventListener('wheel', event => { if (event.deltaY < 0) followLatest = false; }, { passive: true });
        new ResizeObserver(() => {
            if (followLatest) scrollToLatest();
            else markRead();
        }).observe(messages);
        new ResizeObserver(() => {
            if (followLatest) scrollToLatest();
            else markRead();
        }).observe(feed);
        const recordInteraction = (event) => {
            if (!event.isTrusted || !browserFocused || !document.hasFocus() || document.hidden || !app.classList.contains('is-active')) return;
            lastInteraction = performance.now();
            interactionRevision++;
            markRead();
        };
        for (const type of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'touchmove']) {
            document.addEventListener(type, recordInteraction, { passive: true });
        }
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
        window.addEventListener('pagehide', () => { saveDraft(); disconnect(); messageSound.pause(); });
        window.addEventListener('pageshow', () => { reconcileSession(); if (active) connect(); });
        window.addEventListener('blur', () => { browserFocused = false; markRead(); });
        window.addEventListener('focus', () => { browserFocused = true; markRead(); });
        document.addEventListener('visibilitychange', () => {
            markRead();
            if (!document.hidden) { updateCountdowns(); connect(); }
        });
        window.addEventListener('portfolio-language-change', () => {
            updateSoundToggle();
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
        updateSoundToggle();
        updateControls();
        return entry;
    };
})();
