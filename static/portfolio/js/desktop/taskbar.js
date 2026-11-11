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
        const clockButton = document.querySelector('[data-calendar-toggle]');
        const calendar = document.querySelector('[data-taskbar-calendar]');
        const calendarMonth = document.querySelector('[data-calendar-month]');
        const calendarDays = document.querySelector('[data-calendar-days]');
        const calendarWeekdays = document.querySelector('[data-calendar-weekdays]');
        const calendarToday = document.querySelector('[data-calendar-today]');
        const calendarTime = document.querySelector('[data-calendar-time]');
        const desktopButton = document.querySelector('[data-show-desktop]');
        const taskButtons = document.querySelectorAll('.task-window-button');
        const taskList = document.createElement('div');
        taskList.className = 'taskbar-tasks';
        taskButtons[0].before(taskList);
        taskList.append(...taskButtons);
        let shutdownTimers = [];
        let shutdownBackground = [];
        let displayedMonth;
        let followToday = true;
        let calendarStamp;

        const updateDesktopButton = () => {
            const shown = manager.isDesktopShown();
            const label = shown ? t().taskbarRestoreWindows : t().taskbarShowDesktop;
            desktopButton.setAttribute('aria-pressed', String(shown));
            desktopButton.setAttribute('aria-label', label);
            desktopButton.title = label;
        };
        desktopButton.addEventListener('click', () => {
            manager.toggleDesktop();
            updateDesktopButton();
            desktopButton.focus({ preventScroll: true });
        });
        window.addEventListener('portfolio-language-change', updateDesktopButton);
        window.addEventListener('gavin:desktop-visibility-change', updateDesktopButton);
        updateDesktopButton();

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
            closeCalendar();
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

        const dateKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

        const renderCalendar = (now) => {
            const locales = navigator.languages;
            const format = options => new Intl.DateTimeFormat(locales, { calendar: 'gregory', ...options });
            const locale = new Intl.Locale(format({}).resolvedOptions().locale);
            const week = locale.getWeekInfo?.() || locale.weekInfo;
            const firstDay = (week?.firstDay || 1) % 7;
            if (followToday) displayedMonth = { year: now.getFullYear(), month: now.getMonth() };
            const { year, month } = displayedMonth;
            calendarMonth.textContent = format({ year: 'numeric', month: 'long' }).format(new Date(year, month, 1, 12));
            calendarWeekdays.replaceChildren(...Array.from({ length: 7 }, (_, index) => {
                const label = document.createElement('span');
                label.textContent = format({ weekday: 'short' }).format(new Date(2024, 0, 7 + (firstDay + index) % 7, 12));
                return label;
            }));
            const count = new Date(year, month + 1, 0, 12).getDate();
            const dayFormat = format({ day: 'numeric' });
            const dateFormat = format({ dateStyle: 'full' });
            calendarDays.replaceChildren(...Array.from({ length: count }, (_, index) => {
                const date = new Date(year, month, index + 1, 12);
                const day = document.createElement('time');
                day.dateTime = dateKey(date);
                day.textContent = dayFormat.format(date);
                day.title = dateFormat.format(date);
                if (!index) day.style.gridColumnStart = String((date.getDay() - firstDay + 7) % 7 + 1);
                if (day.dateTime === dateKey(now)) day.setAttribute('aria-current', 'date');
                return day;
            }));
            const today = calendar.querySelector('[data-calendar-date]');
            today.dateTime = dateKey(now);
            today.textContent = dateFormat.format(now);
            calendar.querySelector('[data-calendar-zone]').textContent = format({ timeZoneName: 'long' })
                .formatToParts(now).find(part => part.type === 'timeZoneName').value;
        };

        const closeCalendar = (restoreFocus = false) => {
            calendar.hidden = true;
            clockButton.setAttribute('aria-expanded', 'false');
            if (restoreFocus) clockButton.focus({ preventScroll: true });
        };

        const updateClock = () => {
            const now = new Date();
            const timeFormat = new Intl.DateTimeFormat(navigator.languages, {
                hour: '2-digit',
                minute: '2-digit',
                hourCycle: 'h23'
            });
            clock.textContent = timeFormat.format(now);
            clock.dateTime = now.toISOString();
            calendarTime.textContent = clock.textContent;
            calendarTime.dateTime = clock.dateTime;
            const date = new Intl.DateTimeFormat(navigator.languages, { calendar: 'gregory', dateStyle: 'full' }).format(now);
            clockButton.title = date;
            clockButton.setAttribute('aria-label', `${t().calendarOpen} · ${date} · ${clock.textContent}`);
            const stamp = `${dateKey(now)}|${timeFormat.resolvedOptions().locale}|${timeFormat.resolvedOptions().timeZone}|${now.getTimezoneOffset()}`;
            if (!calendar.hidden && calendarStamp !== stamp) renderCalendar(now);
            calendarStamp = stamp;
        };

        clockButton.addEventListener('click', () => {
            if (!calendar.hidden) {
                closeCalendar();
                return;
            }
            closeStartMenu();
            followToday = true;
            updateClock();
            renderCalendar(new Date());
            calendar.hidden = false;
            clockButton.setAttribute('aria-expanded', 'true');
            calendarToday.focus({ preventScroll: true });
        });
        for (const [selector, offset] of [['[data-calendar-prev]', -1], ['[data-calendar-next]', 1]]) {
            calendar.querySelector(selector).addEventListener('click', () => {
                followToday = false;
                const next = new Date(displayedMonth.year, displayedMonth.month + offset, 1, 12);
                displayedMonth = { year: next.getFullYear(), month: next.getMonth() };
                renderCalendar(new Date());
            });
        }
        calendarToday.addEventListener('click', () => {
            followToday = true;
            renderCalendar(new Date());
        });
        document.addEventListener('pointerdown', event => {
            if (!calendar.contains(event.target) && !clockButton.contains(event.target)) closeCalendar();
        });
        document.addEventListener('focusin', event => {
            if (!calendar.contains(event.target) && !clockButton.contains(event.target)) closeCalendar();
        });
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && !calendar.hidden) {
                event.preventDefault();
                closeCalendar(true);
            }
        });
        window.addEventListener('focus', updateClock);
        window.addEventListener('pageshow', updateClock);
        window.addEventListener('languagechange', () => { calendarStamp = null; updateClock(); });
        window.addEventListener('portfolio-language-change', updateClock);
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) updateClock();
        });

        return {
            startClock: () => {
                updateClock();
                window.setInterval(updateClock, 30000);
            }
        };
    }

    desktopApi.setupTaskbar = setupTaskbar;
})();
