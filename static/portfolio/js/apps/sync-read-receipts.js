let database;
const change = async (session, update) => {
    database ||= new Promise((resolve, reject) => {
        const request = indexedDB.open('gavin-sync-read-receipts', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('receipts', { keyPath: 'scope' });
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    }).catch(error => { database = null; throw error; });
    const db = await database;
    const scope = `${session.roomId}:${session.deviceId}`;
    return new Promise((resolve, reject) => {
        const transaction = db.transaction('receipts', update ? 'readwrite' : 'readonly');
        const store = transaction.objectStore('receipts');
        const request = store.get(scope);
        let pending = 0;
        request.onsuccess = () => {
            const previous = request.result;
            const receipt = { scope, readId: 0, confirmedId: 0, ...previous };
            if (update?.(receipt) === false) store.delete(scope);
            else {
                if (update && (receipt.readId !== previous?.readId || receipt.confirmedId !== previous?.confirmedId)) store.put(receipt);
                pending = receipt.readId > receipt.confirmedId ? receipt.readId : 0;
            }
        };
        transaction.oncomplete = () => resolve(pending);
        transaction.onerror = transaction.onabort = () => reject(transaction.error);
    });
};

export const pendingReads = {
    load: session => change(session),
    save: (session, messageId) => change(session, receipt => { receipt.readId = Math.max(receipt.readId, messageId); }),
    confirm: (session, messageId) => change(session, receipt => { receipt.confirmedId = Math.max(receipt.confirmedId, messageId); }),
    clear: session => change(session, () => false)
};
