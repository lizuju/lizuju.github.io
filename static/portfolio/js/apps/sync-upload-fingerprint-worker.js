self.onmessage = async ({ data: file }) => {
    try {
        const sampleSize = 64 * 1024;
        const offsets = [...new Set([0, Math.max(0, Math.floor((file.size - sampleSize) / 2)), Math.max(0, file.size - sampleSize)])];
        const samples = await Promise.all(offsets.map((offset) => file.slice(offset, offset + sampleSize).arrayBuffer()));
        const size = new TextEncoder().encode(`${file.size}:`);
        const bytes = new Uint8Array(size.length + samples.reduce((total, sample) => total + sample.byteLength, 0));
        bytes.set(size);
        let offset = size.length;
        for (const sample of samples) { bytes.set(new Uint8Array(sample), offset); offset += sample.byteLength; }
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        self.postMessage({ fingerprint: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('') });
    } catch (error) { self.postMessage({ error: error.message }); }
};
