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
        let satelliteLoadAttempt = 0;
        const loadSatelliteTracker = () => {
            if (window.SatelliteTracker) return Promise.resolve(window.SatelliteTracker);
            if (satelliteTrackerPromise) return satelliteTrackerPromise;

            satelliteTrackerPromise = new Promise((resolve, reject) => {
                const mainScript = Array.from(document.scripts).find((script) => script.src.includes('/main.js'));
                const version = mainScript ? new URL(mainScript.src).search : '';
                const script = document.createElement('script');
                const source = new URL(`js/satellite-tracker.js${version}`, document.baseURI);
                // Removed scripts can keep downloading in Chromium; retries need a fresh request.
                if (satelliteLoadAttempt) source.searchParams.set('retry', String(satelliteLoadAttempt));
                satelliteLoadAttempt++;
                script.src = source.href;
                const timeout = setTimeout(() => script.onerror(), 30000);
                script.onload = () => {
                    clearTimeout(timeout);
                    resolve(window.SatelliteTracker);
                };
                script.onerror = () => {
                    clearTimeout(timeout);
                    script.onload = script.onerror = null;
                    script.remove();
                    reject(new Error('Satellite module failed to load'));
                };
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
            'satellite-refresh': () => window.SatelliteTracker ? window.SatelliteTracker.refresh() : showSatelliteWindow(),
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
                    satelliteStatus.dataset.i18n = 'satelliteLoadError';
                    satelliteStatus.textContent = t().satelliteLoadError;
                });
        };

        return { open: showSatelliteWindow, resumeIfVisible };
    }

    desktopApi.apps.satellite = setupSatellite;
})();
