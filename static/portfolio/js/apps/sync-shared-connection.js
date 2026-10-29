import { SyncConnection } from './sync-connection.js';

// A Web Lock elects one socket owner per saved device; closing that page releases it automatically.
export class SharedSyncConnection {
    constructor(options) {
        this.options = options;
        this.id = crypto.randomUUID();
        this.state = 'offline';
        this.stopped = false;
        this.started = false;
        this.isLeader = false;
        this.generation = 0;
        this.incoming = Promise.resolve();
        this.members = new Set();
        this.welcomed = new Set();
        this.socket = {
            readyState: WebSocket.CLOSED,
            send: data => {
                if (this.isLeader) this.transport?.socket?.send(data);
                else this.post({ type: 'send', owner: this.owner, data });
            },
            close: () => {
                if (this.isLeader) this.transport?.socket?.close();
                else this.post({ type: 'reconnect', owner: this.owner });
            }
        };
    }

    post(value) { this.channel?.postMessage({ ...value, sender: this.id }); }

    setState(state) {
        this.state = state;
        this.socket.readyState = state === 'online' ? WebSocket.OPEN : WebSocket.CLOSED;
        this.options.onState(state);
    }

    connect() {
        if (this.stopped) return;
        if (this.started) { this.transport?.connect(); return; }
        this.started = true;
        this.starting = this.start().catch(error => { if (!this.stopped) this.options.onError?.(error); });
        return this.starting;
    }

    async start() {
        const { session } = this.options;
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${session.roomId}:${session.token}`));
        if (this.stopped) return;
        const key = `gavin-sync-connection:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
        this.channel = new BroadcastChannel(key);
        this.channel.onmessage = ({ data }) => this.message(data);
        this.election = new AbortController();
        this.setState('connecting');
        this.post({ type: 'hello' });
        this.lock = navigator.locks.request(key, { signal: this.election.signal }, async () => {
            if (this.stopped) return;
            this.isLeader = true;
            this.owner = this.id;
            this.generation++;
            this.incoming = Promise.resolve();
            this.welcomed.clear();
            this.post({ type: 'owner' });
            this.transport = new SyncConnection({ ...this.options,
                receive: (data, current) => {
                    const delivery = this.incoming.then(async () => {
                        if (!current() || this.stopped) return;
                        await this.options.receive(data, current);
                        if (current() && !this.stopped && data.type !== 'ready') {
                            this.post({ type: 'frame', recipients: [...this.welcomed], data });
                        }
                    });
                    this.incoming = delivery.catch(() => {});
                    return delivery;
                },
                onState: state => {
                    if (this.stopped) return;
                    if (state !== 'online') {
                        this.generation++;
                        this.incoming = Promise.resolve();
                        this.welcomed.clear();
                        this.post({ type: 'state', state });
                    }
                    this.setState(state);
                    if (state === 'online') for (const member of this.members) this.welcome(member);
                },
                onClose: async (event, authenticated) => {
                    this.post({ type: 'closed', code: event.code, authenticated });
                    await this.options.onClose(event, authenticated);
                },
                onError: error => {
                    this.post({ type: 'error', code: error.code, message: error.message });
                    this.options.onError?.(error);
                }
            });
            this.transport.connect();
            await new Promise(resolve => { this.release = resolve; if (this.stopped) resolve(); });
            this.transport.close();
            this.transport = null;
            this.isLeader = false;
        }).catch(error => { if (!this.stopped && error.name !== 'AbortError') this.options.onError?.(error); });
    }

    welcome(member) {
        const generation = this.generation;
        this.incoming = this.incoming.then(() => {
            if (this.stopped || generation !== this.generation || !this.isLeader || this.state !== 'online' || !this.members.has(member) || this.welcomed.has(member)) return;
            this.post({ type: 'welcome', recipient: member, data: this.options.snapshot() });
            this.welcomed.add(member);
        }).catch(error => this.options.onError?.(error));
    }

    message(event) {
        if (this.stopped || event.sender === this.id) return;
        if (event.type === 'hello') {
            if (this.isLeader) { this.members.add(event.sender); this.welcome(event.sender); }
            return;
        }
        if (event.type === 'bye') { this.members.delete(event.sender); this.welcomed.delete(event.sender); return; }
        if (this.isLeader) {
            if (event.owner !== this.id || !this.welcomed.has(event.sender)) return;
            if (event.type === 'send' && this.transport?.socket?.readyState === WebSocket.OPEN) this.transport.socket.send(event.data);
            if (event.type === 'reconnect') this.transport?.socket?.close();
            return;
        }
        if (event.type === 'owner') {
            this.owner = event.sender;
            this.generation++;
            this.incoming = Promise.resolve();
            this.joined = false;
            this.setState('connecting');
            this.post({ type: 'hello' });
            return;
        }
        if (event.type === 'welcome' && event.recipient === this.id) {
            this.owner = event.sender;
            this.joined = true;
            this.generation++;
            this.incoming = Promise.resolve();
        } else if (event.sender !== this.owner) return;
        if (event.type === 'state') {
            this.generation++;
            this.incoming = Promise.resolve();
            this.joined = false;
            this.setState(event.state);
            return;
        }
        if (event.type === 'closed') {
            Promise.resolve(this.options.onClose({ code: event.code }, event.authenticated)).catch(error => this.options.onError?.(error));
            return;
        }
        if (event.type === 'error') { this.options.onError?.(Object.assign(new Error(event.message), { code: event.code })); return; }
        if (!this.joined || !['welcome', 'frame'].includes(event.type) || event.type === 'frame' && !event.recipients.includes(this.id)) return;
        const generation = this.generation;
        const current = () => !this.stopped && !this.isLeader && generation === this.generation;
        this.incoming = this.incoming.then(async () => {
            if (!current()) return;
            await this.options.receive(event.data, current);
            if (current() && event.type === 'welcome') this.setState('online');
        }).catch(error => {
            if (!current()) return;
            this.options.onError?.(error);
            this.joined = false;
            this.setState('offline');
            this.post({ type: 'bye' });
            clearTimeout(this.retryTimer);
            this.retryTimer = setTimeout(() => this.post({ type: 'hello' }), 1000);
        });
    }

    close() {
        if (this.stopped) return;
        this.stopped = true;
        this.generation++;
        this.post({ type: 'bye' });
        clearTimeout(this.retryTimer);
        this.election?.abort();
        this.transport?.close();
        this.release?.();
        this.channel?.close();
        this.channel = null;
        this.setState('offline');
    }
}
