import { createKeyring, createDeviceIdentity, encryptPayload, decryptPayload, createFileMetadata, encryptFileChunk,
    keyedFingerprint, FILE_PLAIN_CHUNK_SIZE, FILE_CIPHER_CHUNK_SIZE, loadLocalSession,
    createKeyRotation, acceptKeyRotation } from './sync-crypto.js';
import { EncryptedPairing } from './sync-pairing.js';
import { SavedSpaces, CREDENTIAL_KEY, CATALOG_KEY } from './sync-spaces.js';
import { openEncryptedFile, prepareEncryptedFiles } from './sync-e2ee-files.js';
import { createInlineImage } from './sync-inline-image.js';
import { createImageResource } from './sync-image-resource.js';
import { VoiceRecorder } from './sync-voice-recorder.js';
import { createVoicePlayer } from './sync-voice-player.js';
import { STICKERS, stickerById } from './sync-stickers.js';
import { createGomokuWindow } from './sync-gomoku.js';

(() => {
    const desktopApi = window.GavinDesktop;
    const assetRoot = new URL(document.body.dataset.assetRoot || '.', document.baseURI);
    const ADD_SPACE_KEY = 'portfolio-sync-add-space';
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
        const spaceNameDialog = find('space-name-dialog');
        const stickerDialog = find('sticker-dialog');
        const messageNodes = new Map();
        const inlineImages = new Map();
        const imageResources = new Map();
        const voicePlayers = new Map();
        const readReceipts = new Map();
        const outbox = new Map();
        const games = new Map();
        const gameCommands = new Set();
        let gameWindow = null;
        let restoringGame = false;
        const unread = new Set();
        const cooldowns = { create: 0, join: 0, pair: 0 };
        const savedSpaces = new SavedSpaces();
        const spacesReady = savedSpaces.importActive();
        spacesReady.catch(() => {});
        const spaceFiles = new Map();
        const downloads = new Set();
        let switchingSpace = false;
        let forgettingSpace = null;
        let reconcileTask = null;
        let reconcileNeeded = false;
        let addingSpace = false;
        let spacesPreference = null;
        try {
            addingSpace = sessionStorage.getItem(ADD_SPACE_KEY) === 'true';
            spacesPreference = localStorage.getItem('portfolio-sync-spaces-collapsed');
        } catch { /* Opening a space reports unavailable storage. */ }
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
        let pairLocked = false;
        let pairEnabled = true;
        let pairPolicyRevision = 0;
        let offerRenewal = null;
        let displayedOfferId = null;
        let pairingRevision = 0;
        let retryDelay = 1000;
        let online = false;
        let busy = false;
        let sending = false;
        let sendingText = false;
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
        let selectedVoice = null;
        let selectedReply = null;
        let voicePreviewFile = null;
        let voicePreviewUrl = null;
        let recordingSession = null;
        let viewingDesktop = true;
        let pendingUpload = null;
        let uploadController = null;
        let configPromise = null;
        let sessionVersion = 0;
        let deviceRequest = 0;
        let searchScrollTop = null;
        let searchAnchor = null;
        let fileDragDepth = 0;
        const downloadTickets = new Map();
        const fileCapabilities = new Map();
        let keyRefresh;
        let draftRevision = 0;
        let rotationTask;
        let soundEnabled = true;
        try { soundEnabled = localStorage.getItem('portfolio-sync-notification-sound') !== 'off'; } catch { /* Use the current session preference. */ }
        const messageSound = new Audio(new URL('assets/sync-notification.wav', assetRoot).href);
        messageSound.preload = 'auto';
        messageSound.volume = 0.35;
        let soundReady = false;
        let soundUnlocking = false;
        let soundVersion = 0;

        const loadConfig = () => {
            if (!configPromise) {
                configPromise = fetch(new URL('sync-config.json', assetRoot), { cache: 'no-store', signal: AbortSignal.timeout(15000) })
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
        const spaceSwitchBlocked = () => busy || sending || recording() || downloads.size > 0 || switchingSpace;
        const renderSpaces = () => {
            let spaces;
            try { spaces = savedSpaces.list(); } catch { return; }
            const list = find('space-list');
            const ids = new Set(spaces.map(space => space.roomId));
            for (const button of [...list.children]) if (!ids.has(button.dataset.syncSpaceId)) button.remove();
            for (const space of spaces) {
                let button = [...list.children].find(button => button.dataset.syncSpaceId === space.roomId);
                if (!button) {
                    button = document.createElement('button');
                    button.type = 'button';
                    button.className = 'sync-button';
                    button.dataset.syncSpaceId = space.roomId;
                    button.addEventListener('click', () => switchSpace(space.roomId));
                    list.append(button);
                }
                const label = space.name || translate('syncSpaceName', { number: space.number });
                button.textContent = label;
                button.title = label;
                button.setAttribute('aria-current', String(space.roomId === credentials?.roomId && !addingSpace));
                button.disabled = spaceSwitchBlocked();
            }
            const current = spaces.find(space => space.roomId === credentials?.roomId);
            find('space-title').textContent = current ? current.name || translate('syncSpaceName', { number: current.number }) : '';
            find('space-rename').disabled = !current || switchingSpace;
            find('space-rename').title = translate('syncSpaceRename');
            find('add-space').disabled = spaceSwitchBlocked();
            find('back-space').hidden = !addingSpace || !credentials;
            find('back-space').disabled = busy || switchingSpace;
            const collapsed = app.classList.contains('is-spaces-collapsed');
            const toggle = find('spaces-toggle');
            toggle.setAttribute('aria-expanded', String(!collapsed));
            toggle.setAttribute('aria-label', translate(collapsed ? 'syncSpacesExpand' : 'syncSpacesCollapse'));
            toggle.title = toggle.getAttribute('aria-label');
        };
        const updateSoundToggle = () => {
            const label = translate(soundEnabled ? 'syncSoundMute' : 'syncSoundUnmute');
            find('sound').setAttribute('aria-pressed', String(soundEnabled));
            find('sound').setAttribute('aria-label', label);
            find('sound').title = label;
            find('sound-icon').src = new URL(`../textures/UI/volume_${soundEnabled ? 'on' : 'off'}.svg`, assetRoot).href;
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
        const setSoundEnabled = (enabled) => {
            if (enabled === soundEnabled) return;
            soundEnabled = enabled;
            if (soundEnabled) unlockSound();
            else {
                soundVersion++;
                soundUnlocking = false;
                messageSound.pause();
                messageSound.currentTime = 0;
            }
            updateSoundToggle();
        };
        const notifyMessage = (message) => {
            if (!soundEnabled || !soundReady) return;
            const session = credentials;
            const version = soundVersion;
            const key = `portfolio-sync-notification:${session.roomId}:${session.deviceId}`;
            navigator.locks.request(key, async () => {
                if (version !== soundVersion || credentials !== session || !soundEnabled || !soundReady || localStorage.getItem('portfolio-sync-notification-sound') === 'off') return;
                const database = await new Promise((resolve, reject) => {
                    const request = indexedDB.open('gavin-sync-notifications', 1);
                    request.onupgradeneeded = () => request.result.createObjectStore('messages');
                    request.onsuccess = () => resolve(request.result);
                    request.onerror = () => reject(request.error);
                });
                try {
                    const previous = await new Promise((resolve, reject) => {
                        const request = database.transaction('messages').objectStore('messages').get(key);
                        request.onsuccess = () => resolve(request.result);
                        request.onerror = () => reject(request.error);
                    });
                    if (version !== soundVersion || credentials !== session || !soundEnabled || !soundReady || message.id <= (previous?.id || 0)) return;
                    let at = previous?.at;
                    if (!previous || Date.now() - previous.at >= 750) {
                        messageSound.currentTime = 0;
                        try { await messageSound.play(); }
                        catch (error) {
                            if (version === soundVersion && error.name === 'NotAllowedError') soundReady = false;
                            return;
                        }
                        if (version !== soundVersion || credentials !== session || !soundEnabled) return;
                        at = Date.now();
                    }
                    await new Promise((resolve, reject) => {
                        const transaction = database.transaction('messages', 'readwrite');
                        transaction.objectStore('messages').put({ id: message.id, at }, key);
                        transaction.oncomplete = resolve;
                        transaction.onerror = () => reject(transaction.error);
                    });
                } finally { database.close(); }
            }).catch(() => {});
        };
        find('sound').addEventListener('click', () => {
            const enabled = !soundEnabled;
            try { localStorage.setItem('portfolio-sync-notification-sound', enabled ? 'on' : 'off'); } catch { /* Keep the current session preference. */ }
            setSoundEnabled(enabled);
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
        const voiceTime = (duration) => `${String(Math.floor(duration / 60000)).padStart(2, '0')}:${String(Math.floor(duration / 1000) % 60).padStart(2, '0')}`;
        const recording = () => ['starting', 'recording', 'stopping'].includes(recorder.state);
        const stickerName = (id) => stickerById(id)?.[desktopApi.getLanguage() === 'en' ? 'en' : 'zh'] || '';
        const isGamePlayer = game => game && [game.hostDeviceId, game.guestDeviceId].includes(deviceId);
        const isGameActive = game => game && ['waiting', 'playing'].includes(game.status);
        const ownGame = () => [...games.values()].find(game => isGamePlayer(game) && isGameActive(game));
        const needsGameConnection = () => Boolean(restoringGame || ownGame() || gameWindow?.currentId);
        const voiceVisible = () => !room.hidden && active && viewingDesktop && !document.hidden && !app.closest('[inert]')
            && app.classList.contains('is-active') && !app.classList.contains('is-closed')
            && !app.classList.contains('is-minimized') && !confirmation.open && !devicesDialog.open && !stickerDialog.open;
        const releaseVoicePreview = () => {
            const preview = find('voice-preview');
            preview.pause();
            preview.removeAttribute('src');
            preview.load();
            if (voicePreviewUrl) URL.revokeObjectURL(voicePreviewUrl);
            voicePreviewUrl = null;
            voicePreviewFile = null;
            preview.hidden = true;
        };
        const pauseVoiceMedia = () => {
            voicePlayers.forEach(player => player.pause());
            find('voice-preview').pause();
        };
        const cancelRecording = () => {
            recordingSession = null;
            const cancelled = recorder.cancel();
            updateControls();
            cancelled.then(updateControls);
        };
        const recorder = new VoiceRecorder({
            onTime: (duration) => {
                find('voice-time').textContent = `${voiceTime(duration)} / 01:00`;
            },
            onStop: ({ file, durationMs }) => {
                const session = recordingSession;
                recordingSession = null;
                if (credentials !== session || !voiceVisible()) { updateControls(); return; }
                if (durationMs < 250) { setNotice('syncVoiceTooShort', true); updateControls(); return; }
                selectedVoice = { kind: 'voice', durationMs };
                selectedFile = file;
                saveDraft();
                updateSelectedFile();
                setNotice('syncVoiceReady');
            },
            onError: (error) => {
                recordingSession = null;
                const key = error.name === 'NotAllowedError' || error.name === 'SecurityError' ? 'syncVoiceDenied'
                    : error.name === 'NotFoundError' ? 'syncVoiceNoMicrophone'
                    : error.name === 'NotSupportedError' ? 'syncVoiceUnavailable' : 'syncVoiceFailed';
                setNotice(key, true);
                updateControls();
            }
        });
        const updateVoiceVisibility = () => {
            if (voiceVisible()) return;
            if (recording()) cancelRecording();
            pauseVoiceMedia();
        };
        const updateControls = () => {
            const working = busy || switchingSpace;
            input.disabled = switchingSpace;
            find('create').disabled = working || sending || secondsLeft(cooldowns.create) > 0;
            find('join').disabled = working || sending || secondsLeft(cooldowns.join) > 0;
            find('code').disabled = working || sending;
            find('pair').disabled = working || sending || !online || secondsLeft(cooldowns.pair) > 0;
            find('devices').disabled = working || sending || !online;
            find('clear').disabled = working || sending || !online || !history.length;
            find('leave').disabled = working || sending;
            find('send').disabled = working || sendingText || recording() || !online || (!(selectedFile && !uploadController) && !input.value.trim());
            find('attach').disabled = working || sending || recording() || !online;
            find('file-input').disabled = working || sending || recording() || !online;
            find('voice-record').disabled = working || sending || recording() || !online || !!selectedFile || !!pendingUpload;
            find('stickers').disabled = working || sendingText || recording() || !online;
            find('game-share').disabled = working || sendingText || recording() || !online || !!ownGame();
            find('sticker-grid').querySelectorAll('button').forEach(button => { button.disabled = find('stickers').disabled; });
            find('voice-recording').hidden = !recording();
            find('voice-stop').disabled = recorder.state !== 'recording';
            setText(find('voice-status'), recorder.state === 'starting' ? 'syncVoiceStarting' : 'syncVoiceRecording');
            find('remove-file').disabled = working || sending;
            find('cancel-upload').hidden = !uploadController || !pendingUpload;
            find('cancel-upload').disabled = working || !uploadController || pendingUpload?.completing || uploadController.signal.aborted;
            find('copy-code').disabled = !pairing.offer || !pairEnabled || (!pairLocked && !secondsLeft(pairExpiresAt));
            find('pair-lock').disabled = working || !online || !pairing.offer || !pairEnabled;
            find('pair-close').disabled = working || !online || !pairEnabled;
            find('history-more').hidden = !historyState || !history.length || history[0].id <= historyState.oldestId;
            find('history-more').disabled = !online || loadingOlder;
            setText(find('history-more'), loadingOlder ? 'syncLoadingOlder' : 'syncLoadOlder');
            devicesDialog.querySelectorAll('[data-sync-device-save], [data-sync-device-remove]').forEach((button) => {
                button.disabled = working || sending || !online;
            });
            for (const message of outbox.values()) {
                const retry = messageNodes.get(message.id)?.querySelector('[data-sync-retry-message]');
                if (retry) retry.disabled = working || !online || (message.attachment ? !!uploadController || !(pendingUpload?.clientId === message.clientId && pendingUpload.file instanceof File) : sendingText);
            }
            renderSpaces();
            if (reconcileNeeded && !spaceSwitchBlocked()) { reconcileNeeded = false; queueMicrotask(reconcileSession); }
        };
        const updateCountdowns = () => {
            for (const [action, key] of [['create', 'syncCreate'], ['join', 'syncJoin'], ['pair', 'syncPair']]) {
                const seconds = secondsLeft(cooldowns[action]);
                const button = find(action);
                const label = action === 'pair' && !pairEnabled ? 'syncPairOpen' : key;
                button.dataset.i18n = seconds ? '' : label;
                button.textContent = translate(seconds ? (action === 'pair' ? 'syncPairCooldown' : 'syncRetryAfter') : label, { seconds });
            }
            const seconds = secondsLeft(pairExpiresAt);
            if (!pairLocked && pairExpiresAt && !seconds) {
                pairExpiresAt = 0;
                find('pairing').hidden = true;
                find('pair-code').textContent = '';
                setNotice('syncCodeExpired');
            }
            find('pair-expiry').textContent = !pairEnabled ? translate('syncPairClosed') : pairLocked ? translate('syncPairLocked')
                : seconds ? translate('syncPairExpires', { minutes: Math.floor(seconds / 60), seconds: String(seconds % 60).padStart(2, '0') }) : '';
            setText(find('pair-hint'), !pairEnabled ? 'syncPairClosedHint' : pairLocked ? 'syncPairLockedHint' : 'syncPairOnline');
            const lockButton = find('pair-lock');
            lockButton.setAttribute('aria-pressed', String(pairLocked));
            lockButton.setAttribute('aria-label', translate(pairLocked ? 'syncPairUnlock' : 'syncPairLock'));
            lockButton.title = lockButton.getAttribute('aria-label');
            find('pair-locked-icon').toggleAttribute('hidden', !pairLocked);
            find('pair-unlocked-icon').toggleAttribute('hidden', pairLocked);
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
            gameWindow?.setOnline(value);
            if (!value && recording()) cancelRecording();
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
                pairing_conflict: 'syncPairChanged', pairing_closed: 'syncPairClosed',
                game_not_found: 'syncGameUnavailable', game_busy: 'syncGameBusy', game_conflict: 'syncGameChanged',
                game_not_player: 'syncGameSpectating', game_not_turn: 'syncGameChanged', game_invalid_move: 'syncGameInvalidMove',
                encryption_unavailable: 'syncEncryptionUnavailable',
                network_error: 'syncNetworkError', encryption_load_failed: 'syncEncryptionLoadFailed'
            };
            if (['rate_limited', 'pairing_limited'].includes(error.code) && action && error.retryAfter > 0) {
                cooldowns[action] = Date.now() + error.retryAfter * 1000;
                startCountdowns();
            }
            setNotice(keys[error.code] || (error.name === 'TimeoutError' ? 'syncNetworkError' : 'syncError'), true);
        };
        const decodeMessage = async (message, session) => {
            try {
                const payload = await decryptPayload(session.keyring, session.roomId, `message:${message.deviceId}:${message.clientId}`, message.text);
                if (typeof payload.text !== 'string' || payload.text.length > 10000) throw new Error('invalid_message');
                if (payload.sticker !== undefined && (!stickerById(payload.sticker) || payload.attachment)) throw new Error('invalid_sticker');
                if (payload.gomoku !== undefined && (payload.gomoku !== message.clientId || payload.attachment || payload.sticker
                    || !message.game || message.game.id !== payload.gomoku)) throw new Error('invalid_game');
                if (payload.reply && (!Number.isSafeInteger(payload.reply.id) || payload.reply.id < 1
                    || typeof payload.reply.deviceId !== 'string' || !/^[0-9a-f-]{36}$/i.test(payload.reply.deviceId)
                    || typeof payload.reply.text !== 'string' || Array.from(payload.reply.text).length > 300
                    || (payload.reply.sticker !== undefined && !stickerById(payload.reply.sticker))
                    || typeof payload.reply.attachmentName !== 'string' || Array.from(payload.reply.attachmentName).length > 256)) throw new Error('invalid_reply');
                if (payload.attachment && (typeof payload.attachment.name !== 'string' || typeof payload.attachment.key !== 'string'
                    || !Number.isSafeInteger(payload.attachment.size) || payload.attachment.size < 0 || payload.attachment.size > MAX_FILE_BYTES)) throw new Error('invalid_attachment');
                if (payload.attachment?.kind === 'voice' && (!['audio/wav', 'audio/webm'].includes(payload.attachment.type)
                    || !Number.isSafeInteger(payload.attachment.durationMs) || payload.attachment.durationMs < 1 || payload.attachment.durationMs > 60000
                    || payload.attachment.size <= 44 || payload.attachment.size > 44 + 16000 * 2 * 60)) throw new Error('invalid_voice');
                return { ...message, text: payload.text, sticker: payload.sticker, gomoku: payload.gomoku, attachment: payload.attachment || null, reply: payload.reply || null };
            } catch {
                setNotice('syncDecryptFailed', true);
                return { ...message, text: '', attachment: null, reply: null, decryptionFailed: true };
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
                const abort = () => {
                    xhr.abort();
                    cleanup();
                    reject(signal.reason.name === 'TimeoutError'
                        ? Object.assign(new Error(signal.reason.message), { name: 'TimeoutError', code: 'network_error' }) : signal.reason);
                };
                xhr.open(options.method, base + path);
                for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
                xhr.upload.addEventListener('progress', (event) => options.uploadProgress(event.loaded));
                xhr.addEventListener('load', () => {
                    cleanup();
                    resolve(new Response(xhr.responseText, { status: xhr.status, headers: { 'Retry-After': xhr.getResponseHeader('Retry-After') || '' } }));
                });
                xhr.addEventListener('error', () => { cleanup(); reject(Object.assign(new TypeError('Upload network request failed'), { code: 'network_error' })); });
                signal.addEventListener('abort', abort, { once: true });
                xhr.send(options.body);
            }) : await fetch(base + path, { ...options, headers, signal }).catch(error => {
                if (error instanceof TypeError) error.code = 'network_error';
                else if (error.name === 'TimeoutError') throw Object.assign(new Error(error.message), { name: 'TimeoutError', code: 'network_error' });
                throw error;
            });
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
                    game: result.game,
                    retryAfter: Number.isFinite(seconds) ? seconds : Math.max(0, (Date.parse(retryAfter) - Date.now()) / 1000)
                });
            }
            if (result === null) return null;
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
        const persistSession = async (session, activate = false) => {
            await spacesReady;
            await savedSpaces.save(session, { activate });
            renderSpaces();
        };
        const pairing = new EncryptedPairing({ api, getSession: () => credentials,
            getSavedSession: session => session ? savedSpaces.find(session) : addingSpace ? null : savedSession(), onAccepted: async (session) => {
            if (credentials !== session) return;
            await refreshKeys(session);
            if (credentials === session) await refreshPairing(session);
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
                        if (credentials !== session) return;
                        session.keyring = next.keyring;
                        session.trustedDevices = next.trustedDevices;
                        session.revokedDevices = next.revokedDevices;
                        if (session.revokedDevices.some(id => !revoked.has(id))) { cancelRecording(); pauseVoiceMedia(); }
                        if (pendingUpload && session.revokedDevices.some(id => !revoked.has(id))) {
                            uploadController?.abort(Object.assign(new Error('key_changed'), { code: 'key_changed' }));
                            discardUpload(true);
                        }
                    }
                    if (result.grants.length) {
                        await persistSession(session);
                        await api(`/v1/spaces/${session.roomId}/key-grants`, { method: 'DELETE', body: JSON.stringify({ through: result.grants.at(-1).id }) }, session);
                        if (credentials !== session) return;
                        pairing.resetHost();
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
            if (!credentials) return Promise.resolve(true);
            const session = credentials;
            const revision = ++draftRevision;
            const upload = pendingUpload && {
                clientId: pendingUpload.clientId, uploadId: pendingUpload.uploadId, text: pendingUpload.text, reply: pendingUpload.reply, voice: pendingUpload.voice, fingerprint: pendingUpload.fingerprint, receivedBytes: pendingUpload.receivedBytes || 0,
                encryption: pendingUpload.encryption, encryptedText: pendingUpload.encryptedText, keyId: pendingUpload.keyId, revokedDevices: pendingUpload.revokedDevices,
                file: { name: pendingUpload.file.name, type: pendingUpload.file.type, size: pendingUpload.file.size, lastModified: pendingUpload.file.lastModified }
            };
            const key = draftKey();
            return encryptPayload(session.keyring, session.roomId, `draft:${session.deviceId}`, { text: input.value, reply: selectedReply, outbox: [...outbox.values()], upload })
                .then(encrypted => {
                    if (revision !== draftRevision) return false;
                    sessionStorage.setItem(key, encrypted);
                    return true;
                })
                .catch(() => { if (credentials === session) setNotice('syncStorageError', true); return false; });
        };
        const formatSize = (bytes) => bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${(bytes / 1024 ** 3).toFixed(1)} GB`;
        const updateSelectedFile = () => {
            const file = selectedFile || pendingUpload?.file;
            const voice = selectedVoice || pendingUpload?.voice;
            find('selected-file').hidden = !file;
            find('file-name').textContent = file && voice ? `${translate('syncVoiceMessage')} · ${voiceTime(voice.durationMs)}` : file?.name || '';
            find('file-size').textContent = file ? formatSize(file.size) : '';
            const preview = find('voice-preview');
            if (voice && file instanceof File && !uploadController) {
                if (voicePreviewFile !== file) {
                    releaseVoicePreview();
                    voicePreviewFile = file;
                    voicePreviewUrl = URL.createObjectURL(file);
                    preview.src = voicePreviewUrl;
                }
                preview.hidden = false;
            } else if (voicePreviewUrl) releaseVoicePreview();
            find('upload-status').hidden = !uploadController || !pendingUpload;
            if (uploadController && pendingUpload) {
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
            find('upload-progress').hidden = !uploadController || !pendingUpload;
            updateControls();
        };
        const disposeAttachment = (id) => {
            voicePlayers.get(id)?.dispose();
            voicePlayers.delete(id);
            inlineImages.get(id)?.dispose();
            inlineImages.delete(id);
            imageResources.get(id)?.dispose();
            imageResources.delete(id);
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
            if (type.startsWith('audio/') || ['mp3', 'm4a', 'aac', 'wav', 'oga', 'opus', 'flac'].includes(extension)) return 'audio';
            if (['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime'].includes(type) || ['mp4', 'webm', 'ogg', 'ogv', 'mov', 'm4v'].includes(extension)) return 'video';
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
            const result = await attachmentTicket(message, session);
            return `${base}/v1/spaces/${session.roomId}/downloads/${encodeURIComponent(result.ticket)}`;
        };
        const encryptedFile = async (message, session, download) => {
            const key = `${message.id}:${crypto.randomUUID()}`;
            {
                const promise = Promise.all([attachmentUrl(message, session), prepareEncryptedFiles()])
                    .then(([url]) => openEncryptedFile({ url, metadata: message.attachment, download, refresh: async () => {
                        if (credentials !== session || !messageNodes.has(message.id)) throw new DOMException('Session ended', 'AbortError');
                        downloadTickets.delete(message.id);
                        const nextUrl = await attachmentUrl(message, session);
                        if (credentials !== session || !messageNodes.has(message.id)) throw new DOMException('Session ended', 'AbortError');
                        return nextUrl;
                    } }))
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
            const downloading = {};
            downloads.add(downloading);
            updateControls();
            button.disabled = true;
            button.dataset.loading = 'true';
            button.textContent = translate('syncDownloading');
            try {
                const capability = await encryptedFile(message, session, true);
                if (credentials !== session || !messageNodes.has(message.id)) {
                    capability.dispose(); downloads.delete(downloading); updateControls(); return;
                }
                const frame = document.createElement('iframe');
                frame.hidden = true;
                frame.src = capability.url;
                document.body.append(frame);
                capability.closed.then(() => frame.remove());
                capability.result.then(result => {
                    if (result.status === 'failed' && credentials === session && messageNodes.has(message.id)) showAttachmentError(new Error('encrypted_file_unavailable'));
                }).finally(() => {
                    downloads.delete(downloading);
                    updateControls();
                });
            } catch (error) {
                downloads.delete(downloading);
                updateControls();
                if (credentials === session && messageNodes.has(message.id) && error.name !== 'AbortError') showAttachmentError(error);
            } finally {
                button.disabled = false;
                delete button.dataset.loading;
                button.textContent = translate('syncDownload');
            }
        };
        const previewAttachment = async (message, button) => {
            if (message.sendState || button.disabled) return;
            const session = credentials;
            const kind = previewKind(message.attachment);
            const limit = ['image', 'heic'].includes(kind) ? 20 : kind === 'text' ? 2 : 25;
            if (!['pdf', 'video', 'audio'].includes(kind) && message.attachment.size > limit * 1024 * 1024) {
                setNotice('syncPreviewTooLarge', true);
                return;
            }
            button.disabled = true;
            try {
                if (imageResources.has(message.id)) {
                    attachmentPreview.open({ id: message.id, name: message.attachment.name, kind,
                        imageResource: imageResources.get(message.id) });
                    return;
                }
                await attachmentPreview.open({
                    id: message.id, name: message.attachment.name, kind,
                    load: () => encryptedFile(message, session, false)
                });
            } catch (error) {
                if (credentials === session && active && messageNodes.has(message.id)) showAttachmentError(error);
            } finally { button.disabled = false; }
        };
        const atBottom = () => feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
        const updateInlineImages = () => {
            const visible = !room.hidden && active && viewingDesktop && !document.hidden && !app.closest('[inert]')
                && !app.classList.contains('is-closed') && !app.classList.contains('is-minimized');
            inlineImages.forEach((image, id) => visible && !messageNodes.get(id)?.hidden ? image.start() : image.pause());
            if (!visible) imageResources.forEach(resource => resource.clear());
        };
        const isReading = () => !room.hidden && active && browserFocused && document.hasFocus() && !document.hidden
            && performance.now() - lastInteraction < 60000 && app.classList.contains('is-active')
            && !app.classList.contains('is-minimized') && !find('search').value.trim()
            && !app.closest('[inert]') && !devicesDialog.open && !confirmation.open && !stickerDialog.open;
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
            const ownReadId = readReceipts.get(deviceId) || 0;
            for (const id of unread) if (id <= ownReadId) unread.delete(id);
            updateReadReceipts();
            updateUnread();
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
        const deviceLabel = (id) => {
            const index = devices.findIndex((device) => device.deviceId === id);
            return devices[index]?.name || translate('syncDeviceDefault', { id: index >= 0 ? index + 1 : id.slice(0, 8) });
        };
        const rememberGame = (game) => {
            const previous = games.get(game.id);
            if (previous?.revision > game.revision) return previous;
            const next = previous?.revision === game.revision ? { ...previous, ...game } : { ...game };
            if (previous?.revision === game.revision && previous.board && !game.board) next.lastMove = previous.lastMove;
            if (!isGameActive(next)) { delete next.board; next.lastMove = null; }
            games.set(game.id, next);
            return next;
        };
        const acceptGame = (game, open = false) => {
            const previous = games.get(game.id);
            const next = rememberGame(game);
            if (!isGameActive(next)) {
                if (gameWindow.currentId === next.id) {
                    gameWindow.close();
                    entry.show();
                    setNotice(next.status === 'finished' ? 'syncGameFinished' : 'syncGameCancelled');
                }
            } else if (next.board) {
                if (open || (isGamePlayer(next) && next.status === 'playing' && previous?.status === 'waiting')) gameWindow.show(next);
                else if (gameWindow.currentId === next.id) gameWindow.update(next);
            }
            render();
            return next;
        };
        const readGame = async (id, open = false) => {
            const session = credentials;
            try {
                const { game } = await api(roomPath(`/gomoku/${id}`));
                if (credentials === session) return acceptGame(game, open);
            } catch (error) {
                if (credentials !== session) return;
                if (error.code === 'game_not_found') {
                    const previous = games.get(id);
                    if (previous) acceptGame({ ...previous, status: 'cancelled', revision: previous.revision + 1 });
                }
                throw error;
            }
        };
        const synchronizeGames = async (activeGames, restore = false) => {
            if (!activeGames) return;
            const ids = new Set(activeGames.map(game => game.id));
            const missing = [...games.values()].filter(game => isGameActive(game) && !ids.has(game.id));
            for (const game of activeGames) acceptGame(game, restore && isGamePlayer(game) && !gameWindow.currentId);
            await Promise.all(missing.map(game => readGame(game.id).catch(error => {
                if (error.code !== 'game_not_found') showError(error);
            })));
        };
        const gameAction = async (id, action, body = {}) => {
            if (!online || gameCommands.has(id)) throw Object.assign(new Error('game_unavailable'), { code: online ? 'game_conflict' : 'network_error' });
            const session = credentials;
            gameCommands.add(id);
            render();
            try {
                const { game } = await api(roomPath(`/gomoku/${id}/${action}`), { method: 'POST', body: JSON.stringify(body) });
                if (credentials === session) return acceptGame(game, action === 'join');
            } catch (error) {
                if (credentials === session) {
                    if (error.game) acceptGame(error.game);
                    else await readGame(id).catch(() => {});
                    showError(error);
                }
                throw error;
            } finally {
                gameCommands.delete(id);
                if (credentials === session) render();
            }
        };
        const renderGameCard = (card, message) => {
            if (message.game) rememberGame(message.game);
            const game = games.get(message.gomoku);
            card.dataset.syncGameCard = message.gomoku;
            card.querySelector('[data-sync-game-title]').textContent = translate('syncGameTitle');
            const players = card.querySelector('[data-sync-game-players]');
            players.textContent = game ? `${deviceLabel(game.hostDeviceId)} ${translate('syncGameVersus')} ${game.guestDeviceId ? deviceLabel(game.guestDeviceId) : translate('syncGameWaitingPlayer')}` : deviceLabel(message.deviceId);
            const state = card.querySelector('[data-sync-game-state]');
            state.textContent = translate(game?.status === 'playing' ? 'syncGameInProgress' : game?.status === 'finished' ? 'syncGameFinished'
                : game?.status === 'cancelled' ? 'syncGameCancelled' : 'syncGameWaiting');
            const result = card.querySelector('[data-sync-game-result]');
            result.hidden = game?.status !== 'finished';
            players.hidden = !result.hidden;
            card.classList.toggle('is-finished', !result.hidden);
            if (!result.hidden) {
                const score = game.result;
                for (const side of ['host', 'guest']) {
                    const seat = result.querySelector(`[data-sync-game-side="${side}"]`);
                    const won = score.winnerDeviceId === game[`${side}DeviceId`];
                    seat.classList.toggle('is-winner', won);
                    seat.querySelector('[data-sync-game-name]').textContent = deviceLabel(game[`${side}DeviceId`]);
                    seat.querySelector('[data-sync-game-outcome]').textContent = translate(!score.winnerDeviceId ? 'syncGameDraw' : won ? 'syncGameWon' : 'syncGameLost');
                    seat.querySelector('[data-sync-game-moves]').textContent = translate('syncGameMoves', { moves: score[`${side}Moves`] });
                    const stone = seat.querySelector('.sync-game-piece');
                    stone.title = translate(side === 'host' ? 'syncGameBlack' : 'syncGameWhite');
                }
                result.querySelector('[data-sync-game-score-label]').textContent = translate('syncGameScore');
                result.querySelector('[data-sync-game-score]').textContent = `${score.hostScore} : ${score.guestScore}`;
            }
            const player = isGamePlayer(game);
            const waiting = game?.status === 'waiting';
            const playing = game?.status === 'playing';
            for (const [name, key, visible] of [['join', 'syncGameJoin', waiting && !player], ['watch', 'syncGameWatch', playing && !player], ['open', 'syncGameOpen', (waiting || playing) && player]]) {
                const button = card.querySelector(`[data-sync-game-${name}]`);
                button.textContent = translate(key);
                button.hidden = !visible;
                button.disabled = !online || !!message.sendState || gameCommands.has(message.gomoku)
                    || (name === 'join' && !!ownGame());
            }
        };
        const replySummary = (reply) => [reply.text, reply.sticker && `[${stickerName(reply.sticker)}]`, reply.attachmentName && `${translate('syncReplyAttachment')} ${reply.attachmentName}`].filter(Boolean).join('\n');
        const renderReply = () => {
            find('reply').hidden = !selectedReply;
            find('reply-author').textContent = selectedReply ? deviceLabel(selectedReply.deviceId) : '';
            find('reply-text').textContent = selectedReply ? replySummary(selectedReply) : '';
            find('reply-cancel').setAttribute('aria-label', translate('syncReplyCancel'));
        };
        const applySearch = () => {
            const query = find('search').value.trim().toLocaleLowerCase();
            let count = 0;
            for (const message of [...history, ...outbox.values()]) {
                const text = message.decryptionFailed ? translate('syncDecryptFailed') : message.text;
                const match = !query || [text, stickerName(message.sticker), message.gomoku ? translate('syncGameTitle') : '', message.attachment?.name || '', deviceLabel(message.deviceId)]
                    .some((value) => value.toLocaleLowerCase().includes(query));
                messageNodes.get(message.id).hidden = !match;
                if (!match) voicePlayers.get(message.id)?.pause();
                if (match) count++;
            }
            find('empty').hidden = history.length !== 0 || outbox.size !== 0 || !!query;
            find('no-results').hidden = !query || count !== 0;
            setText(find('no-results'), searchController && !searchController.signal.aborted ? 'syncSearching'
                : historyState && history[0]?.id > historyState.oldestId ? 'syncSearchIncomplete' : 'syncNoResults');
            updateInlineImages();
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
                    const reply = document.createElement('button');
                    reply.type = 'button';
                    reply.className = 'sync-message-reply-action';
                    reply.dataset.syncReplyMessage = '';
                    reply.addEventListener('click', () => {
                        selectedReply = {
                            id: message.id, deviceId: message.deviceId,
                            text: Array.from(message.text || (message.gomoku ? translate('syncGameTitle') : '')).slice(0, 300).join(''),
                            ...(message.sticker ? { sticker: message.sticker } : {}),
                            attachmentName: Array.from(message.attachment?.name || '').slice(0, 256).join('')
                        };
                        renderReply();
                        saveDraft();
                        input.focus();
                    });
                    meta.append(label, receipt, reply, copy);
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
                    item.append(meta);
                    if (message.reply) {
                        const quote = document.createElement('blockquote');
                        quote.className = 'sync-message-quote';
                        const author = document.createElement('strong');
                        author.className = 'sync-message-quote-author';
                        const excerpt = document.createElement('span');
                        excerpt.className = 'sync-message-quote-text';
                        quote.append(author, excerpt);
                        item.append(quote);
                    }
                    item.append(text);
                    if (message.gomoku) {
                        const card = document.createElement('section');
                        card.className = 'sync-game-card';
                        card.innerHTML = `<div class="sync-game-card-heading"><strong data-sync-game-title></strong><span data-sync-game-state></span></div>
                            <p data-sync-game-players></p>
                            <div class="sync-game-scoreboard" data-sync-game-result hidden>
                                <div class="sync-game-side" data-sync-game-side="host">
                                    <span class="sync-game-piece sync-game-piece--black" aria-hidden="true"></span>
                                    <strong data-sync-game-name></strong><span class="sync-game-outcome" data-sync-game-outcome></span><span class="sync-game-moves" data-sync-game-moves></span>
                                </div>
                                <div class="sync-game-score"><span data-sync-game-score-label></span><strong data-sync-game-score></strong></div>
                                <div class="sync-game-side" data-sync-game-side="guest">
                                    <span class="sync-game-piece sync-game-piece--white" aria-hidden="true"></span>
                                    <strong data-sync-game-name></strong><span class="sync-game-outcome" data-sync-game-outcome></span><span class="sync-game-moves" data-sync-game-moves></span>
                                </div>
                            </div>
                            <div class="sync-game-card-actions"><button type="button" class="sync-button" data-sync-game-join></button><button type="button" class="sync-button" data-sync-game-watch></button><button type="button" class="sync-button" data-sync-game-open></button></div>`;
                        card.querySelector('[data-sync-game-join]').addEventListener('click', () => gameAction(message.gomoku, 'join').catch(() => {}));
                        for (const action of ['watch', 'open']) card.querySelector(`[data-sync-game-${action}]`).addEventListener('click', () => readGame(message.gomoku, true).catch(showError));
                        item.append(card);
                    }
                    if (message.sticker) {
                        const sticker = stickerById(message.sticker);
                        const button = document.createElement('button');
                        button.type = 'button';
                        button.className = 'sync-message-sticker';
                        button.dataset.syncSticker = sticker.id;
                        const image = document.createElement('img');
                        image.src = sticker.url;
                        image.width = 112;
                        image.height = 112;
                        button.append(image);
                        button.addEventListener('click', () => attachmentPreview.open({
                            id: `sticker:${sticker.id}`, name: stickerName(sticker.id), kind: 'sticker', stickerId: sticker.id, url: sticker.url
                        }));
                        item.append(button);
                    }
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
                        const info = document.createElement(previewKind(message.attachment) ? 'button' : 'div');
                        info.className = 'sync-attachment-info';
                        info.append(name, size);
                        if (previewKind(message.attachment)) {
                            info.type = 'button';
                            info.dataset.syncPreviewFile = '';
                            info.disabled = !!message.sendState;
                            info.addEventListener('click', () => previewAttachment(message, info));
                            item.classList.add('has-preview');
                            item.addEventListener('click', (event) => {
                                if (event.target.closest('button, a, input, audio, video, .sync-message-quote') || window.getSelection()?.toString()) return;
                                previewAttachment(message, info);
                            });
                        }
                        attachment.append(info, actions);
                        item.append(attachment);
                    }
                    messageNodes.set(message.id, item);
                    if (!message.sendState && message.attachment?.kind === 'voice') {
                        const session = credentials;
                        const player = createVoicePlayer({
                            durationMs: message.attachment.durationMs,
                            translate,
                            load: () => encryptedFile(message, session, false),
                            canPlay: () => credentials === session && !recording() && voiceVisible() && !item.hidden && messageNodes.has(message.id),
                            onStart: () => {
                                find('voice-preview').pause();
                                voicePlayers.forEach((other, id) => { if (id !== message.id) other.pause(); });
                            },
                            onError: () => setNotice('syncVoicePlaybackFailed', true)
                        });
                        item.insertBefore(player.element, item.querySelector('.sync-attachment'));
                        voicePlayers.set(message.id, player);
                    }
                    if (!message.sendState && message.attachment && ['image', 'heic'].includes(previewKind(message.attachment))
                        && message.attachment.size <= 20 * 1024 * 1024) {
                        const session = credentials;
                        const resource = createImageResource({
                            kind: previewKind(message.attachment), name: message.attachment.name,
                            load: () => encryptedFile(message, session, false)
                        });
                        imageResources.set(message.id, resource);
                        const image = createInlineImage({
                            name: message.attachment.name,
                            viewport: feed,
                            retryLabel: () => translate('syncImageRetry'),
                            previewLabel: () => translate('syncPreview'),
                            resource,
                            onPreview: () => previewAttachment(message, item.querySelector('[data-sync-preview-file]')),
                            onLoad: () => { if (followLatest) scrollToLatest(); }
                        });
                        item.insertBefore(image.element, item.querySelector('.sync-attachment'));
                        inlineImages.set(message.id, image);
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
                if (message.decryptionFailed) {
                    const text = item.querySelector('.sync-message-text');
                    text.textContent = translate('syncDecryptFailed');
                    text.hidden = false;
                }
                const label = `${deviceLabel(message.deviceId)} · ${new Date(message.createdAt).toLocaleString(desktopApi.getLanguage())}`;
                if (item.firstChild.firstChild.textContent !== label) item.firstChild.firstChild.textContent = label;
                const copy = item.querySelector('[data-sync-copy-message]');
                copy.textContent = translate('syncCopy');
                const reply = item.querySelector('[data-sync-reply-message]');
                reply.textContent = translate('syncReply');
                reply.hidden = !!message.sendState || !!message.decryptionFailed;
                const gameCard = item.querySelector('.sync-game-card');
                if (gameCard) renderGameCard(gameCard, message);
                const sticker = item.querySelector('[data-sync-sticker]');
                if (sticker) {
                    sticker.setAttribute('aria-label', `${translate('syncStickerPreview')} ${stickerName(message.sticker)}`);
                    sticker.querySelector('img').alt = stickerName(message.sticker);
                }
                if (message.reply) {
                    item.querySelector('.sync-message-quote-author').textContent = deviceLabel(message.reply.deviceId);
                    item.querySelector('.sync-message-quote-text').textContent = replySummary(message.reply);
                }
                const download = item.querySelector('[data-sync-download-file]');
                if (download) {
                    download.textContent = translate(download.dataset.loading ? 'syncDownloading' : 'syncDownload');
                    download.disabled = !!message.sendState || !!download.dataset.loading;
                }
                const preview = item.querySelector('[data-sync-preview-file]');
                if (preview) {
                    preview.title = translate('syncPreview');
                    preview.setAttribute('aria-label', `${translate('syncPreview')} ${message.attachment.name}`);
                }
                voicePlayers.get(message.id)?.updateLanguage();
                if (messages.children[index] !== item) messages.insertBefore(item, messages.children[index] || null);
            });
            applySearch();
            updateReadReceipts();
            if (follow) {
                feed.scrollTop = feed.scrollHeight;
                lastFeedScrollTop = feed.scrollTop;
                scrollToLatest();
            }
            updateInlineImages();
            markRead();
            updateUnread();
            updateControls();
            renderReply();
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
                selectedVoice = null;
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
            const openInvitation = !!message.gomoku && outbox.has(message.clientId);
            reconcileUpload([message]);
            const known = history.some((item) => item.id === message.id);
            const trimming = metadata?.oldestId > history[0]?.id || !known && history.length >= 500;
            const top = feed.getBoundingClientRect().top;
            const anchor = trimming && !followLatest && history.find((item) => item.id >= (metadata?.oldestId || 0)
                && !messageNodes.get(item.id)?.hidden && messageNodes.get(item.id)?.getBoundingClientRect().bottom > top);
            const offset = anchor ? messageNodes.get(anchor.id).getBoundingClientRect().top - top : 0;
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
            if (!known) {
                if (message.deviceId !== deviceId) {
                    unread.add(message.id);
                    readAfterInteraction = interactionRevision + 1;
                    if (notify) notifyMessage(message);
                }
                history = [...history, message].sort((a, b) => a.id - b.id).slice(-500);
            }
            render();
            if (openInvitation) readGame(message.gomoku, true).catch(showError);
            const node = anchor && messageNodes.get(anchor.id);
            if (node) {
                feed.scrollTop += node.getBoundingClientRect().top - feed.getBoundingClientRect().top - offset;
                lastFeedScrollTop = feed.scrollTop;
            }
        };
        let connectionTimer = null;
        const disconnect = () => {
            searchController?.abort();
            catchupController?.abort();
            catchupController = null;
            clearTimeout(retryTimer);
            clearTimeout(connectionTimer);
            clearInterval(pingTimer);
            retryTimer = null;
            connectionTimer = null;
            const previous = socket;
            socket = null;
            previous?.close();
            setConnection(false);
        };
        const retry = () => {
            if ((!active && !needsGameConnection()) || !credentials) return;
            clearTimeout(retryTimer);
            retryTimer = setTimeout(connect, retryDelay + Math.random() * retryDelay * 0.25);
            retryDelay = Math.min(retryDelay * 2, 30000);
        };
        const connect = async () => {
            if ((!active && !needsGameConnection()) || !credentials || socket) return;
            const session = credentials;
            setText(status, 'syncConnecting', 'connecting');
            const base = await loadConfig();
            if ((!active && !needsGameConnection()) || credentials !== session || socket) return;
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
            connectionTimer = setTimeout(() => {
                if (socket !== connection) return;
                disconnect();
                retry();
            }, 30000);
            connection.addEventListener('open', () => {
                if (socket === connection) connection.send(JSON.stringify({ type: 'auth', token: session.token }));
            });
            const receive = async (event) => {
                if (socket !== connection) return;
                if (event.data === 'pong') { awaitingPong = false; return; }
                let data;
                try { data = JSON.parse(event.data); } catch { return; }
                if (data.type === 'ready') {
                    const pairingAtReady = pairingRevision;
                    authenticated = true;
                    const initial = deviceId === null;
                    deviceId = data.deviceId;
                    mergeReadReceipts(data.readReceipts || []);
                    await refreshKeys(session);
                    if (socket !== connection || credentials !== session) return;
                    if (data.rekeyRequired) await rotateKeys(null);
                    if (socket !== connection || credentials !== session) return;
                    if (pairingRevision === pairingAtReady) await showPairing(data.pairing);
                    if (socket !== connection || credentials !== session) return;
                    const incomingMessages = await Promise.all(data.messages.map(message => decodeMessage(message, session)));
                    if (socket !== connection || credentials !== session) return;
                    receiveHistory(incomingMessages, initial, data.historyMode, data.history);
                    await synchronizeGames(data.activeGames, true);
                    if (socket !== connection || credentials !== session) return;
                    if (restoringGame) {
                        restoringGame = false;
                        if (!active && !gameWindow.currentId) entry.show();
                    }
                    catchUp(data.history);
                    if (find('search').value.trim()) {
                        clearTimeout(searchTimer);
                        searchTimer = setTimeout(searchHistory, 180);
                    }
                    if (notice.dataset.i18n === 'syncUnavailable') setNotice('syncJoined');
                    loadDevices();
                    clearInterval(pingTimer);
                    pingTimer = setInterval(() => {
                        if (awaitingPong) connection.close();
                        else if (connection.readyState === WebSocket.OPEN) {
                            awaitingPong = true;
                            connection.send('ping');
                        }
                    }, 30000);
                    initialized = true;
                    retryDelay = 1000;
                    clearTimeout(connectionTimer);
                    connectionTimer = null;
                    setConnection(true);
                    markRead();
                } else if (data.type === 'message') {
                    const message = await decodeMessage(data.message, session);
                    if (socket === connection && credentials === session) {
                        addMessage(message, data.history, true, initialized);
                        await synchronizeGames(data.activeGames);
                    }
                }
                else if (data.type === 'gomoku') acceptGame(data.game);
                else if (data.type === 'read') { mergeReadReceipts([data]); }
                else if (data.type === 'pairing') await showPairing(data.pairing);
                else if (data.type === 'pair-request' || data.type === 'pair-finish') {
                    const offer = pairing.offer;
                    pairing.handle(data).catch(error => {
                        if (credentials === session && socket === connection && pairing.offer === offer
                            && error.name !== 'AbortError' && error.code !== 'invalid_code') showError(error);
                    });
                }
                else if (data.type === 'key-rotation') {
                    await refreshKeys(session);
                    if (socket === connection && credentials === session) { await refreshPairing(session); await loadDevices(); }
                }
                else if (data.type === 'rekey-required') await rotateKeys(null);
                else if (data.type === 'history') {
                    mergeReadReceipts(data.readReceipts || []);
                    const incomingMessages = await Promise.all(data.messages.map(message => decodeMessage(message, session)));
                    if (socket === connection && credentials === session) {
                        receiveHistory(incomingMessages, false, data.historyMode, data.history);
                        await synchronizeGames(data.activeGames);
                    }
                }
                else if (data.type === 'devices') loadDevices();
                else if (data.type === 'cleared') {
                    games.clear();
                    gameWindow.close();
                    uploadController?.abort(Object.assign(new Error('history_cleared'), { code: 'history_cleared' }));
                    pendingUpload = null;
                    outbox.clear();
                    selectedReply = null;
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
                clearTimeout(connectionTimer);
                connectionTimer = null;
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
            if (value?.revision && value.revision < Math.max(pairPolicyRevision, pairing.policy?.revision || 0)) return;
            const revision = ++pairingRevision;
            const session = credentials;
            const offer = await pairing.readOffer(value, session);
            if (revision !== pairingRevision || session !== credentials) return;
            if (offer?.offerId !== displayedOfferId) find('pairing').open = !!offer;
            displayedOfferId = offer?.offerId || null;
            pairExpiresAt = offer?.expiresAt || 0;
            pairLocked = value?.locked === true;
            pairEnabled = value?.enabled !== false;
            pairPolicyRevision = value?.revision || 0;
            find('pairing').hidden = !offer && pairEnabled && !pairLocked;
            find('pair-code').closest('.sync-pairing-heading').hidden = !offer;
            find('pair-code').textContent = offer?.code || '';
            startCountdowns();
            if (offer?.ownerDeviceId === session?.deviceId) {
                pairing.resume().catch(error => { if (credentials === session && error.code !== 'invalid_code') showError(error); });
            }
            if (!offer && pairLocked && pairEnabled && session && !offerRenewal) {
                const renewal = { session };
                offerRenewal = renewal;
                try {
                    await refreshKeys(session);
                    if (credentials !== session || pairingRevision !== revision) return;
                    // Key refresh resets the PAKE state; restore the encrypted fixed-code policy.
                    pairing.policy = value;
                    const next = await pairing.createOffer({ reopen: false });
                    if (credentials === session) await showPairing(next);
                } catch (error) {
                    if (credentials === session) {
                        if (['pairing_closed', 'pairing_conflict', 'key_changed'].includes(error.code)) await refreshPairing(session);
                        else showError(error);
                    }
                } finally {
                    if (offerRenewal === renewal) {
                        offerRenewal = null;
                        if (credentials === session && pairingRevision !== revision && pairLocked && pairEnabled && !pairing.offer) {
                            queueMicrotask(() => showPairing(pairing.policy).catch(showError));
                        }
                    }
                }
            }
        };
        const refreshPairing = async (session = credentials) => {
            const revision = pairingRevision;
            const value = await api(`/v1/spaces/${session.roomId}/pair-code`, {}, session);
            if (credentials === session && pairingRevision === revision) await showPairing(value);
        };
        const savedSession = () => savedSpaces.active();
        const sameSession = (a, b) => a?.roomId === b?.roomId && a?.token === b?.token && a?.revision === b?.revision;
        const reset = (forget = true) => {
            if (forget) restoringGame = false;
            games.clear();
            gameCommands.clear();
            gameWindow?.close();
            stickerDialog.close();
            cancelRecording();
            releaseVoicePreview();
            voicePlayers.forEach(player => player.dispose());
            voicePlayers.clear();
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
            inlineImages.forEach(image => image.dispose());
            inlineImages.clear();
            imageResources.forEach(resource => resource.dispose());
            imageResources.clear();
            downloadTickets.clear();
            fileCapabilities.forEach(promise => promise.then(capability => capability.dispose()).catch(() => {}));
            fileCapabilities.clear();
            downloads.clear();
            pairing.reset();
            attachmentPreview.close();
            if (confirmation.open) confirmation.close();
            if (devicesDialog.open) devicesDialog.close();
            if (spaceNameDialog.open) spaceNameDialog.close();
            disconnect();
            uploadController?.abort();
            uploadController = null;
            if (forget && credentials) {
                addingSpace = false;
                sessionStorage.removeItem(ADD_SPACE_KEY);
                const forgotten = credentials;
                spaceFiles.delete(forgotten.roomId);
                sessionStorage.removeItem(`portfolio-sync-draft:${forgotten.roomId}`);
                const removal = savedSpaces.remove(forgotten);
                forgettingSpace = removal;
                removal.then(() => {
                    if (forgettingSpace !== removal) return;
                    forgettingSpace = null;
                    renderSpaces();
                    reconcileSession();
                }).catch(() => {
                    if (forgettingSpace === removal) forgettingSpace = null;
                    setNotice('syncStorageError', true);
                });
            }
            draftRevision++;
            sessionVersion++;
            credentials = null;
            deviceId = null;
            devices = [];
            deviceRequest++;
            find('devices-list').replaceChildren();
            outbox.clear();
            selectedFile = null;
            selectedVoice = null;
            selectedReply = null;
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
            sendingText = false;
            leavingSession = null;
            followOnRestore = true;
            followLatest = true;
            pairExpiresAt = 0;
            pairLocked = false;
            pairEnabled = true;
            pairPolicyRevision = 0;
            offerRenewal = null;
            displayedOfferId = null;
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
            const wasSwitching = switchingSpace;
            switchingSpace = true;
            updateControls();
            try {
                const version = sessionVersion;
                if (!await saveDraft() || version !== sessionVersion) return false;
                if (credentials) {
                    if (selectedFile || pendingUpload) spaceFiles.set(credentials.roomId, {
                        token: credentials.token, selectedFile, selectedVoice, pendingFile: pendingUpload?.file,
                        clientId: pendingUpload?.clientId
                    });
                    else spaceFiles.delete(credentials.roomId);
                }
                reset(false);
                credentials = session;
                setup.hidden = !addingSpace;
                room.hidden = addingSpace;
                if (active) prepareEncryptedFiles().catch(() => {});
                try {
                    const encrypted = sessionStorage.getItem(draftKey());
                    const draft = encrypted ? await decryptPayload(session.keyring, session.roomId, `draft:${session.deviceId}`, encrypted) : null;
                    if (credentials !== session) return;
                    input.value = draft?.text || '';
                    selectedReply = draft?.reply || null;
                    pendingUpload = draft?.upload || null;
                    for (const message of draft?.outbox || []) {
                        if (!message.attachment || pendingUpload?.clientId === message.clientId) outbox.set(message.clientId, { ...message, sendState: 'failed' });
                    }
                    const files = spaceFiles.get(session.roomId);
                    if (files?.token === session.token) {
                        selectedFile = files.selectedFile;
                        selectedVoice = files.selectedVoice;
                        if (pendingUpload?.clientId === files.clientId && files.pendingFile instanceof File) pendingUpload.file = files.pendingFile;
                    }
                    if (pendingUpload && session.revokedDevices.some(id => !(pendingUpload.revokedDevices || []).includes(id))) discardUpload(true);
                } catch { input.value = ''; outbox.clear(); pendingUpload = null; selectedReply = null; }
                showPairing(session.pairing);
                render();
                updateSelectedFile();
                connect();
                return true;
            } finally {
                switchingSpace = wasSwitching;
                updateControls();
            }
        };
        const reconcileSession = () => {
            if (forgettingSpace) return forgettingSpace;
            if (reconcileTask) { reconcileNeeded = true; return reconcileTask; }
            reconcileTask = (async () => {
              try {
                await spacesReady;
                renderSpaces();
                const saved = savedSession();
                if (!sameSession(saved, credentials)) {
                    if (saved && saved.roomId !== credentials?.roomId && spaceSwitchBlocked()) {
                        reconcileNeeded = true;
                        return;
                    }
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
                            if (session.revokedDevices.some(id => !revoked.has(id))) { cancelRecording(); pauseVoiceMedia(); }
                            if (pendingUpload && session.revokedDevices.some(id => !revoked.has(id))) {
                                uploadController?.abort(Object.assign(new Error('key_changed'), { code: 'key_changed' }));
                                discardUpload(true);
                            }
                            if (keyChanged) { pairing.resetHost(); await showPairing(null); }
                            saveDraft();
                            await loadDevices();
                            return;
                        }
                        if (!await enter({ ...session, revision: saved.revision })) {
                            if (credentials && savedSpaces.find(credentials)) await savedSpaces.select(credentials.roomId);
                            return;
                        }
                        setNotice(pendingUpload ? 'syncUploadRestored' : 'syncJoined');
                    }
                    else { await saveDraft(); reset(false); setNotice('syncReady'); }
                }
              } catch { setNotice('syncStorageError', true); }
            })().finally(() => {
                reconcileTask = null;
                if (reconcileNeeded && !spaceSwitchBlocked()) { reconcileNeeded = false; queueMicrotask(reconcileSession); }
            });
            return reconcileTask;
        };
        const setAddingSpace = (value) => {
            try {
                if (value) sessionStorage.setItem(ADD_SPACE_KEY, 'true');
                else sessionStorage.removeItem(ADD_SPACE_KEY);
            } catch { setNotice('syncStorageError', true); return false; }
            addingSpace = value;
            setup.hidden = !!credentials && !value;
            room.hidden = !credentials || value;
            if (value) { pauseVoiceMedia(); attachmentPreview.close(); stickerDialog.close(); }
            updateInlineImages();
            markRead();
            renderSpaces();
            return true;
        };
        const switchSpace = async (roomId) => {
            if (spaceSwitchBlocked()) { setNotice('syncSwitchBusy'); return; }
            if (credentials?.roomId === roomId) { setAddingSpace(false); return; }
            switchingSpace = true;
            busy = true;
            updateControls();
            try {
                await spacesReady;
                if (!savedSpaces.list().some(space => space.roomId === roomId)) { setNotice('syncSpaceMissing', true); return; }
                if (!await saveDraft()) return;
                const descriptor = await savedSpaces.select(roomId);
                const session = await loadLocalSession(descriptor);
                if (!sameSession(descriptor, savedSession())) { reconcileNeeded = true; return; }
                setAddingSpace(false);
                if (!await enter({ ...session, revision: descriptor.revision })) {
                    if (credentials && savedSpaces.find(credentials)) await savedSpaces.select(credentials.roomId);
                    return;
                }
                if (!sameSession(descriptor, savedSession())) reconcileNeeded = true;
                if (app.clientWidth <= 640) app.classList.add('is-spaces-collapsed');
                setNotice(pendingUpload ? 'syncUploadRestored' : 'syncJoined');
            } catch { setNotice('syncStorageError', true); }
            finally { switchingSpace = false; busy = false; updateControls(); }
        };
        find('add-space').addEventListener('click', () => {
            if (spaceSwitchBlocked()) { setNotice('syncSwitchBusy'); return; }
            if (!setAddingSpace(true)) return;
            if (app.clientWidth <= 640) app.classList.add('is-spaces-collapsed');
            renderSpaces();
            find('code').focus({ preventScroll: true });
        });
        find('back-space').addEventListener('click', () => { if (!busy && !switchingSpace) setAddingSpace(false); });
        find('space-rename').addEventListener('click', () => {
            const current = savedSpaces.list().find(space => space.roomId === credentials?.roomId);
            if (!current) return;
            spaceNameDialog.dataset.roomId = current.roomId;
            find('space-name').value = current.name || '';
            find('space-name').placeholder = translate('syncSpaceName', { number: current.number });
            find('space-name-status').textContent = '';
            spaceNameDialog.showModal();
            find('space-name').focus();
        });
        const limitSpaceName = event => {
            if (!event.isComposing) find('space-name').value = Array.from(find('space-name').value).slice(0, 8).join('');
        };
        find('space-name').addEventListener('input', limitSpaceName);
        find('space-name').addEventListener('compositionend', limitSpaceName);
        find('space-name-form').addEventListener('submit', async event => {
            event.preventDefault();
            try {
                await savedSpaces.rename(spaceNameDialog.dataset.roomId, find('space-name').value);
                spaceNameDialog.close();
                renderSpaces();
                setNotice('syncSpaceNamed');
            } catch { find('space-name-status').textContent = translate('syncStorageError'); }
        });
        for (const name of ['space-name-close', 'space-name-cancel']) find(name).addEventListener('click', () => spaceNameDialog.close());
        find('spaces-toggle').addEventListener('click', () => {
            const collapsed = app.classList.toggle('is-spaces-collapsed');
            spacesPreference = String(collapsed);
            try { localStorage.setItem('portfolio-sync-spaces-collapsed', spacesPreference); } catch { /* Keep the current layout. */ }
            renderSpaces();
        });
        new ResizeObserver(() => {
            if (spacesPreference === null) app.classList.toggle('is-spaces-collapsed', app.clientWidth <= 640);
            renderSpaces();
        }).observe(app);
        app.classList.toggle('is-spaces-collapsed', spacesPreference === 'true' || spacesPreference === null && app.clientWidth <= 640);
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
                item.querySelector('strong').textContent = deviceLabel(device.deviceId);
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
                if (gameWindow.currentId) gameWindow.update(games.get(gameWindow.currentId));
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
        gameWindow = createGomokuWindow({
            manager, translate, deviceLabel, getDeviceId: () => deviceId,
            onMove: (row, col) => {
                const game = games.get(gameWindow.currentId);
                return gameAction(game.id, 'move', { revision: game.revision, commandId: crypto.randomUUID(), row, col });
            },
            onLeave: () => gameAction(gameWindow.currentId, 'leave'),
            onClosed: () => { if (!active && !needsGameConnection()) disconnect(); }
        });
        const entry = manager.registerWindow({
            id: 'sync-space', element: app, task: document.querySelector('[data-sync-task]'),
            titlebar: find('titlebar'), resizeHandle: find('resize'),
            actionAttribute: 'data-sync-action', minWidth: 320, minHeight: 350,
            focusTarget: () => credentials ? input : find('code'),
            show: () => {
                manager.showWindow(app, entry.task, { revealTask: true });
                active = true;
                if (credentials) prepareEncryptedFiles().catch(() => {});
                lastInteraction = performance.now();
                interactionRevision++;
                reconcileSession();
                connect();
                if (followOnRestore) { followLatest = true; scrollToLatest(); }
                updateSelectedFile();
                updateInlineImages();
                markRead();
            },
            hide: (state) => {
                cancelRecording();
                pauseVoiceMedia();
                releaseVoicePreview();
                followOnRestore = !find('search').value.trim() && atBottom();
                if (confirmation.open) confirmation.close();
                if (devicesDialog.open) devicesDialog.close();
                if (stickerDialog.open) stickerDialog.close();
                manager.hideWindow(app, entry.task, state, { hideTask: state === 'is-closed' });
                if (state === 'is-closed') {
                    clearTimeout(searchTimer);
                    voicePlayers.forEach(player => player.release());
                    active = false;
                    fileDragDepth = 0;
                    app.classList.remove('is-dragging-files');
                    if (!needsGameConnection()) disconnect();
                    attachmentPreview.close();
                }
                updateInlineImages();
            }
        });
        document.querySelectorAll('[data-open-sync-space]').forEach((button) => button.addEventListener('click', entry.show));
        const storeJoinedSpace = async (session) => {
            await spacesReady;
            const descriptor = savedSpaces.list().find(space => space.roomId === session.roomId);
            if (descriptor && descriptor.deviceId !== session.deviceId) {
                const existing = await loadLocalSession(descriptor);
                try {
                    await api(`/v1/spaces/${existing.roomId}/pair-code`, {}, existing);
                } catch (error) {
                    if (error.status !== 401 && error.status !== 404) throw error;
                    await persistSession(session, true);
                    pairing.acknowledgeJoin(session);
                    return session;
                }
                await pairing.abandonJoin(session);
                const selected = await savedSpaces.select(existing.roomId);
                return { ...await loadLocalSession(selected), revision: selected.revision };
            }
            await persistSession(session, true);
            pairing.acknowledgeJoin(session);
            return session;
        };
        const pair = async (path, body, action) => {
            if (busy || sending || secondsLeft(cooldowns[action])) return;
            await reconcileSession();
            if (busy || sending || setup.hidden) return;
            let version = sessionVersion;
            busy = true;
            updateControls();
            setNotice(action === 'create' ? 'syncCreating' : 'syncJoining');
            try {
                if (!await saveDraft()) return;
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
                if (version !== sessionVersion) {
                    if (action === 'join') await pairing.abandonJoin(session);
                    return;
                }
                let alreadyJoined = false;
                try {
                    if (action === 'join') {
                        const joined = await storeJoinedSpace(session);
                        alreadyJoined = joined.deviceId !== session.deviceId;
                        session = joined;
                    } else await persistSession(session, true);
                }
                catch (error) {
                    if (action === 'join') await pairing.abandonJoin(session);
                    throw error;
                }
                setAddingSpace(false);
                if (!await enter(session)) {
                    if (credentials && savedSpaces.find(credentials)) await savedSpaces.select(credentials.roomId);
                    return;
                }
                version = sessionVersion;
                busy = true;
                updateControls();
                if (action === 'create') await showPairing(await pairing.createOffer());
                setNotice(alreadyJoined ? 'syncSpaceAlreadyJoined' : action === 'create' ? 'syncPaired' : 'syncJoined');
                input.focus({ preventScroll: true });
            } catch (error) {
                if (version !== sessionVersion) return;
                if (error.name === 'QuotaExceededError' || error.name === 'SecurityError') error.code = 'storage';
                showError(error, action);
            } finally {
                if (version === sessionVersion) { busy = false; updateControls(); }
            }
        };
        let recoveringPairing = false;
        const recoverPendingPairing = async () => {
            if (recoveringPairing || busy || sending || !pairing.hasPendingJoin()) return;
            recoveringPairing = true;
            let version = sessionVersion;
            busy = true;
            updateControls();
            try {
                if (!await saveDraft()) return;
                let session = await pairing.recoverJoin();
                if (!session) return;
                if (version !== sessionVersion || (!addingSpace && savedSession())) {
                    await pairing.abandonJoin(session);
                    return;
                }
                try { session = await storeJoinedSpace(session); }
                catch (error) { await pairing.abandonJoin(session); throw error; }
                setAddingSpace(false);
                if (!await enter(session)) {
                    if (credentials && savedSpaces.find(credentials)) await savedSpaces.select(credentials.roomId);
                    return;
                }
                version = sessionVersion;
                setNotice('syncJoined');
            } catch (error) {
                if (version === sessionVersion) showError(error, 'join');
            } finally {
                recoveringPairing = false;
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
            pairingRevision++;
            busy = true;
            updateControls();
            try {
                const offer = await pairing.createOffer();
                if (credentials !== session) return;
                await showPairing(offer);
                if (pairLocked || secondsLeft(pairExpiresAt)) {
                    find('pairing').open = true;
                    setNotice(pairLocked ? 'syncPairLocked' : 'syncPaired');
                }
            } catch (error) { if (credentials === session) { await refreshPairing(session).catch(() => {}); showError(error, 'pair'); } }
            finally { if (credentials === session) { busy = false; updateControls(); } }
        });
        find('pair-lock').addEventListener('click', async () => {
            if (busy || !online || !pairing.offer || !pairEnabled) return;
            const session = credentials;
            const locked = !pairLocked;
            busy = true;
            updateControls();
            try {
                const result = await pairing.setLocked(locked);
                if (credentials === session) { await showPairing(result); setNotice(locked ? 'syncPairLocked' : 'syncPairUnlocked'); }
            } catch (error) { if (credentials === session) { await refreshPairing(session).catch(() => {}); showError(error); } }
            finally { if (credentials === session) { busy = false; updateControls(); } }
        });
        find('pair-close').addEventListener('click', async () => {
            if (busy || !online || !pairEnabled) return;
            const session = credentials;
            busy = true;
            updateControls();
            try {
                const result = await api(roomPath('/pair-code'), { method: 'DELETE' }, session);
                if (credentials === session) { await showPairing(result); setNotice('syncPairClosed'); }
            } catch (error) { if (credentials === session) showError(error); }
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
                    pendingUpload = { clientId, file: upload.file, text: upload.text, reply: upload.reply, voice: upload.voice, receivedBytes: 0 };
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
                        if (controller.signal.aborted || credentials !== session || attempt === 2 || (error.code && !['storage_cleaning', 'rate_limited', 'network_error'].includes(error.code))) throw error;
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
                upload.encryption = { ...createFileMetadata(upload.file), ...upload.voice };
                upload.revokedDevices = [...session.revokedDevices];
            }
            const wireSize = upload.file.size + Math.ceil(upload.file.size / FILE_PLAIN_CHUNK_SIZE) * 16;
            const wireFingerprint = await keyedFingerprint(upload.encryption, fingerprint);
            for (;;) {
                upload.completing = false;
                try {
                    if (!upload.encryptedText || upload.keyId !== session.keyring.currentKeyId) {
                        const keyring = session.keyring;
                        upload.encryptedText = await encryptPayload(keyring, session.roomId, `message:${session.deviceId}:${upload.clientId}`, { text: upload.text, attachment: upload.encryption, reply: upload.reply });
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
        find('voice-record').addEventListener('click', async () => {
            if (busy || sending || !online || selectedFile || pendingUpload || recording() || !voiceVisible()) return;
            pauseVoiceMedia();
            recordingSession = credentials;
            find('voice-time').textContent = '00:00 / 01:00';
            const started = recorder.start();
            updateControls();
            await started;
            updateControls();
        });
        find('voice-stop').addEventListener('click', async () => {
            const stopped = recorder.stop();
            updateControls();
            await stopped;
            updateControls();
        });
        find('voice-cancel').addEventListener('click', cancelRecording);
        find('voice-preview').addEventListener('play', () => {
            if (!voiceVisible()) { find('voice-preview').pause(); return; }
            voicePlayers.forEach(player => player.pause());
        });
        const selectFile = (file) => {
            if (busy || sending || recording() || !online) { setNotice('syncAttachUnavailable', true); return; }
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
            selectedVoice = pendingUpload?.voice || null;
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
            selectedVoice = null;
            find('file-input').value = '';
            updateSelectedFile();
        });
        find('cancel-upload').addEventListener('click', async () => {
            if (busy || !pendingUpload || !uploadController) return;
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
                    selectedVoice = null;
                    find('file-input').value = '';
                    saveDraft();
                    render();
                    setNotice('syncUploadCancelled');
                }
            } catch (error) { if (credentials === session) showError(error); }
            finally { if (credentials === session) { busy = false; updateSelectedFile(); } }
        });
        const sendOutgoing = async (outgoing) => {
            if (busy || !online || !outbox.has(outgoing.clientId) || (outgoing.attachment ? !!uploadController : sendingText)) return;
            const session = credentials;
            const upload = outgoing.attachment ? pendingUpload : null;
            if (outgoing.attachment && (upload?.clientId !== outgoing.clientId || !(upload.file instanceof File))) return;
            const text = outgoing.text;
            outgoing.sendState = 'sending';
            sending = true;
            const controller = upload ? new AbortController() : null;
            if (upload) uploadController = controller;
            else sendingText = true;
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
                        outgoing.encrypted = await encryptPayload(keyring, session.roomId, `message:${session.deviceId}:${outgoing.clientId}`, { text, reply: outgoing.reply,
                            ...(outgoing.sticker ? { sticker: outgoing.sticker } : {}), ...(outgoing.gomoku ? { gomoku: outgoing.gomoku } : {}) });
                        outgoing.keyId = keyring.currentKeyId;
                        saveDraft();
                    }
                    if (credentials !== session || outgoing.confirmed || !outbox.has(outgoing.clientId)) return;
                    const message = await api(roomPath('/messages'), { method: 'POST', headers: { 'X-Sync-Key-Id': outgoing.keyId }, body: JSON.stringify({ clientId: outgoing.clientId, text: outgoing.encrypted,
                        ...(outgoing.gomoku ? { game: 'gomoku' } : {}) }) });
                    if (credentials !== session || outbox.get(outgoing.clientId) !== outgoing) return;
                    addMessage(message, null, false);
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
                if (credentials === session && (!upload || uploadController === controller)) {
                    if (upload) uploadController = null;
                    else sendingText = false;
                    sending = sendingText || !!uploadController;
                    render();
                    updateSelectedFile();
                }
            }
        };
        find('send-form').addEventListener('submit', (event) => {
            event.preventDefault();
            const file = uploadController ? null : selectedFile;
            if (busy || sendingText || recording() || !online || (!file && !input.value.trim()) || !find('send-form').reportValidity()) return;
            const resuming = file && pendingUpload?.file === file;
            const text = resuming ? pendingUpload.text : input.value;
            const reply = resuming ? pendingUpload.reply : selectedReply;
            if (file && !resuming) {
                discardUpload();
                pendingUpload = { clientId: crypto.randomUUID(), file, text, reply, voice: selectedVoice, receivedBytes: 0 };
            }
            const clientId = file ? pendingUpload.clientId : crypto.randomUUID();
            const outgoing = outbox.get(clientId) || {
                id: `pending:${clientId}`, clientId, deviceId, text, reply, createdAt: Date.now(),
                attachment: file ? { name: file.name, type: file.type, size: file.size, ...pendingUpload.voice } : null,
                sendState: 'sending'
            };
            outbox.set(clientId, outgoing);
            if (!resuming) { input.value = ''; selectedReply = null; }
            sendOutgoing(outgoing);
        });
        const updateStickerLabels = () => {
            find('sticker-close').setAttribute('aria-label', translate('syncStickerClose'));
            for (const button of find('sticker-grid').querySelectorAll('[data-sync-sticker-choice]')) {
                const name = stickerName(button.dataset.syncStickerChoice);
                button.querySelector('span').textContent = name;
                button.setAttribute('aria-label', name);
            }
        };
        find('game-share').addEventListener('click', () => {
            if (find('game-share').disabled) return;
            const clientId = crypto.randomUUID();
            const outgoing = { id: `pending:${clientId}`, clientId, deviceId, text: '', gomoku: clientId,
                createdAt: Date.now(), attachment: null, sendState: 'sending' };
            outbox.set(clientId, outgoing);
            sendOutgoing(outgoing);
        });
        for (const sticker of STICKERS) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'sync-sticker-choice';
            button.dataset.syncStickerChoice = sticker.id;
            const image = document.createElement('img');
            image.src = sticker.url;
            image.alt = '';
            image.width = 64;
            image.height = 64;
            image.loading = 'lazy';
            button.append(image, document.createElement('span'));
            button.addEventListener('click', () => {
                if (busy || sendingText || recording() || !online) return;
                const clientId = crypto.randomUUID();
                const outgoing = { id: `pending:${clientId}`, clientId, deviceId, text: '', sticker: sticker.id,
                    reply: selectedReply, createdAt: Date.now(), attachment: null, sendState: 'sending' };
                outbox.set(clientId, outgoing);
                selectedReply = null;
                stickerDialog.close();
                sendOutgoing(outgoing);
            });
            find('sticker-grid').append(button);
        }
        updateStickerLabels();
        find('stickers').addEventListener('click', () => {
            if (find('stickers').disabled) return;
            pauseVoiceMedia();
            stickerDialog.showModal();
            markRead();
        });
        find('sticker-close').addEventListener('click', () => stickerDialog.close());
        stickerDialog.addEventListener('close', () => {
            if (active && !find('stickers').disabled) find('stickers').focus({ preventScroll: true });
            markRead();
        });
        find('reply-cancel').addEventListener('click', () => {
            selectedReply = null;
            renderReply();
            saveDraft();
            input.focus();
        });
        input.maxLength = 10000;
        input.addEventListener('input', () => { saveDraft(); updateControls(); });
        input.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
            event.preventDefault();
            if (!event.repeat) find('send-form').requestSubmit();
        });
        find('copy-code').addEventListener('click', () => {
            if (pairEnabled && (pairLocked || secondsLeft(pairExpiresAt))) copyText(find('pair-code').textContent);
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
            if (!event.isTrusted || !browserFocused || !document.hasFocus() || document.hidden || !app.classList.contains('is-active') || app.closest('[inert]')) return;
            lastInteraction = performance.now();
            interactionRevision++;
            markRead();
        };
        for (const type of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'touchmove']) {
            document.addEventListener(type, recordInteraction, { passive: true });
        }
        const readingObserver = new MutationObserver(() => { markRead(); updateInlineImages(); updateVoiceVisibility(); });
        readingObserver.observe(app, { attributes: true, attributeFilter: ['class', 'inert'] });
        for (let ancestor = app.parentElement; ancestor; ancestor = ancestor.parentElement) {
            readingObserver.observe(ancestor, { attributes: true, attributeFilter: ['inert'] });
        }
        find('devices').addEventListener('click', () => {
            if (busy || sending || !online) return;
            cancelRecording();
            pauseVoiceMedia();
            find('devices').focus({ preventScroll: true });
            devicesDialog.showModal();
            loadDevices();
        });
        const showConfirmation = (action, target) => {
            if (busy || sending || !credentials) return;
            cancelRecording();
            pauseVoiceMedia();
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
        window.addEventListener('online', () => { clearTimeout(retryTimer); connect(); recoverPendingPairing(); });
        window.addEventListener('storage', (event) => {
            if (event.key === 'portfolio-sync-notification-sound' || event.key === null) setSoundEnabled(event.newValue !== 'off');
            if (event.key === CREDENTIAL_KEY || event.key === CATALOG_KEY || event.key === null) reconcileSession();
        });
        window.addEventListener('pagehide', () => {
            cancelRecording();
            voicePlayers.forEach(player => player.release());
            releaseVoicePreview();
            saveDraft(); disconnect(); soundVersion++; soundUnlocking = false;
            messageSound.pause(); inlineImages.forEach(image => image.pause());
            imageResources.forEach(resource => resource.clear());
        });
        window.addEventListener('pageshow', () => {
            try { setSoundEnabled(localStorage.getItem('portfolio-sync-notification-sound') !== 'off'); } catch { /* Keep the current session preference. */ }
            reconcileSession().then(recoverPendingPairing); updateInlineImages(); updateSelectedFile(); if (active) connect();
        });
        window.addEventListener('blur', () => {
            browserFocused = false;
            if (recording()) cancelRecording();
            pauseVoiceMedia();
            markRead();
        });
        window.addEventListener('focus', () => { browserFocused = true; markRead(); });
        document.addEventListener('visibilitychange', () => {
            updateVoiceVisibility();
            markRead();
            updateInlineImages();
            if (!document.hidden) { updateCountdowns(); connect(); }
        });
        window.addEventListener('portfolio-language-change', () => {
            renderSpaces();
            updateStickerLabels();
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
            find('voice-preview').setAttribute('aria-label', translate('syncVoiceListen'));
        });
        window.addEventListener('message', (event) => {
            if (event.origin !== window.location.origin || event.source !== window.parent
                || event.data?.source !== 'gavin-shell' || event.data?.type !== 'portfolio-view-state') return;
            viewingDesktop = event.data.active === true;
            updateVoiceVisibility();
            updateInlineImages();
        });
        manager.onSession({ restore: (savedState) => {
            restoringGame = !!savedState.windows?.['sync-gomoku'] && !savedState.windows['sync-gomoku'].closed;
            active = !app.classList.contains('is-closed');
            reconcileSession();
            if (active || needsGameConnection()) connect();
        } });
        reconcileSession().then(recoverPendingPairing);
        updateSoundToggle();
        updateControls();
        return entry;
    };
})();
