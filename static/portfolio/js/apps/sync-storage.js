export function setupSyncStorage(app) {
    const desktop = window.GavinDesktop;
    const button = app.querySelector('[data-sync-storage-refresh]');
    const notice = app.querySelector('[data-sync-storage-notice]');
    const details = app.querySelector('[data-sync-storage-details]');
    const metrics = app.querySelector('[data-sync-storage-metrics]');
    const dailyMetrics = app.querySelector('[data-sync-daily-metrics]');
    const dailyNotice = app.querySelector('[data-sync-daily-notice]');
    const dailyChecked = app.querySelector('[data-sync-daily-checked]');
    const panel = app.closest('[data-control-panel-window]');
    const refreshInterval = 15 * 60 * 1000;
    let request;
    let data;
    let dailyLoading = false;
    let refreshTimer;
    let lastLoadAt = 0;
    let viewingDesktop = window.parent === window;
    let noticeKey = 'syncStorageReady';
    const t = () => desktop.t();
    const timestamp = (value) => value ? new Date(value).toLocaleString(desktop.getLanguage()) : t().syncStorageNever;
    const bytes = (value) => `${(value / 1e9).toFixed(3)} GB`;
    const render = () => {
        details.hidden = !data;
        metrics.replaceChildren();
        metrics.hidden = !data;
        dailyMetrics.replaceChildren();
        dailyMetrics.hidden = true;
        dailyNotice.textContent = '';
        dailyNotice.dataset.state = '';
        dailyChecked.textContent = '';
        notice.dataset.i18n = noticeKey;
        notice.dataset.state = noticeKey === 'syncStorageFailed' ? 'error' : '';
        notice.textContent = noticeKey ? t()[noticeKey] : t().syncStorageChecked.replace('{time}', timestamp(data.checkedAt));
        if (!data) return;
        const probe = (value) => value ? t()[value.ok ? 'syncStorageHealthy' : 'syncStorageUnhealthy'] : t().syncStorageNoSample;
        const fields = [
            ['syncStorageLastHealthy', timestamp(data.lastHealthyCheckAt)],
            ['syncStorageProbeMain', probe(data.database.registry)],
            ['syncStorageProbeRoom', probe(data.database.sampledRoom)],
            ['syncStorageProbeShard', probe(data.database.sampledShard)],
            ['syncStorageStorage', `${bytes(data.storage.bytes)} / ${bytes(data.storage.highWaterBytes)}`],
            ['syncStorageStored', bytes(data.storage.storedBytes)],
            ['syncStorageReserved', bytes(data.storage.reservedBytes)],
            ['syncStorageAvailable', bytes(Math.max(0, data.storage.highWaterBytes - data.storage.bytes))],
            ['syncStorageRooms', String(data.storage.roomCount)],
            ['syncStorageCleanup', t()[data.maintenance.phase === 'prune' ? 'syncStoragePrune' : data.maintenance.phase === 'refresh' ? 'syncStorageChecking' : data.maintenance.phase === 'retry' ? 'syncStorageRetrying' : 'syncStorageIdle']],
            ['syncStorageScanned', data.maintenance.scannedRooms === null ? '—' : String(data.maintenance.scannedRooms)],
            ['syncStorageFailedRooms', String(data.maintenance.failedRooms || 0)],
            ['syncStoragePendingTasks', String(data.maintenance.pendingTasks || 0)],
            ['syncStorageLongestWait', t()[data.maintenance.longestWaitMs >= 60000 ? 'syncStorageWaitMinutes' : 'syncStorageWaitSeconds'].replace('{count}', String(Math.floor((data.maintenance.longestWaitMs || 0) / (data.maintenance.longestWaitMs >= 60000 ? 60000 : 1000))))],
            ['syncStorageFreed', bytes(data.maintenance.freedBytes || 0)],
            ['syncStorageTarget', data.maintenance.phase === 'prune' ? bytes(data.maintenance.targetBytes) : '—'],
            ['syncStorageLastSuccess', timestamp(data.maintenance.lastSuccessAt)],
            ['syncStorageLastFailure', timestamp(data.maintenance.lastFailureAt)],
            ['syncStorageNextAlarm', timestamp(data.maintenance.nextAlarmAt)]
        ];
        if (data.maintenance.status) fields.splice(9, 0, ['syncStorageMaintenance', t()[{
            never: 'syncStorageMaintenanceNever', running: 'syncStorageMaintenanceRunning',
            overdue: 'syncStorageMaintenanceOverdue', failed: 'syncStorageMaintenanceFailed', healthy: 'syncStorageMaintenanceHealthy'
        }[data.maintenance.status]]]);
        for (const [name, value] of fields) {
            const term = document.createElement('dt');
            term.textContent = t()[name];
            const detail = document.createElement('dd');
            detail.textContent = value;
            metrics.append(term, detail);
        }
        const daily = data.dailyUsage;
        dailyNotice.dataset.state = dailyLoading ? 'loading' : daily?.status || 'unavailable';
        dailyNotice.textContent = dailyLoading ? t().syncDailyLoading : t()[{
            ready: 'syncDailyReady', stale: 'syncDailyStale', not_configured: 'syncDailyNotConfigured', unavailable: 'syncDailyUnavailable'
        }[daily?.status || 'unavailable']];
        if (!daily?.day) return;
        dailyChecked.textContent = t().syncDailyChecked.replace('{day}', daily.day).replace('{time}', timestamp(daily.checkedAt)).replace('{reset}', timestamp(daily.resetsAt));
        if (!daily.available || !daily.metrics) return;
        dailyMetrics.hidden = false;
        const number = (value) => value.toLocaleString(desktop.getLanguage(), { maximumFractionDigits: 2 });
        for (const [key, label] of [['workersRequests', 'syncDailyWorkers'], ['durableRequests', 'syncDailyDurable'], ['rowsRead', 'syncDailyReads'], ['rowsWritten', 'syncDailyWrites'], ['duration', 'syncDailyDuration']]) {
            const value = daily.metrics[key];
            const term = document.createElement('dt');
            term.textContent = t()[label];
            const detail = document.createElement('dd');
            detail.dataset.level = value.level;
            detail.textContent = `${number(value.used)} / ${number(value.limit)} (${number(value.used / value.limit * 100)}%)`;
            dailyMetrics.append(term, detail);
        }
    };
    const setNotice = (name) => {
        noticeKey = name;
        notice.dataset.i18n = name;
        notice.dataset.state = name === 'syncStorageFailed' ? 'error' : '';
        notice.textContent = t()[name];
    };
    const isViewing = () => viewingDesktop && !app.hidden && !panel.inert && !document.hidden
        && !panel.classList.contains('is-closed') && !panel.classList.contains('is-minimized');
    const updatePolling = () => {
        clearTimeout(refreshTimer);
        if (!isViewing()) {
            if (request) lastLoadAt = 0;
            request?.abort();
            request = null;
            dailyLoading = false;
            button.disabled = false;
            if (noticeKey === 'syncStorageLoading') {
                noticeKey = data ? '' : 'syncStorageReady';
                render();
            }
            return;
        }
        if (request) return;
        const remaining = refreshInterval - (Date.now() - lastLoadAt);
        if (!lastLoadAt || remaining <= 0) load();
        else refreshTimer = setTimeout(load, remaining);
    };
    const load = async () => {
        if (!isViewing()) return;
        clearTimeout(refreshTimer);
        request?.abort();
        const controller = new AbortController();
        request = controller;
        lastLoadAt = Date.now();
        button.disabled = true;
        setNotice('syncStorageLoading');
        try {
            const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
            const config = await fetch(new URL('sync-config.json', document.baseURI), { cache: 'no-store', signal });
            if (!config.ok) throw new Error('unavailable');
            const { apiBase } = await config.json();
            const base = new URL(apiBase);
            if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname))) throw new Error('invalid_endpoint');
            const response = await fetch(`${base.href.replace(/\/$/, '')}/v1/status`, { cache: 'no-store', signal });
            if (request !== controller) return;
            const result = await response.json();
            if (!response.ok && !result.database) throw new Error('unavailable');
            data = { ...result, dailyUsage: data?.dailyUsage };
            noticeKey = '';
            dailyLoading = true;
            render();
            try {
                const usageResponse = await fetch(`${base.href.replace(/\/$/, '')}/v1/usage`, {
                    cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)])
                });
                if (!usageResponse.ok) throw new Error('unavailable');
                const usage = await usageResponse.json();
                if (request !== controller) return;
                data.dailyUsage = usage;
            } catch {
                if (request !== controller || controller.signal.aborted) return;
                data.dailyUsage = data.dailyUsage?.available
                    ? { ...data.dailyUsage, status: 'stale', stale: true }
                    : { status: 'unavailable' };
            }
            dailyLoading = false;
            render();
        } catch {
            if (request === controller && !controller.signal.aborted) {
                if (data?.dailyUsage?.available) data.dailyUsage = { ...data.dailyUsage, status: 'stale', stale: true };
                noticeKey = 'syncStorageFailed';
                render();
            }
        } finally {
            if (request === controller) {
                button.disabled = false;
                request = null;
                lastLoadAt = Date.now();
                updatePolling();
            }
        }
    };
    button.addEventListener('click', load);
    window.addEventListener('portfolio-language-change', render);
    window.addEventListener('message', (event) => {
        if (event.origin !== window.location.origin || event.source !== window.parent
            || event.data?.source !== 'gavin-shell' || event.data?.type !== 'portfolio-view-state') return;
        viewingDesktop = event.data.active === true;
        updatePolling();
    });
    document.addEventListener('visibilitychange', updatePolling);
    new MutationObserver(updatePolling).observe(panel, { attributes: true, attributeFilter: ['class', 'inert'] });
    return {
        show: updatePolling,
        reset: () => {
            clearTimeout(refreshTimer);
            request?.abort();
            request = null;
            data = null;
            dailyLoading = false;
            lastLoadAt = 0;
            noticeKey = 'syncStorageReady';
            button.disabled = false;
            render();
            setNotice('syncStorageReady');
            app.querySelector('.sync-storage-body').scrollTop = 0;
        }
    };
}
