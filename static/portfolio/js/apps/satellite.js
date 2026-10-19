(() => {
    const desktopApi = window.GavinDesktop;
    const { t } = desktopApi;

    // Satellite tracker window. The tracker bundle (js/satellite-tracker.js) is only
    // downloaded the first time the window opens.
    function setupSatellite(manager) {
        const satelliteWindow = document.querySelector('[data-satellite-window]');
        const satelliteTitlebar = document.querySelector('[data-satellite-drag]');
        const satelliteResizeHandle = document.querySelector('[data-satellite-resize]');
        const satelliteTask = document.querySelector('[data-satellite-task]');
        const satelliteStatus = document.querySelector('[data-satellite-status]');
        if (!satelliteWindow || !satelliteTitlebar || !satelliteResizeHandle || !satelliteTask
            || !satelliteStatus) return null;

        let satelliteTrackerPromise;
        const loadSatelliteTracker = () => {
            if (window.SatelliteTracker) return Promise.resolve(window.SatelliteTracker);
            if (satelliteTrackerPromise) return satelliteTrackerPromise;

            satelliteTrackerPromise = new Promise((resolve, reject) => {
                const mainScript = Array.from(document.scripts).find((script) => script.src.includes('/main.js'));
                const version = mainScript ? new URL(mainScript.src).search : '';
                const script = document.createElement('script');
                script.src = `js/satellite-tracker.js${version}`;
                script.onload = () => resolve(window.SatelliteTracker);
                script.onerror = reject;
                document.head.append(script);
            }).catch((error) => {
                satelliteTrackerPromise = null;
                throw error;
            });
            return satelliteTrackerPromise;
        };

        const showSatelliteWindow = () => {
            manager.showWindow(satelliteWindow, satelliteTask, { revealTask: true });
            if (!window.SatelliteTracker) {
                satelliteStatus.dataset.i18n = 'satelliteLoading';
                satelliteStatus.textContent = t().satelliteLoading;
            }
            loadSatelliteTracker()
                .then((tracker) => tracker.open())
                .catch(() => {
                    satelliteStatus.dataset.i18n = 'satelliteLoadError';
                    satelliteStatus.textContent = t().satelliteLoadError;
                });
        };

        const entry = manager.registerWindow({
            id: 'satellite',
            element: satelliteWindow,
            task: satelliteTask,
            titlebar: satelliteTitlebar,
            resizeHandle: satelliteResizeHandle,
            actionAttribute: 'data-satellite-action',
            minWidth: 520,
            minHeight: 390,
            show: showSatelliteWindow,
            focusTarget: () => satelliteWindow.querySelector('[data-satellite-search]')
        });

        manager.addMenuActions({
            'satellite-refresh': () => window.SatelliteTracker?.refresh(),
            'satellite-close': () => entry.hide('is-closed'),
            'satellite-reset-view': () => window.SatelliteTracker?.resetView(),
            'satellite-toggle-orbit': () => window.SatelliteTracker?.toggleOrbit(),
            'satellite-toggle-size': entry.toggleMaximize,
            'satellite-about': () => window.SatelliteTracker?.about()
        });

        document.querySelectorAll('[data-open-satellite]').forEach((button) => {
            button.addEventListener('click', showSatelliteWindow);
        });

        // Restarts the tracker when a restored session left the window open.
        const resumeIfVisible = () => {
            if (!manager.isWindowVisible(satelliteWindow)) return;
            loadSatelliteTracker()
                .then((tracker) => tracker.open())
                .catch(() => {
                    satelliteStatus.textContent = t().satelliteLoadError;
                });
        };

        return { open: showSatelliteWindow, resumeIfVisible };
    }

    desktopApi.apps.satellite = setupSatellite;
})();
