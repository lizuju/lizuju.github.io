import '../../css/apps/sync-gomoku.css';

export function createGomokuWindow({ manager, translate, deviceLabel, getDeviceId, onMove, onLeave, onClosed }) {
    const app = document.querySelector('[data-sync-gomoku-window]');
    const find = name => app.querySelector(`[data-sync-gomoku-${name}]`);
    const canvas = find('board');
    const frame = find('frame');
    const context = canvas.getContext('2d');
    const confirmation = find('confirm');
    const task = document.createElement('button');
    task.type = 'button';
    task.className = 'task-window-button';
    task.hidden = true;
    task.dataset.syncGomokuTask = '';
    const icon = document.createElement('span');
    icon.className = 'window-app-icon sync-gomoku-icon';
    icon.textContent = '五';
    icon.setAttribute('aria-hidden', 'true');
    const taskTitle = document.createElement('span');
    taskTitle.dataset.i18n = 'syncGameTask';
    task.append(icon, taskTitle);
    manager.desktop.querySelector('.taskbar-spacer').before(task);

    let current = null;
    let online = false;
    let pending = null;
    let leaving = false;
    let errorKey = '';
    let hover = null;
    let cursor = { row: 7, col: 7 };
    let keyboard = false;
    let size = 480;
    let ratio = 1;
    let margin = 30;
    let step = 30;
    let priorRenderGame;

    const player = () => current && (current.hostDeviceId === getDeviceId() ? 1
        : current.guestDeviceId === getDeviceId() ? 2 : 0);
    const canMove = () => current?.status === 'playing' && online && !pending && !leaving
        && player() > 0 && current.turnDeviceId === getDeviceId();
    const isOpen = () => manager.isWindowVisible(app);
    const text = key => translate(key);
    const setError = key => { errorKey = key; render(); };

    const drawStone = (row, col, color, opacity = 1) => {
        const x = margin + col * step;
        const y = margin + row * step;
        const radius = step * 0.43;
        const gradient = context.createRadialGradient(x - radius * 0.38, y - radius * 0.46, radius * 0.15, x, y, radius);
        gradient.addColorStop(0, color === 1 ? '#777' : '#fff');
        gradient.addColorStop(0.4, color === 1 ? '#222' : '#e7e7e7');
        gradient.addColorStop(1, color === 1 ? '#000' : '#888');
        context.save();
        context.globalAlpha = opacity;
        context.fillStyle = gradient;
        context.beginPath();
        context.arc(x, y, radius, 0, Math.PI * 2);
        context.fill();
        context.strokeStyle = color === 1 ? '#000' : '#666';
        context.stroke();
        context.restore();
    };

    const draw = () => {
        if (!current || !isOpen()) return;
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        context.clearRect(0, 0, size, size);
        context.fillStyle = '#bdbdbd';
        context.fillRect(0, 0, size, size);
        context.strokeStyle = '#666';
        context.lineWidth = 1;
        for (let index = 0; index < 15; index++) {
            const point = margin + index * step + 0.5 / ratio;
            context.beginPath();
            context.moveTo(margin, point);
            context.lineTo(size - margin, point);
            context.moveTo(point, margin);
            context.lineTo(point, size - margin);
            context.stroke();
        }
        context.fillStyle = '#555';
        for (const [row, col] of [[3, 3], [3, 11], [7, 7], [11, 3], [11, 11]]) {
            context.beginPath();
            context.arc(margin + col * step, margin + row * step, Math.max(1.5, step * 0.1), 0, Math.PI * 2);
            context.fill();
        }
        const board = current.board || [];
        const target = keyboard ? cursor : hover;
        if (canMove() && target && board[target.row * 15 + target.col] === 0) {
            drawStone(target.row, target.col, player(), 0.35);
        }
        board.forEach((stone, index) => {
            if (stone) drawStone(Math.floor(index / 15), index % 15, stone);
        });
        if (current.lastMove) {
            const marker = Math.max(3, step * 0.17);
            context.fillStyle = '#d41414';
            context.fillRect(margin + current.lastMove.col * step - marker / 2,
                margin + current.lastMove.row * step - marker / 2, marker, marker);
        }
        if (keyboard && canMove()) {
            const edge = step * 0.8;
            context.save();
            context.strokeStyle = '#000080';
            context.lineWidth = 2;
            context.setLineDash([3, 2]);
            context.strokeRect(margin + cursor.col * step - edge / 2, margin + cursor.row * step - edge / 2, edge, edge);
            context.restore();
        }
    };

    const resize = () => {
        if (!current || !isOpen()) return;
        const nextSize = Math.floor(Math.min(frame.clientWidth - 12, frame.clientHeight - 12));
        if (nextSize < 1) return;
        const nextRatio = Math.min(window.devicePixelRatio || 1, 2);
        if (nextSize !== size || nextRatio !== ratio) {
            size = nextSize;
            ratio = nextRatio;
            margin = Math.max(12, size / 16);
            step = (size - margin * 2) / 14;
            canvas.style.width = `${size}px`;
            canvas.style.height = `${size}px`;
            canvas.width = Math.round(size * ratio);
            canvas.height = Math.round(size * ratio);
        }
        draw();
    };

    const statusText = () => {
        if (current.status === 'finished') return text('syncGameFinished');
        if (current.status === 'cancelled') return text('syncGameCancelled');
        if (!online) return text('syncGameOffline');
        if (current.status === 'waiting') return text('syncGameWaiting');
        if (pending) return text('syncGameSendingMove');
        if (current.turnDeviceId === getDeviceId()) return text('syncGameYourTurn');
        return translate('syncGamePlayerTurn', { name: deviceLabel(current.turnDeviceId) });
    };

    function render() {
        if (!current) return;
        find('host').textContent = deviceLabel(current.hostDeviceId);
        find('guest').textContent = current.guestDeviceId ? deviceLabel(current.guestDeviceId) : text('syncGameWaitingPlayer');
        find('move-count').textContent = current.board.filter(Boolean).length;
        for (const seat of ['host', 'guest']) {
            app.querySelector(`[data-sync-gomoku-player="${seat}"]`).classList.toggle('is-turn',
                current.status === 'playing' && current.turnDeviceId === current[`${seat}DeviceId`]);
        }
        const status = statusText();
        const review = ['finished', 'cancelled'].includes(current.status);
        find('status').textContent = status;
        find('role').textContent = text(review ? 'syncGameReviewRole' : player() === 1 ? 'syncGamePlayingBlack' : player() === 2 ? 'syncGamePlayingWhite' : 'syncGameSpectating');
        app.querySelector('#sync-gomoku-keyboard-help').textContent = text(review ? 'syncGameReviewRole' : 'syncGameKeyboardHelp');
        find('error').hidden = !errorKey;
        find('error').textContent = errorKey ? text(errorKey) : '';
        canvas.classList.toggle('is-playable', canMove());
        canvas.setAttribute('aria-disabled', String(!canMove()));
        canvas.setAttribute('aria-label', `${text('syncGameTitle')} · ${status} · ${translate('syncGameBoardPoint', { row: cursor.row + 1, col: cursor.col + 1 })}`);
        const waiting = current.status === 'waiting';
        find('confirm-copy').textContent = text(waiting ? 'syncGameCancelWaitingConfirm' : 'syncGameResignConfirm');
        find('leave').textContent = text(waiting ? 'syncGameCancelWaiting' : 'syncGameResign');
        confirmation.querySelectorAll('button').forEach(button => { button.disabled = leaving; });
        draw();
    }

    const close = () => {
        const hadGame = Boolean(current);
        current = null;
        pending = null;
        leaving = false;
        hover = null;
        errorKey = '';
        if (confirmation.open) confirmation.close();
        manager.hideWindow(app, task, 'is-closed', { hideTask: true });
        if (hadGame) onClosed();
    };

    const requestClose = () => {
        if (current && player() && ['waiting', 'playing'].includes(current.status)) {
            render();
            if (!confirmation.open) confirmation.showModal();
        } else close();
    };

    const entry = manager.registerWindow({
        id: 'sync-gomoku', element: app, task, titlebar: find('drag'), resizeHandle: find('resize'),
        actionAttribute: 'data-sync-gomoku-action', minWidth: 280, minHeight: 260,
        focusTarget: () => canvas,
        show: () => {
            if (!current) return;
            manager.showWindow(app, task, { revealTask: true });
            requestAnimationFrame(resize);
        },
        hide: state => {
            if (state === 'is-closed') requestClose();
            else manager.hideWindow(app, task, state);
        }
    });

    const play = async (row, col) => {
        if (!canMove() || current.board[row * 15 + col] !== 0) return;
        const request = { id: current.id, revision: current.revision };
        pending = request;
        errorKey = '';
        render();
        try { await onMove(row, col); }
        catch {
            if (pending !== request || current?.id !== request.id) return;
            pending = null;
            setError('syncGameMoveFailed');
        }
    };

    const point = event => {
        const rect = canvas.getBoundingClientRect();
        const x = (event.clientX - rect.left) * size / rect.width;
        const y = (event.clientY - rect.top) * size / rect.height;
        const row = Math.round((y - margin) / step);
        const col = Math.round((x - margin) / step);
        if (row < 0 || row > 14 || col < 0 || col > 14
            || Math.hypot(x - margin - col * step, y - margin - row * step) > step * 0.48) return null;
        return { row, col };
    };
    canvas.addEventListener('pointermove', event => {
        keyboard = false;
        hover = point(event);
        draw();
    });
    canvas.addEventListener('pointerleave', () => { hover = null; draw(); });
    canvas.addEventListener('click', event => {
        keyboard = false;
        const target = point(event);
        if (target) { cursor = target; play(target.row, target.col); }
    });
    canvas.addEventListener('blur', () => { keyboard = false; draw(); });
    canvas.addEventListener('keydown', event => {
        const movement = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[event.key];
        if (movement) {
            event.preventDefault();
            keyboard = true;
            cursor = { row: Math.max(0, Math.min(14, cursor.row + movement[0])), col: Math.max(0, Math.min(14, cursor.col + movement[1])) };
            render();
        } else if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            keyboard = true;
            play(cursor.row, cursor.col);
        }
    });
    confirmation.addEventListener('cancel', event => { if (leaving) event.preventDefault(); });
    find('leave').addEventListener('click', async () => {
        if (leaving || !current) return;
        const gameId = current.id;
        leaving = true;
        errorKey = '';
        render();
        try {
            await onLeave();
            if (current?.id === gameId) close();
        } catch {
            if (current?.id !== gameId) return;
            leaving = false;
            confirmation.close();
            setError('syncGameLeaveFailed');
        }
    });

    const applyLanguage = () => {
        app.querySelectorAll('[data-i18n]').forEach(element => { element.textContent = text(element.dataset.i18n); });
        app.querySelectorAll('[data-i18n-aria]').forEach(element => { element.setAttribute('aria-label', text(element.dataset.i18nAria)); });
        taskTitle.textContent = text('syncGameTask');
        render();
    };
    window.addEventListener('portfolio-language-change', applyLanguage);
    window.addEventListener('resize', resize);
    new ResizeObserver(resize).observe(frame);
    manager.onSession({ restore: () => { if (!current) close(); } });

    const renderGame = () => {
        if (!current || !isOpen() || !app.classList.contains('is-active')) return priorRenderGame?.() || JSON.stringify({ game: null });
        return JSON.stringify({
            game: 'gomoku-online', id: current.id, status: current.status, revision: current.revision,
            role: player() === 1 ? 'black' : player() === 2 ? 'white' : 'spectator',
            currentPlayer: current.turnDeviceId, boardSize: 15, board: current.board || [],
            lastMove: current.lastMove, online, pending: Boolean(pending),
            coordinateSystem: 'row 0 is top, column 0 is left; both increase toward bottom-right'
        });
    };
    applyLanguage();
    return {
        show(game) {
            if (window.render_game_to_text !== renderGame) {
                priorRenderGame = window.render_game_to_text;
                window.render_game_to_text = renderGame;
            }
            if (current?.id !== game.id) {
                pending = null;
                leaving = false;
                errorKey = '';
                hover = null;
                cursor = { row: 7, col: 7 };
                keyboard = false;
            }
            current = game;
            if (pending && game.revision > pending.revision) pending = null;
            render();
            entry.show();
        },
        update(game) {
            if (!current || game.id !== current.id || game.revision < current.revision) return;
            current = game;
            if (pending && game.revision > pending.revision) pending = null;
            render();
        },
        setOnline(value) {
            online = value;
            if (!online) { pending = null; hover = null; }
            render();
        },
        close,
        get currentId() { return current?.id || null; }
    };
}
