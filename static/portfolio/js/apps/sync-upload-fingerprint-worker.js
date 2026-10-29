import { sha256 } from '@noble/hashes/sha2.js';

self.onmessage = async ({ data: file }) => {
    try {
        const digest = sha256.create();
        let reported = -1;
        for (let offset = 0; offset < file.size; offset += 8 * 1024 * 1024) {
            digest.update(new Uint8Array(await file.slice(offset, offset + 8 * 1024 * 1024).arrayBuffer()));
            const progress = Math.floor(Math.min(file.size, offset + 8 * 1024 * 1024) / file.size * 100);
            if (progress !== reported) { self.postMessage({ progress }); reported = progress; }
        }
        self.postMessage({ fingerprint: Array.from(digest.digest(), (byte) => byte.toString(16).padStart(2, '0')).join('') });
    } catch (error) { self.postMessage({ error: error.message }); }
};
