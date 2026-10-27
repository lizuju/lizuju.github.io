import { saveLocalSession, deleteLocalSession } from './sync-crypto.js';

export const CREDENTIAL_KEY = 'portfolio-sync-space-e2ee1';
export const CATALOG_KEY = 'portfolio-sync-spaces-e2ee1';
const matches = (a, b) => !!a && !!b && a.roomId === b.roomId && a.token === b.token && a.vaultId === b.vaultId;
const valid = value => value && ['roomId', 'token', 'deviceId', 'vaultId'].every(key => typeof value[key] === 'string' && value[key].length);
const descriptor = value => ({ roomId: value.roomId, token: value.token, deviceId: value.deviceId,
    vaultId: value.vaultId, ...(typeof value.revision === 'string' ? { revision: value.revision } : {}),
    ...(Number.isSafeInteger(value.nameRevision) ? { nameRevision: value.nameRevision } : {}),
    ...(typeof value.name === 'string' && value.name ? { name: value.name } : {}) });
const locked = operation => navigator.locks.request('gavin-sync-spaces', operation);

export class SavedSpaces {
    list() {
        const values = JSON.parse(localStorage.getItem(CATALOG_KEY) || '[]');
        if (!Array.isArray(values)) throw Object.assign(new Error('Invalid saved spaces'), { code: 'storage' });
        let number = Math.max(0, ...values.filter(valid).map(value => Number.isSafeInteger(value.number) && value.number > 0 ? value.number : 0));
        return values.filter(valid).map(value => ({ ...descriptor(value), number: Number.isSafeInteger(value.number) && value.number > 0 ? value.number : ++number }));
    }

    active() {
        const value = JSON.parse(localStorage.getItem(CREDENTIAL_KEY) || 'null');
        return valid(value) ? { ...descriptor(value), ...(Number.isSafeInteger(value.number) && value.number > 0 ? { number: value.number } : {}) } : null;
    }

    find(session) { return this.list().find(value => matches(value, session)) || null; }

    importActive() {
        return locked(() => {
            const active = this.active();
            const list = this.list();
            if (active) {
                const index = list.findIndex(value => value.roomId === active.roomId);
                const item = { ...active, ...(list[index]?.name ? { name: list[index].name } : {}),
                    ...(Number.isSafeInteger(list[index]?.nameRevision) ? { nameRevision: list[index].nameRevision } : {}),
                    number: index < 0 ? Math.max(0, ...list.map(value => value.number)) + 1 : list[index].number };
                if (index >= 0 && !list[index].name) delete item.name;
                if (index < 0) list.push(item);
                else list[index] = item;
                localStorage.setItem(CATALOG_KEY, JSON.stringify(list));
            }
            return list;
        });
    }

    async save(session, { activate = false } = {}) {
        return locked(async () => {
            const list = this.list();
            const index = list.findIndex(value => activate ? value.roomId === session.roomId : matches(value, session));
            if (index < 0 && !activate) return null;
            const saved = await saveLocalSession(session);
            session.vaultId = saved.vaultId;
            session.revision = crypto.randomUUID();
            const previous = list[index];
            const item = { ...saved, revision: session.revision,
                ...(previous?.name ? { name: previous.name } : {}),
                ...(Number.isSafeInteger(previous?.nameRevision) ? { nameRevision: previous.nameRevision } : {}),
                number: previous?.number || Math.max(0, ...list.map(value => value.number)) + 1 };
            if (index < 0) list.push(item);
            else list[index] = item;
            localStorage.setItem(CATALOG_KEY, JSON.stringify(list));
            if (activate || matches(this.active(), saved)) localStorage.setItem(CREDENTIAL_KEY, JSON.stringify(item));
            if (previous && previous.vaultId !== saved.vaultId) await deleteLocalSession(previous.vaultId);
            return item;
        });
    }

    select(roomId) {
        return locked(() => {
            if (roomId === null) { localStorage.removeItem(CREDENTIAL_KEY); return null; }
            const item = this.list().find(value => value.roomId === roomId);
            if (!item) throw Object.assign(new Error('Saved space unavailable'), { code: 'key_unavailable' });
            localStorage.setItem(CREDENTIAL_KEY, JSON.stringify(item));
            return item;
        });
    }

    updateName(session, name, revision) {
        const value = String(name).trim();
        return locked(() => {
            const list = this.list();
            const item = list.find(space => matches(space, session));
            if (!item || (item.nameRevision ?? -1) >= revision) return;
            if (value) item.name = value;
            else delete item.name;
            item.nameRevision = revision;
            localStorage.setItem(CATALOG_KEY, JSON.stringify(list));
        });
    }

    remove(session) {
        return locked(async () => {
            const list = this.list();
            const item = list.find(value => matches(value, session));
            if (!item) return false;
            const remaining = list.filter(value => value !== item);
            localStorage.setItem(CATALOG_KEY, JSON.stringify(remaining));
            if (matches(this.active(), item)) {
                if (remaining.length) localStorage.setItem(CREDENTIAL_KEY, JSON.stringify(remaining[0]));
                else localStorage.removeItem(CREDENTIAL_KEY);
            }
            await deleteLocalSession(item.vaultId);
            return true;
        });
    }
}
