export function setupSyncStorage(app) {
    const desktop = window.GavinDesktop;
    const button = app.querySelector('[data-sync-storage-refresh]');
    const notice = app.querySelector('[data-sync-storage-notice]');
    const metrics = app.querySelector('[data-sync-storage-metrics]');
    let request;
    let data;
    const t = () => desktop.t();
    const timestamp = (value) => value ? new Date(value).toLocaleString(desktop.getLanguage()) : t().syncStorageNever;
    const bytes = (value) => `${(value / 1e9).toFixed(3)} GB`;
    const render = () => {
        metrics.replaceChildren();
        metrics.hidden = !data;
        if (!data) return;
        const fields = [
            ['syncStorageDatabase', t()[data.ok ? 'syncStorageHealthy' : 'syncStorageUnhealthy']],
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
        for (const [name, value] of fields) {
            const term = document.createElement('dt');
            term.textContent = t()[name];
            const detail = document.createElement('dd');
            detail.textContent = value;
            metrics.append(term, detail);
        }
        notice.dataset.i18n = '';
        notice.textContent = t().syncStorageChecked.replace('{time}', timestamp(data.checkedAt));
    };
    const setNotice = (name) => {
        notice.dataset.i18n = name;
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
            button.disabled = false;
            render();
            setNotice('syncStorageReady');
            app.querySelector('.sync-storage-body').scrollTop = 0;
        }
    };
}
