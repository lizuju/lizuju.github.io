import mammoth from 'mammoth/mammoth.browser';

self.onmessage = async ({ data: arrayBuffer }) => {
    try {
        const { value } = await mammoth.convertToHtml({ arrayBuffer }, { externalFileAccess: false });
        const chunks = [];
        let depth = 0;
        let start = 0;
        let elements = 0;
        // Mammoth escapes text/attributes and emits balanced tags with self-closing void elements.
        // Split only between top-level elements so lists and tables remain intact.
        for (const match of value.matchAll(/<\/?[a-z][^>]*>/gi)) {
            if (match[0].startsWith('</')) depth--;
            else if (!match[0].endsWith('/>')) depth++;
            if (depth === 0 && ++elements >= 50) {
                const end = match.index + match[0].length;
                chunks.push(value.slice(start, end));
                start = end;
                elements = 0;
            }
        }
        if (start < value.length) chunks.push(value.slice(start));
        self.postMessage({ chunks });
    } catch {
        self.postMessage({ error: 'Word preview could not be loaded' });
    }
};
