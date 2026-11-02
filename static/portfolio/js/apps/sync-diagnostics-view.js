import { getConnectionDiagnostics } from './sync-connection-diagnostics.js';
import { getNotificationState, readNotificationDiagnostics, testSystemNotification } from './sync-notifications.js';

export function setupSyncDiagnostics(view) {
    const desktop = window.GavinDesktop;
    const find = name => view.querySelector(`[data-sync-diagnostics-${name}]`);
    const testButton = find('test');
    const notice = find('notice');
    let testing = false;
    let result = '';
    const t = (key, values = {}) => Object.entries(values).reduce((text, [name, value]) => text.replace(`{${name}}`, value), desktop.t()[key] || '—');
    const time = value => value ? new Date(value).toLocaleString(desktop.getLanguage()) : '—';
    const duration = value => Number.isFinite(value) ? `${Math.round(value)} ms` : '—';
    const status = value => t({
        online: 'syncDiagnosticsConnected', connecting: 'syncDiagnosticsConnecting', offline: 'syncDiagnosticsDisconnected',
        shown: 'syncDiagnosticsShown', foreground: 'syncDiagnosticsForeground', duplicate: 'syncDiagnosticsDuplicate',
        disabled: 'syncDiagnosticsDisabled', timeout: 'syncDiagnosticsTimeout', lock_timeout: 'syncDiagnosticsLockTimeout',
        error: 'syncDiagnosticsError', denied: 'syncDiagnosticsDenied', unsupported: 'syncDiagnosticsUnsupported'
    }[value] || 'syncDiagnosticsUnknown');
    const fields = (element, values) => {
        element.replaceChildren();
        for (const [label, value] of values) {
            const term = document.createElement('dt');
            const detail = document.createElement('dd');
            term.textContent = t(label);
            detail.textContent = value;
            element.append(term, detail);
        }
    };
    const render = () => {
        if (view.hidden) return;
        const connection = getConnectionDiagnostics();
        const notifications = readNotificationDiagnostics();
        const permission = getNotificationState();
        const latest = notifications.at(-1);
        fields(find('metrics'), [
            ['syncDiagnosticsNetwork', t(navigator.onLine ? 'syncDiagnosticsBrowserOnline' : 'syncDiagnosticsDisconnected')],
            ['syncDiagnosticsConnections', t('syncDiagnosticsCounts', connection.connections)],
            ['syncDiagnosticsShared', String(connection.connections.shared)],
            ['syncDiagnosticsReconnects', String(connection.reconnects)],
            ['syncDiagnosticsLastConnected', time(connection.lastConnectedAt)],
            ['syncDiagnosticsConnectTime', duration(connection.lastConnectMs)],
            ['syncDiagnosticsPermission', t(!permission.supported ? 'syncDiagnosticsUnsupported'
                : permission.permission === 'granted' ? 'syncDiagnosticsGranted'
                    : permission.permission === 'denied' ? 'syncDiagnosticsDenied' : 'syncDiagnosticsNotAsked')],
            ['syncDiagnosticsSwitch', t(permission.enabled ? 'syncDiagnosticsEnabled' : 'syncDiagnosticsDisabled')],
            ['syncDiagnosticsWorker', t(permission.workerState === 'activated' ? 'syncDiagnosticsWorkerReady' : 'syncDiagnosticsWorkerPending')]
        ]);
        fields(find('timings'), [
            ['syncDiagnosticsResult', latest ? status(latest.status) : t('syncDiagnosticsEmpty')],
            ['syncDiagnosticsReceived', time(latest?.at)],
            ['syncDiagnosticsBeforeRequest', duration(latest?.receiveToRequestMs)],
            ['syncDiagnosticsQueue', duration(latest?.queueMs)],
            ['syncDiagnosticsPreparation', duration(latest?.prepareMs)],
            ['syncDiagnosticsWorkerTime', duration(latest?.workerMs)],
            ['syncDiagnosticsTotal', duration(latest?.totalMs)]
        ]);
        const events = [...connection.events.map(entry => ({ ...entry, category: 'syncDiagnosticsConnection' })),
            ...notifications.map(entry => ({ ...entry, category: 'syncDiagnosticsNotificationEvent' }))]
            .sort((a, b) => b.at - a.at).slice(0, 10);
        const list = find('events');
        list.replaceChildren();
        for (const event of events) {
            const item = document.createElement('li');
            item.textContent = `${time(event.at)} · ${t(event.category)} · ${status(event.status)}`;
            list.append(item);
        }
        if (!events.length) {
            const item = document.createElement('li');
            item.textContent = t('syncDiagnosticsEmpty');
            list.append(item);
        }
        testButton.disabled = testing || !permission.supported;
        notice.textContent = testing ? t('syncDiagnosticsTesting') : result ? status(result) : '';
        notice.dataset.state = ['error', 'denied', 'timeout', 'unsupported'].includes(result) ? 'error' : '';
    };
    testButton.addEventListener('click', async () => {
        testing = true;
        result = '';
        render();
        try {
            result = (await testSystemNotification({ title: t('desktopSyncSpace'), body: t('syncDiagnosticsTestBody') })).status;
        } catch { result = 'error'; }
        finally { testing = false; render(); }
    });
    find('export').addEventListener('click', () => {
        const report = {
            exportedAt: Date.now(), connection: getConnectionDiagnostics(),
            notificationState: getNotificationState(), notifications: readNotificationDiagnostics()
        };
        const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = 'gavin-connection-diagnostics.json';
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    for (const event of ['sync-diagnostics-change', 'portfolio-language-change', 'online', 'offline', 'focus']) window.addEventListener(event, render);
    document.addEventListener('visibilitychange', render);
    navigator.serviceWorker?.addEventListener('controllerchange', render);
    return { show: render };
}
