export function setupSyncStorage(app) {
    const desktop = window.GavinDesktop;
    const button = app.querySelector('[data-sync-storage-refresh]');
    const notice = app.querySelector('[data-sync-storage-notice]');
    const metrics = app.querySelector('[data-sync-storage-metrics]');
    const dailyMetrics = app.querySelector('[data-sync-daily-metrics]');
    const dailyNotice = app.querySelector('[data-sync-daily-notice]');
    const dailyChecked = app.querySelector('[data-sync-daily-checked]');
    let request;
    let data;
    let noticeKey = 'syncStorageReady';
    const t = () => desktop.t();
    const timestamp = (value) => value ? new Date(value).toLocaleString(desktop.getLanguage()) : t().syncStorageNever;
    const bytes = (value) => `${(value / 1e9).toFixed(3)} GB`;
    const render = () => {
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
            ['syncStorageProbeMain', probe(data.database.registry)],
            ['syncStorageProbeRoom', probe(data.database.sampledRoom)],
            ['syncStorageProbeShard', probe(data.database.sampledShard)],
            ['syncStorageStorage', `${bytes(data.storage.bytes)} / ${bytes(data.storage.highWaterBytes)}`],
            ['syncStorageRooms', String(data.storage.roomCount)],
            ['syncStorageReserved', bytes(data.storage.reservedBytes)],
            ['syncStorageCleanup', t()[data.maintenance.phase === 'prune' ? 'syncStoragePrune' : data.maintenance.phase === 'refresh' ? 'syncStorageChecking' : 'syncStorageIdle']],
            ['syncStorageScanned', data.maintenance.scannedRooms === null ? '—' : String(data.maintenance.scannedRooms)],
            ['syncStorageTarget', data.maintenance.phase === 'prune' ? bytes(data.maintenance.targetBytes) : '—'],
            ['syncStorageLastSuccess', timestamp(data.maintenance.lastSuccessAt)],
            ['syncStorageLastFailure', timestamp(data.maintenance.lastFailureAt)],
            ['syncStorageNextAlarm', timestamp(data.maintenance.nextAlarmAt)]
        ];
        if (data.maintenance.status) fields.splice(7, 0, ['syncStorageMaintenance', t()[{
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
        dailyNotice.dataset.state = daily?.status || 'unavailable';
        dailyNotice.textContent = t()[{
            ready: 'syncDailyReady', stale: 'syncDailyStale', not_configured: 'syncDailyNotConfigured', unavailable: 'syncDailyUnavailable'
        }[daily?.status || 'unavailable']];
        if (!daily) return;
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
    const load = async () => {
        request?.abort();
        const controller = new AbortController();
        request = controller;
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
            data = result;
            noticeKey = '';
            render();
        } catch {
            if (request === controller && !controller.signal.aborted) setNotice('syncStorageFailed');
        } finally {
            if (request === controller) { button.disabled = false; request = null; }
        }
    };
    button.addEventListener('click', load);
    window.addEventListener('portfolio-language-change', render);
    return {
        show: () => { if (!data && !request) load(); },
        reset: () => {
            request?.abort();
            request = null;
            data = null;
            noticeKey = 'syncStorageReady';
            button.disabled = false;
            render();
            setNotice('syncStorageReady');
            app.querySelector('.sync-storage-body').scrollTop = 0;
        }
    };
}
