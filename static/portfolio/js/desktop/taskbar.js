(() => {
    const desktopApi = window.GavinDesktop;
    const { t } = desktopApi;

    // Start button and menu, shutdown/restart screen and the tray clock.
    function setupTaskbar(manager, { showPortfolioWindow }) {
        const { startButton, startMenu, closeStartMenu } = manager;
        const shutdownButton = document.querySelector('[data-shutdown]');
        const shutdownScreen = document.querySelector('[data-shutdown-screen]');
        const shutdownLog = document.querySelector('[data-shutdown-log]');
        const restartButton = document.querySelector('[data-restart]');
        const clock = document.querySelector('[data-retro-clock]');
        const taskButtons = document.querySelectorAll('.task-window-button');
        const taskList = document.createElement('div');
        taskList.className = 'taskbar-tasks';
        taskButtons[0].before(taskList);
        taskList.append(...taskButtons);
        let shutdownTimers = [];
        let shutdownBackground = [];

        const clearShutdownTimers = () => {
            shutdownTimers.forEach((timer) => window.clearTimeout(timer));
            shutdownTimers = [];
        };

        const restartDesktop = () => {
            clearShutdownTimers();
            shutdownBackground.forEach(([element, inert]) => { element.inert = inert; });
            shutdownBackground = [];
            if (shutdownScreen) shutdownScreen.hidden = true;
            if (shutdownLog) shutdownLog.textContent = '';
            if (restartButton) restartButton.hidden = true;
            showPortfolioWindow('#top');
        };

        const startShutdown = () => {
            if (!shutdownScreen || !shutdownLog || !restartButton) return;

            closeStartMenu();
            clearShutdownTimers();
            shutdownLog.textContent = '';
            restartButton.hidden = true;
            shutdownBackground = Array.from(shutdownScreen.parentElement.children)
                .filter((element) => element !== shutdownScreen)
                .map((element) => [element, element.inert]);
            shutdownBackground.forEach(([element]) => { element.inert = true; });
            shutdownScreen.tabIndex = -1;
            shutdownScreen.hidden = false;
            shutdownScreen.focus({ preventScroll: true });

            t().shutdownLines.forEach((line, index, lines) => {
                shutdownTimers.push(window.setTimeout(() => {
                    shutdownLog.textContent += `${line}\n`;
                    if (index === lines.length - 1) {
                        restartButton.hidden = false;
                        restartButton.focus({ preventScroll: true });
                        shutdownTimers.push(window.setTimeout(restartDesktop, 12000));
                    }
                }, 450 * (index + 1)));
            });
        };

        startButton.addEventListener('click', (event) => {
            event.stopPropagation();
            const shouldOpen = startMenu.hidden;
            closeStartMenu();
            if (shouldOpen) {
                startMenu.hidden = false;
                startButton.setAttribute('aria-expanded', 'true');
            }
        });

        startMenu.addEventListener('click', (event) => event.stopPropagation());
        document.addEventListener('click', closeStartMenu);
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') closeStartMenu();
        });

        shutdownButton?.addEventListener('click', startShutdown);
        restartButton?.addEventListener('click', restartDesktop);
        shutdownScreen?.addEventListener('keydown', (event) => {
            event.stopPropagation();
            if (event.key !== 'Tab') return;
            event.preventDefault();
            (restartButton.hidden ? shutdownScreen : restartButton).focus({ preventScroll: true });
        });
        shutdownScreen?.addEventListener('keyup', (event) => event.stopPropagation());

        const updateClock = () => {
            if (!clock) return;
            clock.textContent = new Intl.DateTimeFormat([], {
                hour: '2-digit',
                minute: '2-digit',
                hour12: false
            }).format(new Date());
        };

        return {
            startClock: () => {
                updateClock();
                window.setInterval(updateClock, 30000);
            }
        };
    }

    desktopApi.setupTaskbar = setupTaskbar;
})();
