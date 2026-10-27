export class SyncConnection {
    constructor({ session, getUrl, receive, onState, onClose, onError }) {
        this.session = session;
        this.getUrl = getUrl;
        this.receive = receive;
        this.onState = onState;
        this.onClose = onClose;
        this.onError = onError;
        this.socket = null;
        this.state = 'offline';
        this.authenticated = false;
        this.stopped = false;
        this.attempt = null;
        this.generation = 0;
        this.retryDelay = 1000;
        this.retryTimer = null;
    }

    connect() {
        if (this.stopped || this.attempt) return this.attempt?.opening;
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
        const attempt = { generation: ++this.generation, initialized: false, authenticated: false, awaitingPong: false };
        this.attempt = attempt;
        this.state = 'connecting';
        const current = () => !this.stopped && this.attempt === attempt;
        attempt.opening = (async () => {
            try {
                const url = await this.getUrl();
                if (!current()) return;
                const socket = new WebSocket(url, ['sync', `auth.${this.session.token}`]);
                attempt.socket = socket;
                this.socket = socket;
                this.authenticated = false;
                let incoming = Promise.resolve();
                attempt.deadline = setTimeout(() => {
                    this.disconnected(attempt, { code: 1006, reason: 'Connection initialization timed out' });
                }, 30000);
                socket.addEventListener('open', () => {
                    if (current()) socket.send(JSON.stringify({ type: 'auth', token: this.session.token }));
                });
                socket.addEventListener('message', event => {
                    if (!current()) return;
                    if (event.data === 'pong') { attempt.awaitingPong = false; return; }
                    let data;
                    try { data = JSON.parse(event.data); } catch { return; }
                    if (!data || typeof data.type !== 'string') return;
                    if (data.type === 'ready') {
                        attempt.authenticated = true;
                        this.authenticated = true;
                    }
                    incoming = incoming.then(async () => {
                        if (!current()) return;
                        await this.receive(data, current);
                        if (!current() || data.type !== 'ready') return;
                        attempt.initialized = true;
                        this.retryDelay = 1000;
                        clearTimeout(attempt.deadline);
                        clearInterval(attempt.pingTimer);
                        attempt.pingTimer = setInterval(() => {
                            if (!current()) return;
                            if (attempt.awaitingPong) {
                                this.disconnected(attempt, { code: 1006, reason: 'Connection heartbeat timed out' });
                            } else if (socket.readyState === WebSocket.OPEN) {
                                attempt.awaitingPong = true;
                                socket.send('ping');
                            }
                        }, 30000);
                        this.state = 'online';
                        this.onState(this.state);
                    }).catch(error => {
                        if (!current()) return;
                        this.onError?.(error);
                        if (!attempt.initialized) this.disconnected(attempt, { code: 1006, reason: 'Connection initialization failed' });
                    });
                });
                socket.addEventListener('close', event => { this.disconnected(attempt, event); });
                this.onState(this.state);
            } catch (error) {
                if (!current()) return;
                this.attempt = null;
                this.socket = null;
                this.authenticated = false;
                this.state = 'offline';
                this.onState(this.state);
                if (this.stopped || this.generation !== attempt.generation) return;
                this.onError?.(error);
                if (this.generation === attempt.generation) this.retry();
            }
        })();
        return attempt.opening;
    }

    async disconnected(attempt, event) {
        if (this.stopped || this.attempt !== attempt) return;
        clearTimeout(attempt.deadline);
        clearInterval(attempt.pingTimer);
        this.attempt = null;
        this.socket = null;
        this.authenticated = false;
        attempt.socket?.close();
        this.state = 'offline';
        this.onState(this.state);
        if (this.stopped || this.generation !== attempt.generation) return;
        try { await this.onClose(event, attempt.authenticated); }
        catch (error) { if (!this.stopped && this.generation === attempt.generation) this.onError?.(error); }
        if (!this.stopped && this.generation === attempt.generation) this.retry();
    }

    retry() {
        if (this.stopped || this.attempt) return;
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => this.connect(), this.retryDelay * (1 + Math.random() * 0.25));
        this.retryDelay = Math.min(this.retryDelay * 2, 30000);
    }

    close() {
        if (this.stopped) return;
        this.stopped = true;
        this.generation++;
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
        const attempt = this.attempt;
        this.attempt = null;
        clearTimeout(attempt?.deadline);
        clearInterval(attempt?.pingTimer);
        const socket = this.socket;
        this.socket = null;
        this.authenticated = false;
        socket?.close();
        this.state = 'offline';
        this.onState(this.state);
    }
}
