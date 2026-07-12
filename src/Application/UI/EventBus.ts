type UIEventCallback = (data: any) => any;

const listeners = new Map<string, Map<UIEventCallback, EventListener>>();

const UIEventBus = {
    on(event: string, callback: UIEventCallback) {
        const listener = ((customEvent: CustomEvent) => {
            callback(customEvent.detail);
        }) as EventListener;
        const eventListeners = listeners.get(event) || new Map();
        eventListeners.set(callback, listener);
        listeners.set(event, eventListeners);
        document.addEventListener(event, listener);

        return () => UIEventBus.remove(event, callback);
    },
    dispatch(event: string, data: any) {
        document.dispatchEvent(new CustomEvent(event, { detail: data }));
    },
    remove(event: string, callback: UIEventCallback) {
        const eventListeners = listeners.get(event);
        const listener = eventListeners?.get(callback);
        if (!listener) return;

        document.removeEventListener(event, listener);
        eventListeners?.delete(callback);
        if (eventListeners?.size === 0) listeners.delete(event);
    },
};

export default UIEventBus;
