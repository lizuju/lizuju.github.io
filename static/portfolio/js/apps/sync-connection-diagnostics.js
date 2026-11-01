const connections = new Map();
const events = [];
let reconnects = 0;
let lastConnectedAt = null;
let lastConnectMs = null;

export function recordConnectionState(connection, state) {
    if (!['online', 'connecting', 'offline'].includes(state)) return;
    const previous = connections.get(connection);
    const role = connection.isLeader ? 'owner' : 'shared';
    if (previous?.state === state && previous.role === role) return;
    const now = Date.now();
    const entry = { state, role, startedAt: previous?.startedAt ?? now, attempted: previous?.attempted ?? false };
    if (state === 'connecting' && previous?.state !== 'connecting') {
        if (entry.attempted) reconnects++;
        entry.startedAt = now;
        entry.attempted = true;
    }
    if (state === 'offline') entry.startedAt = now;
    if (state === 'online' && previous?.state === 'offline' && entry.attempted) reconnects++;
    const event = { at: now, status: state, role };
    if (state === 'online' && previous?.state !== 'online') {
        lastConnectedAt = now;
        lastConnectMs = Math.max(0, now - entry.startedAt);
        event.connectMs = lastConnectMs;
    }
    connections.set(connection, entry);
    events.push(event);
    if (events.length > 50) events.shift();
    window.dispatchEvent(new Event('sync-diagnostics-change'));
}

export function removeConnectionDiagnostics(connection) {
    connections.delete(connection);
    window.dispatchEvent(new Event('sync-diagnostics-change'));
}

export function getConnectionDiagnostics() {
    const counts = { online: 0, connecting: 0, offline: 0, shared: 0 };
    for (const entry of connections.values()) {
        counts[entry.state]++;
        if (entry.role === 'shared' && entry.state === 'online') counts.shared++;
    }
    return { connections: counts, reconnects, lastConnectedAt, lastConnectMs, events: structuredClone(events) };
}
