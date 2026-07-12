(() => {
    const BOARD_SIZE = 15;
    const HUMAN = 0;
    const COMPUTER = 1;
    const EMPTY = -1;
    const AI_DELAY = 260;

    const TEXT = {
        'zh-CN': {
            appName: '五子棋',
            windowTitle: '五子棋 - GavinOS 游戏',
            taskTitle: '五子棋',
            gameMenu: '游戏(G)',
            helpMenu: '帮助(H)',
            newGame: '新游戏',
            undo: '悔棋',
            exit: '退出',
            howToPlay: '玩法说明',
            about: '关于五子棋',
            moves: '步数',
            score: '比分',
            you: '你',
            computer: '电脑',
            ok: '确定',
            yourTurn: '轮到你落子（黑棋）',
            thinking: '电脑正在思考...',
            playerWins: '你赢了！五子连珠。',
            computerWins: '电脑获胜，再来一局吧。',
            draw: '棋盘已满，本局平局。',
            helpTitle: '玩法说明',
            helpCopy: '你执黑棋先手，电脑执白棋。\n在棋盘交叉点落子，横、竖或斜线率先连成五子即可获胜。\nF2：新游戏　Ctrl+Z：悔棋　F：最大化',
            aboutTitle: '关于五子棋',
            aboutCopy: 'GavinOS 五子棋 1.0\n采用经典 Windows 扫雷式界面。\n电脑棋力由 Gomoku minimax 引擎提供。',
            launchLines: [
                'GavinOS 命令处理器 [版本 1.0.2026]',
                '(C) 2026 Gavin. All rights reserved.',
                '',
                'C:\\GAVIN\\GAMES> gomoku.exe',
                '[  OK  ] 正在挂载 15 x 15 棋盘',
                '[  OK  ] 正在加载 Minimax 对弈引擎',
                '[  OK  ] 正在初始化人机对局',
                '',
                'GOMOKU.EXE READY'
            ]
        },
        en: {
            appName: 'Gomoku',
            windowTitle: 'Gomoku - GavinOS Games',
            taskTitle: 'Gomoku',
            gameMenu: 'Game(G)',
            helpMenu: 'Help(H)',
            newGame: 'New Game',
            undo: 'Undo',
            exit: 'Exit',
            howToPlay: 'How to Play',
            about: 'About Gomoku',
            moves: 'Moves',
            score: 'Score',
            you: 'You',
            computer: 'PC',
            ok: 'OK',
            yourTurn: 'Your turn (black)',
            thinking: 'Computer is thinking...',
            playerWins: 'You win! Five in a row.',
            computerWins: 'Computer wins. Try another round.',
            draw: 'The board is full. Draw game.',
            helpTitle: 'How to Play',
            helpCopy: 'You play black and move first. The computer plays white.\nPlace stones on intersections. The first to connect five horizontally, vertically, or diagonally wins.\nF2: New game　Ctrl+Z: Undo　F: Maximize',
            aboutTitle: 'About Gomoku',
            aboutCopy: 'GavinOS Gomoku 1.0\nA classic Windows Minesweeper-inspired interface.\nComputer moves use a Gomoku minimax engine.',
            launchLines: [
                'GavinOS Command Processor [Version 1.0.2026]',
                '(C) 2026 Gavin. All rights reserved.',
                '',
                'C:\\GAVIN\\GAMES> gomoku.exe',
                '[  OK  ] Mounting 15 x 15 board',
                '[  OK  ] Loading Minimax game engine',
                '[  OK  ] Initializing player session',
                '',
                'GOMOKU.EXE READY'
            ]
        }
    };

    const normalizeLanguage = (language) => language?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';

    function setupGomokuGame() {
        const desktop = document.querySelector('[data-retro-desktop]');
        const gameWindow = document.querySelector('[data-gomoku-window]');
        const gameTask = document.querySelector('[data-gomoku-task]');
        const titlebar = document.querySelector('[data-gomoku-drag]');
        const resizeHandle = document.querySelector('[data-gomoku-resize]');
        const canvas = document.querySelector('[data-gomoku-board]');
        const boardFrame = document.querySelector('[data-gomoku-board-frame]');
        const status = document.querySelector('[data-gomoku-status]');
        const movesOutput = document.querySelector('[data-gomoku-moves]');
        const scoreOutput = document.querySelector('[data-gomoku-score]');
        const faceButton = document.querySelector('.gomoku-face');
        const dialog = document.querySelector('[data-gomoku-dialog]');
        const dialogTitle = document.querySelector('[data-gomoku-dialog-title]');
        const dialogCopy = document.querySelector('[data-gomoku-dialog-copy]');
        const launcher = document.querySelector('[data-gomoku-launcher]');
        const launchLog = document.querySelector('[data-gomoku-launch-log]');
        const Engine = window.GomokuEngine?.GomokuSolution;

        if (!desktop || !gameWindow || !gameTask || !titlebar
            || !resizeHandle || !canvas || !boardFrame || !status || !movesOutput || !scoreOutput
            || !faceButton || !dialog || !dialogTitle || !dialogCopy || !launcher || !launchLog || !Engine) return;

        const context = canvas.getContext('2d');
        let canvasSize = 480;
        let boardMargin = 30;
        let gridSize = 30;
        let stoneRadius = 13;
        let pixelRatio = 1;
        let language = normalizeLanguage(document.documentElement.lang);
        let board = createBoard();
        let history = [];
        let phase = 'playing';
        let currentPlayer = HUMAN;
        let winner = null;
        let winningLine = [];
        let humanScore = 0;
        let computerScore = 0;
        let roundScored = false;
        let hoverPosition = null;
        let engine;
        let aiTimer;
        let restoreGeometry;
        let pointerInteraction;
        let launchTimers = [];

        const copy = () => TEXT[language];

        function createBoard() {
            return Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(EMPTY));
        }

        function createEngine() {
            engine = new Engine({
                MAX_ROW: BOARD_SIZE,
                MAX_COL: BOARD_SIZE,
                MAX_ADJACENT: 5,
                MAX_DISTANCE_OF_NEIGHBOR: 2
            });
            engine.init(history.map((move) => ({ r: move.row, c: move.col, p: move.player })));
        }

        function findWinningLine(row, col, player) {
            const directions = [[1, 0], [0, 1], [1, 1], [1, -1]];
            for (const [rowStep, colStep] of directions) {
                const line = [{ row, col }];
                for (const sign of [-1, 1]) {
                    let nextRow = row + rowStep * sign;
                    let nextCol = col + colStep * sign;
                    const side = [];
                    while (board[nextRow]?.[nextCol] === player) {
                        side.push({ row: nextRow, col: nextCol });
                        nextRow += rowStep * sign;
                        nextCol += colStep * sign;
                    }
                    if (sign < 0) line.unshift(...side.reverse());
                    else line.push(...side);
                }
                if (line.length >= 5) return line;
            }
            return [];
        }

        function updateGameResult(row, col, player, countScore = true) {
            winningLine = findWinningLine(row, col, player);
            if (winningLine.length >= 5) {
                winner = player;
                phase = player === HUMAN ? 'player-won' : 'computer-won';
                currentPlayer = null;
                if (countScore && !roundScored) {
                    if (player === HUMAN) humanScore += 1;
                    else computerScore += 1;
                    roundScored = true;
                }
                return true;
            }
            if (history.length === BOARD_SIZE * BOARD_SIZE) {
                phase = 'draw';
                currentPlayer = null;
                return true;
            }
            return false;
        }

        function getStatusText() {
            if (phase === 'player-won') return copy().playerWins;
            if (phase === 'computer-won') return copy().computerWins;
            if (phase === 'draw') return copy().draw;
            if (phase === 'thinking') return copy().thinking;
            return copy().yourTurn;
        }

        function updateInterface() {
            status.textContent = getStatusText();
            movesOutput.textContent = String(history.length).padStart(3, '0');
            scoreOutput.textContent = `${humanScore}:${computerScore}`;
            faceButton.classList.toggle('is-thinking', phase === 'thinking');
            faceButton.querySelector('span').textContent = phase === 'computer-won' ? '☹' : phase === 'thinking' ? '◉' : '☺';
            canvas.classList.toggle('is-locked', phase !== 'playing');
            canvas.classList.toggle('is-thinking', phase === 'thinking');
            document.querySelectorAll('[data-gomoku-undo]').forEach((button) => {
                button.disabled = history.length === 0 || phase === 'thinking';
            });
            canvas.setAttribute('aria-label', `${copy().appName}: ${getStatusText()}`);
        }

        function drawBoard() {
            context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
            context.clearRect(0, 0, canvasSize, canvasSize);
            context.fillStyle = '#bdbdbd';
            context.fillRect(0, 0, canvasSize, canvasSize);

            context.strokeStyle = '#666';
            context.lineWidth = 1;
            for (let index = 0; index < BOARD_SIZE; index += 1) {
                const position = boardMargin + index * gridSize + 0.5 / pixelRatio;
                context.beginPath();
                context.moveTo(boardMargin, position);
                context.lineTo(canvasSize - boardMargin, position);
                context.stroke();
                context.beginPath();
                context.moveTo(position, boardMargin);
                context.lineTo(position, canvasSize - boardMargin);
                context.stroke();
            }

            context.fillStyle = '#555';
            [[3, 3], [3, 11], [7, 7], [11, 3], [11, 11]].forEach(([row, col]) => {
                context.beginPath();
                context.arc(
                    boardMargin + col * gridSize,
                    boardMargin + row * gridSize,
                    Math.max(2, gridSize * 0.1),
                    0,
                    Math.PI * 2
                );
                context.fill();
            });

            if (hoverPosition && phase === 'playing' && board[hoverPosition.row][hoverPosition.col] === EMPTY) {
                drawStone(hoverPosition.row, hoverPosition.col, HUMAN, 0.35);
            }

            history.forEach((move) => drawStone(move.row, move.col, move.player, 1));

            const lastMove = history.at(-1);
            if (lastMove) {
                const markerSize = Math.max(4, gridSize * 0.17);
                context.fillStyle = '#d41414';
                context.fillRect(
                    boardMargin + lastMove.col * gridSize - markerSize / 2,
                    boardMargin + lastMove.row * gridSize - markerSize / 2,
                    markerSize,
                    markerSize
                );
            }

            if (winningLine.length) {
                const first = winningLine[0];
                const last = winningLine.at(-1);
                context.strokeStyle = '#d41414';
                context.lineWidth = Math.max(2, gridSize * 0.1);
                context.beginPath();
                context.moveTo(boardMargin + first.col * gridSize, boardMargin + first.row * gridSize);
                context.lineTo(boardMargin + last.col * gridSize, boardMargin + last.row * gridSize);
                context.stroke();
            }
        }

        function drawStone(row, col, player, opacity) {
            const x = boardMargin + col * gridSize;
            const y = boardMargin + row * gridSize;
            const gradient = context.createRadialGradient(
                x - stoneRadius * 0.38,
                y - stoneRadius * 0.46,
                stoneRadius * 0.15,
                x,
                y,
                stoneRadius
            );
            if (player === HUMAN) {
                gradient.addColorStop(0, '#777');
                gradient.addColorStop(0.28, '#222');
                gradient.addColorStop(1, '#000');
            } else {
                gradient.addColorStop(0, '#fff');
                gradient.addColorStop(0.7, '#e7e7e7');
                gradient.addColorStop(1, '#888');
            }
            context.save();
            context.globalAlpha = opacity;
            context.fillStyle = gradient;
            context.beginPath();
            context.arc(x, y, stoneRadius, 0, Math.PI * 2);
            context.fill();
            context.strokeStyle = player === HUMAN ? '#000' : '#666';
            context.stroke();
            context.restore();
        }

        function render() {
            drawBoard();
            updateInterface();
        }

        function closeMenus() {
            document.querySelectorAll('[data-gomoku-menu-popup]').forEach((popup) => {
                popup.hidden = true;
            });
            document.querySelectorAll('[data-gomoku-menu]').forEach((button) => {
                button.setAttribute('aria-expanded', 'false');
            });
        }

        function clearAiTimer() {
            window.clearTimeout(aiTimer);
            aiTimer = undefined;
        }

        function placeMove(row, col, player) {
            if (!Number.isInteger(row) || !Number.isInteger(col) || board[row]?.[col] !== EMPTY) return false;
            board[row][col] = player;
            history.push({ row, col, player });
            engine.forward(row, col, player);
            return true;
        }

        function findFallbackMove() {
            const center = Math.floor(BOARD_SIZE / 2);
            for (let radius = 0; radius < BOARD_SIZE; radius += 1) {
                for (let row = Math.max(0, center - radius); row <= Math.min(BOARD_SIZE - 1, center + radius); row += 1) {
                    for (let col = Math.max(0, center - radius); col <= Math.min(BOARD_SIZE - 1, center + radius); col += 1) {
                        if (board[row][col] === EMPTY) return [row, col];
                    }
                }
            }
            return [-1, -1];
        }

        function runComputerMove() {
            if (phase !== 'thinking') return;
            clearAiTimer();

            let move;
            try {
                move = engine.minimaxSearch(COMPUTER);
            } catch (error) {
                console.error('Gomoku engine could not select a move.', error);
                move = findFallbackMove();
            }
            if (board[move[0]]?.[move[1]] !== EMPTY) move = findFallbackMove();
            if (!placeMove(move[0], move[1], COMPUTER)) return;

            if (!updateGameResult(move[0], move[1], COMPUTER)) {
                phase = 'playing';
                currentPlayer = HUMAN;
            }
            render();
        }

        function scheduleComputerMove() {
            phase = 'thinking';
            currentPlayer = COMPUTER;
            render();
            clearAiTimer();
            aiTimer = window.setTimeout(runComputerMove, AI_DELAY);
        }

        function playHumanMove(row, col) {
            if (phase !== 'playing' || currentPlayer !== HUMAN || !placeMove(row, col, HUMAN)) return false;
            hoverPosition = null;
            if (!updateGameResult(row, col, HUMAN)) scheduleComputerMove();
            else render();
            return true;
        }

        function newGame() {
            clearAiTimer();
            board = createBoard();
            history = [];
            phase = 'playing';
            currentPlayer = HUMAN;
            winner = null;
            winningLine = [];
            roundScored = false;
            hoverPosition = null;
            createEngine();
            closeMenus();
            render();
        }

        function undoMove() {
            if (history.length === 0 || phase === 'thinking') return;
            clearAiTimer();
            if (roundScored) {
                if (winner === HUMAN) humanScore -= 1;
                else computerScore -= 1;
                roundScored = false;
            }
            const removeCount = history.at(-1).player === COMPUTER ? Math.min(2, history.length) : 1;
            history.splice(-removeCount, removeCount);
            board = createBoard();
            history.forEach((move) => {
                board[move.row][move.col] = move.player;
            });
            phase = 'playing';
            currentPlayer = HUMAN;
            winner = null;
            winningLine = [];
            createEngine();
            closeMenus();
            render();
        }

        function loadPosition(moves, nextPlayer = HUMAN) {
            clearAiTimer();
            board = createBoard();
            history = [];
            moves.forEach((move) => {
                if (board[move.row]?.[move.col] !== EMPTY || ![HUMAN, COMPUTER].includes(move.player)) return;
                board[move.row][move.col] = move.player;
                history.push({ row: move.row, col: move.col, player: move.player });
            });
            phase = 'playing';
            currentPlayer = nextPlayer;
            winner = null;
            winningLine = [];
            roundScored = false;
            const lastMove = history.at(-1);
            if (lastMove) updateGameResult(lastMove.row, lastMove.col, lastMove.player, false);
            createEngine();
            render();
        }

        function canvasPosition(event) {
            const rect = canvas.getBoundingClientRect();
            const x = (event.clientX - rect.left) * canvasSize / rect.width;
            const y = (event.clientY - rect.top) * canvasSize / rect.height;
            const col = Math.round((x - boardMargin) / gridSize);
            const row = Math.round((y - boardMargin) / gridSize);
            if (row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE) return null;
            const targetX = boardMargin + col * gridSize;
            const targetY = boardMargin + row * gridSize;
            if (Math.hypot(x - targetX, y - targetY) > gridSize * 0.48) return null;
            return { row, col };
        }

        function resizeBoard() {
            if (gameWindow.classList.contains('is-minimized') || gameWindow.classList.contains('is-closed')) return;
            const size = Math.floor(Math.min(boardFrame.clientWidth - 12, boardFrame.clientHeight - 12));
            if (size < 160) return;
            const nextPixelRatio = Math.min(window.devicePixelRatio || 1, 2);
            if (size === canvasSize && nextPixelRatio === pixelRatio) return;
            canvasSize = size;
            boardMargin = Math.max(16, canvasSize / 16);
            gridSize = (canvasSize - boardMargin * 2) / (BOARD_SIZE - 1);
            stoneRadius = Math.max(6, gridSize * 0.43);
            pixelRatio = nextPixelRatio;
            canvas.style.width = `${size}px`;
            canvas.style.height = `${size}px`;
            canvas.width = Math.round(size * pixelRatio);
            canvas.height = Math.round(size * pixelRatio);
            render();
        }

        function clearLaunchSequence() {
            launchTimers.forEach((timer) => window.clearTimeout(timer));
            launchTimers = [];
            launcher.hidden = true;
            launcher.classList.remove('is-complete');
            gameWindow.classList.remove('is-launching');
        }

        function finishLaunchSequence() {
            launcher.classList.add('is-complete');
            launchTimers.push(window.setTimeout(() => {
                launcher.hidden = true;
                launcher.classList.remove('is-complete');
                gameWindow.classList.remove('is-launching');
                window.requestAnimationFrame(resizeBoard);
            }, 180));
        }

        function startLaunchSequence() {
            clearLaunchSequence();
            launchLog.textContent = '';
            launcher.hidden = false;
            gameWindow.classList.add('is-launching');

            const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            const lineDelay = reducedMotion ? 1 : 140;
            const settleDelay = reducedMotion ? 20 : 240;
            copy().launchLines.forEach((line, index) => {
                launchTimers.push(window.setTimeout(() => {
                    launchLog.textContent += `${line}\n`;
                }, lineDelay * (index + 1)));
            });
            launchTimers.push(window.setTimeout(
                finishLaunchSequence,
                lineDelay * (copy().launchLines.length + 1) + settleDelay
            ));
        }

        function focusGame() {
            gameWindow.dispatchEvent(new CustomEvent('gavin:focus-window', { bubbles: true }));
        }

        function notifyWindowHidden() {
            gameWindow.dispatchEvent(new CustomEvent('gavin:window-hidden', { bubbles: true }));
        }

        function parkGame() {
            if (gameWindow.classList.contains('is-closed')) return;
            gameWindow.classList.add('is-minimized');
            gameWindow.classList.remove('is-active');
            gameTask.classList.remove('is-active');
            notifyWindowHidden();
        }

        function openGame() {
            const wasClosed = gameWindow.classList.contains('is-closed');
            gameWindow.classList.remove('is-minimized', 'is-closed');
            gameTask.hidden = false;
            document.querySelector('[data-start-menu]')?.setAttribute('hidden', '');
            document.querySelector('[data-start-toggle]')?.setAttribute('aria-expanded', 'false');
            if (wasClosed) {
                newGame();
                startLaunchSequence();
            } else {
                window.requestAnimationFrame(resizeBoard);
            }
            focusGame();
        }

        function minimizeGame() {
            parkGame();
        }

        function closeGame() {
            clearAiTimer();
            clearLaunchSequence();
            humanScore = 0;
            computerScore = 0;
            roundScored = false;
            updateInterface();
            gameWindow.classList.remove('is-minimized');
            gameWindow.classList.remove('is-active');
            gameWindow.classList.add('is-closed');
            gameTask.hidden = true;
            gameTask.classList.remove('is-active');
            closeMenus();
            dialog.hidden = true;
            notifyWindowHidden();
        }

        function getWorkArea() {
            return {
                width: desktop.clientWidth,
                height: desktop.clientHeight - (document.querySelector('.desktop-taskbar')?.offsetHeight || 36)
            };
        }

        function getWindowGeometry() {
            const desktopRect = desktop.getBoundingClientRect();
            const windowRect = gameWindow.getBoundingClientRect();
            return {
                left: windowRect.left - desktopRect.left,
                top: windowRect.top - desktopRect.top,
                width: windowRect.width,
                height: windowRect.height
            };
        }

        function applyWindowGeometry({ left, top, width, height }) {
            gameWindow.style.left = `${Math.round(left)}px`;
            gameWindow.style.top = `${Math.round(top)}px`;
            gameWindow.style.width = `${Math.round(width)}px`;
            gameWindow.style.height = `${Math.round(height)}px`;
            gameWindow.style.right = 'auto';
            gameWindow.style.bottom = 'auto';
        }

        function clearWindowGeometry() {
            ['left', 'top', 'width', 'height', 'right', 'bottom'].forEach((property) => {
                gameWindow.style.removeProperty(property);
            });
        }

        function toggleMaximize() {
            if (window.innerWidth <= 900) return;
            if (gameWindow.classList.contains('is-maximized')) {
                gameWindow.classList.remove('is-maximized');
                if (restoreGeometry) applyWindowGeometry(restoreGeometry);
            } else {
                restoreGeometry = getWindowGeometry();
                clearWindowGeometry();
                gameWindow.classList.add('is-maximized');
            }
            document.querySelectorAll('[data-gomoku-window-action="maximize"]').forEach((button) => {
                button.setAttribute('aria-pressed', String(gameWindow.classList.contains('is-maximized')));
            });
            window.requestAnimationFrame(resizeBoard);
        }

        function startPointerInteraction(event, type) {
            if (event.button !== 0 || window.innerWidth <= 900 || gameWindow.classList.contains('is-maximized')) return;
            const geometry = getWindowGeometry();
            applyWindowGeometry(geometry);
            pointerInteraction = {
                type,
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                geometry
            };
            gameWindow.classList.add(type === 'drag' ? 'is-dragging' : 'is-resizing');
            event.currentTarget.setPointerCapture?.(event.pointerId);
            event.preventDefault();
        }

        function updatePointerInteraction(event) {
            if (!pointerInteraction || event.pointerId !== pointerInteraction.pointerId) return;
            const { type, startX, startY, geometry } = pointerInteraction;
            const workArea = getWorkArea();
            const deltaX = event.clientX - startX;
            const deltaY = event.clientY - startY;
            if (type === 'drag') {
                applyWindowGeometry({
                    ...geometry,
                    left: Math.min(Math.max(0, geometry.left + deltaX), Math.max(0, workArea.width - geometry.width)),
                    top: Math.min(Math.max(0, geometry.top + deltaY), Math.max(0, workArea.height - geometry.height))
                });
                return;
            }
            const minWidth = Math.min(420, workArea.width - geometry.left);
            const minHeight = Math.min(500, workArea.height - geometry.top);
            applyWindowGeometry({
                ...geometry,
                width: Math.min(Math.max(minWidth, geometry.width + deltaX), workArea.width - geometry.left),
                height: Math.min(Math.max(minHeight, geometry.height + deltaY), workArea.height - geometry.top)
            });
            resizeBoard();
        }

        function finishPointerInteraction(event) {
            if (!pointerInteraction || (event?.pointerId !== undefined && event.pointerId !== pointerInteraction.pointerId)) return;
            pointerInteraction = undefined;
            gameWindow.classList.remove('is-dragging', 'is-resizing');
            resizeBoard();
        }

        function showDialog(type) {
            const isHelp = type === 'help';
            dialogTitle.textContent = isHelp ? copy().helpTitle : copy().aboutTitle;
            dialogCopy.textContent = isHelp ? copy().helpCopy : copy().aboutCopy;
            dialog.dataset.type = type;
            dialog.hidden = false;
            closeMenus();
            dialog.querySelector('[data-gomoku-dialog-close]')?.focus();
        }

        function applyLanguage(nextLanguage = document.documentElement.lang) {
            language = normalizeLanguage(nextLanguage);
            document.querySelectorAll('[data-gomoku-i18n]').forEach((element) => {
                const key = element.getAttribute('data-gomoku-i18n');
                if (copy()[key]) element.textContent = copy()[key];
            });
            if (gameWindow.classList.contains('is-launching')) startLaunchSequence();
            if (!dialog.hidden) showDialog(dialog.dataset.type || 'help');
            render();
        }

        document.querySelectorAll('[data-open-gomoku]').forEach((button) => {
            button.addEventListener('click', openGame);
        });

        gameTask.addEventListener('click', () => {
            if (gameWindow.classList.contains('is-minimized') || gameWindow.classList.contains('is-closed')) {
                openGame();
                return;
            }
            if (gameWindow.classList.contains('is-active')) {
                minimizeGame();
                return;
            }
            focusGame();
        });

        document.querySelectorAll('[data-gomoku-window-action]').forEach((button) => {
            button.addEventListener('click', () => {
                const action = button.getAttribute('data-gomoku-window-action');
                if (action === 'minimize') minimizeGame();
                if (action === 'maximize') toggleMaximize();
                if (action === 'close') closeGame();
            });
        });

        document.querySelectorAll('[data-gomoku-new]').forEach((button) => button.addEventListener('click', newGame));
        document.querySelector('[data-gomoku-undo]')?.addEventListener('click', undoMove);
        document.querySelector('[data-gomoku-help]')?.addEventListener('click', () => showDialog('help'));
        document.querySelector('[data-gomoku-about]')?.addEventListener('click', () => showDialog('about'));
        document.querySelectorAll('[data-gomoku-dialog-close]').forEach((button) => {
            button.addEventListener('click', () => {
                dialog.hidden = true;
            });
        });

        document.querySelectorAll('[data-gomoku-menu]').forEach((button) => {
            button.addEventListener('click', (event) => {
                event.stopPropagation();
                const name = button.getAttribute('data-gomoku-menu');
                const popup = document.querySelector(`[data-gomoku-menu-popup="${name}"]`);
                const open = popup.hidden;
                closeMenus();
                popup.hidden = !open;
                button.setAttribute('aria-expanded', String(open));
            });
        });
        document.querySelector('[data-gomoku-menubar]')?.addEventListener('click', (event) => event.stopPropagation());
        document.addEventListener('click', closeMenus);

        canvas.addEventListener('pointermove', (event) => {
            const position = canvasPosition(event);
            hoverPosition = position && board[position.row][position.col] === EMPTY ? position : null;
            drawBoard();
        });
        canvas.addEventListener('pointerleave', () => {
            hoverPosition = null;
            drawBoard();
        });
        canvas.addEventListener('click', (event) => {
            const position = canvasPosition(event);
            if (position) playHumanMove(position.row, position.col);
        });

        titlebar.addEventListener('pointerdown', (event) => {
            if (event.target.closest('.window-controls')) return;
            startPointerInteraction(event, 'drag');
        });
        titlebar.addEventListener('dblclick', (event) => {
            if (!event.target.closest('.window-controls')) toggleMaximize();
        });
        resizeHandle.addEventListener('pointerdown', (event) => startPointerInteraction(event, 'resize'));
        document.addEventListener('pointermove', updatePointerInteraction);
        document.addEventListener('pointerup', finishPointerInteraction);
        document.addEventListener('pointercancel', finishPointerInteraction);

        document.addEventListener('keydown', (event) => {
            if (gameWindow.classList.contains('is-minimized')
                || gameWindow.classList.contains('is-closed')
                || !gameWindow.classList.contains('is-active')) return;
            if (event.key === 'F2') {
                event.preventDefault();
                newGame();
            }
            if (event.ctrlKey && event.key.toLowerCase() === 'z') {
                event.preventDefault();
                undoMove();
            }
            if (!event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'f') {
                event.preventDefault();
                toggleMaximize();
            }
            if (event.key === 'Escape') {
                if (!dialog.hidden) dialog.hidden = true;
                else if (gameWindow.classList.contains('is-maximized')) toggleMaximize();
                closeMenus();
            }
        });

        window.addEventListener('portfolio-language-change', (event) => {
            applyLanguage(event.detail?.language);
        });
        window.addEventListener('resize', () => {
            if (window.innerWidth <= 900) {
                finishPointerInteraction();
                gameWindow.classList.remove('is-maximized');
                restoreGeometry = undefined;
                clearWindowGeometry();
            }
            window.requestAnimationFrame(resizeBoard);
        });
        new ResizeObserver(resizeBoard).observe(boardFrame);

        window.render_game_to_text = () => JSON.stringify({
            game: 'gomoku',
            window: gameWindow.classList.contains('is-closed') ? 'closed'
                : gameWindow.classList.contains('is-minimized') ? 'minimized' : 'open',
            launching: gameWindow.classList.contains('is-launching'),
            coordinateSystem: 'row 0 is top, column 0 is left; both increase toward bottom-right',
            boardSize: BOARD_SIZE,
            score: { human: humanScore, computer: computerScore },
            phase,
            currentPlayer: currentPlayer === HUMAN ? 'human-black' : currentPlayer === COMPUTER ? 'computer-white' : null,
            winner: winner === HUMAN ? 'human-black' : winner === COMPUTER ? 'computer-white' : null,
            moves: history.map((move) => ({
                row: move.row,
                col: move.col,
                player: move.player === HUMAN ? 'human-black' : 'computer-white'
            })),
            winningLine,
            controls: ['click intersection', 'F2 new game', 'Ctrl+Z undo', 'F maximize']
        });
        window.advanceTime = (milliseconds) => {
            if (phase === 'thinking' && milliseconds >= 0) runComputerMove();
            render();
        };
        window.GomokuGame = { open: openGame, newGame, undo: undoMove, playMove: playHumanMove, loadPosition };

        createEngine();
        applyLanguage();
        render();
    }

    document.addEventListener('DOMContentLoaded', setupGomokuGame);
})();
