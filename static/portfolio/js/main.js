import '../css/base.css';
import '../css/desktop.css';
import '../css/desktop-pet.css';
import '../css/apps/satellite.css';
import '../css/apps/preview-zoom.css';
import '../css/apps/project-folder.css';
import '../css/apps/mail.css';
import '../css/apps/gomoku.css';
import '../css/apps/recycle-bin.css';
import '../css/apps/sync-space.css';
import '../css/apps/sync-preview.css';
import '../css/apps/sync-storage.css';
import '../css/apps/control-panel.css';
import '../css/portfolio.css';
import '../css/taskbar.css';
import '../css/desktop-responsive.css';
import '../css/print.css';
import './desktop/core.js';
import './desktop/window-manager.js';
import './desktop/taskbar.js';
import './desktop/parent-bridge.js';
import './desktop/robot-pet.js';
import './apps/portfolio.js';
import './apps/project-folder.js';
import './apps/mail.js';
import './apps/satellite.js';
import './apps/recycle-bin.js';
import './apps/sync-space.js';
import './apps/sync-preview.js';
import './apps/sync-storage.js';
import './apps/control-panel.js';

// Boots the retro desktop. Shared helpers live in js/desktop/, each window in js/apps/.
// To add an app: create js/apps/<name>.js that registers GavinDesktop.apps.<name>, call
// manager.registerWindow() inside it, then import it here and call it in setupDesktopShell().
(() => {
    const desktopApi = window.GavinDesktop;
    const { USER } = window.PORTFOLIO_DATA;

    function setupDesktopShell() {
        const desktop = document.querySelector('[data-retro-desktop]');
        const startButton = document.querySelector('[data-start-toggle]');
        const startMenu = document.querySelector('[data-start-menu]');
        if (!desktop || !startButton || !startMenu) return;

        const manager = desktopApi.createWindowManager({ desktop, startButton, startMenu });
        const portfolio = desktopApi.apps.portfolio(manager);
        if (!portfolio) return;
        desktopApi.apps.projectFolder(manager);
        desktopApi.apps.mail(manager);
        const satellite = desktopApi.apps.satellite(manager);
        desktopApi.apps.recycleBin(manager);
        const syncPreview = desktopApi.apps.syncPreview(manager);
        desktopApi.apps.syncSpace(manager, syncPreview);
        desktopApi.apps.syncStorage(manager);
        desktopApi.apps.controlPanel(manager);
        desktopApi.setupRobotPet(manager);

        const gameWindow = document.querySelector('[data-gomoku-window]');
        const gameTask = document.querySelector('[data-gomoku-task]');
        if (gameWindow && gameTask) {
            manager.registerExternalWindow({
                id: 'gomoku',
                element: gameWindow,
                task: gameTask,
                focusTarget: () => gameWindow.querySelector('[data-gomoku-board]')
            });
        }

        const taskbar = desktopApi.setupTaskbar(manager, { showPortfolioWindow: portfolio.show });
        manager.bindGlobalListeners();

        const restoredActiveEntry = manager.restoreDesktopSession();
        window.history.scrollRestoration = 'manual';
        window.addEventListener('popstate', () => {
            if (desktopApi.isMobileHomepage()) portfolio.showMobileHomepage();
            else desktopApi.scrollPortfolioWindow(window.location.hash || '#top', false, 'instant');
        });
        if (desktopApi.isMobileHomepage()) {
            portfolio.showMobileHomepage();
            window.addEventListener('pageshow', portfolio.showMobileHomepage);
        } else if (restoredActiveEntry) {
            manager.focusWindow(restoredActiveEntry.element);
        } else {
            manager.focusWindow(portfolio.entry.element);
        }
        satellite?.resumeIfVisible();
        if (!restoredActiveEntry && document.body.classList.contains('direct-portfolio') && window.innerWidth > 900) {
            portfolio.entry.toggleMaximize();
        }

        taskbar.startClock();
    }

    document.addEventListener('DOMContentLoaded', () => {
        const directReturn = document.querySelector('[data-direct-return]');
        const mobileHomepage = new URLSearchParams(window.location.search).get('view') === 'mobile-homepage';
        document.body.classList.toggle('mobile-homepage', mobileHomepage);

        if (directReturn && window.parent === window && !mobileHomepage) {
            directReturn.hidden = false;
            document.body.classList.add('direct-portfolio');
        }

        document.querySelectorAll('img[src="' + USER.avatar + '"]').forEach((img) => {
            img.alt = USER.name;
        });

        const favicon = document.getElementById('favicon');
        if (favicon) favicon.href = USER.avatar;

        desktopApi.setupParentEventBridge();
        setupDesktopShell();
        desktopApi.portfolio.setupPortfolioInteractions();
        desktopApi.portfolio.applyLanguage();
        desktopApi.portfolio.routeLegacySkillLinks();
    });
})();
