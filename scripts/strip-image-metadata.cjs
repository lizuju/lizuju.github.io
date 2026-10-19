const fs = require('fs');
const path = require('path');

// Removes camera, location, and editing metadata from published images without
// re-encoding pixels. ICC color profiles are kept so colors render unchanged.
// Usage: node scripts/strip-image-metadata.cjs [--check] [directory...]

const rootDirectory = path.resolve(__dirname, '..');
const defaultDirectories = ['static', 'docs'];
const imagePattern = /\.(jpe?g|png|webp)$/i;

const JPEG_STRIPPED_APP_MARKERS = new Set([
    0xe1, // APP1: Exif, XMP
    0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xeb, 0xec, 0xef,
    0xed, // APP13: IPTC / Photoshop
]);
const JPEG_COMMENT_MARKER = 0xfe;
const PNG_METADATA_CHUNKS = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);
const WEBP_METADATA_CHUNKS = new Set(['EXIF', 'XMP ']);
const WEBP_EXIF_FLAG = 0x08;
const WEBP_XMP_FLAG = 0x04;

function collectImages(directory) {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) return collectImages(entryPath);
        return imagePattern.test(entry.name) ? [entryPath] : [];
    });
}

function detectFormat(buffer) {
    if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'jpeg';
    if (buffer.toString('latin1', 1, 4) === 'PNG') return 'png';
    if (buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') {
        return 'webp';
    }
    return null;
}

function readExifOrientation(segment) {
    if (segment.toString('latin1', 0, 6) !== 'Exif\0\0') return null;
    const tiff = segment.subarray(6);
    const littleEndian = tiff.toString('latin1', 0, 2) === 'II';
    const readUInt16 = (offset) => (littleEndian ? tiff.readUInt16LE(offset) : tiff.readUInt16BE(offset));
    const readUInt32 = (offset) => (littleEndian ? tiff.readUInt32LE(offset) : tiff.readUInt32BE(offset));
    const ifdOffset = readUInt32(4);
    const entryCount = readUInt16(ifdOffset);
    for (let index = 0; index < entryCount; index += 1) {
        const entryOffset = ifdOffset + 2 + index * 12;
        if (readUInt16(entryOffset) === 0x0112) return readUInt16(entryOffset + 8);
    }
    return null;
}

function isStrippedJpegSegment(marker, payload) {
    if (marker === JPEG_COMMENT_MARKER || JPEG_STRIPPED_APP_MARKERS.has(marker)) return true;
    // APP2 carries both ICC profiles (kept) and MPF multi-picture indexes (removed).
    return marker === 0xe2 && payload.toString('latin1', 0, 4) === 'MPF\0';
}

function stripJpeg(buffer, file) {
    const kept = [buffer.subarray(0, 2)];
    const findings = [];
    let offset = 2;

    while (offset < buffer.length) {
        if (buffer[offset] !== 0xff) throw new Error(`${file}: invalid JPEG marker at byte ${offset}`);
        const marker = buffer[offset + 1];
        if (marker === 0xff) {
            offset += 1;
            continue;
        }

        if (marker === 0xda) {
            const endOfImage = buffer.indexOf(Buffer.from([0xff, 0xd9]), offset);
            if (endOfImage === -1) throw new Error(`${file}: missing JPEG end-of-image marker`);
            kept.push(buffer.subarray(offset, endOfImage + 2));
            if (endOfImage + 2 < buffer.length) findings.push('data after end-of-image');
            break;
        }

        const length = buffer.readUInt16BE(offset + 2);
        const segment = buffer.subarray(offset, offset + 2 + length);
        const payload = segment.subarray(4);

        if (isStrippedJpegSegment(marker, payload)) {
            const orientation = marker === 0xe1 ? readExifOrientation(payload) : null;
            if (orientation && orientation !== 1) {
                throw new Error(`${file}: EXIF orientation ${orientation} must be applied to pixels before stripping`);
            }
            const label = payload.toString('latin1', 0, 4).replace(/\0/g, '') || `0x${marker.toString(16)}`;
            findings.push(marker === JPEG_COMMENT_MARKER ? 'comment' : `APP${marker - 0xe0} ${label}`);
        } else {
            kept.push(segment);
        }
        offset += 2 + length;
    }

    return { output: Buffer.concat(kept), findings };
}

function stripPng(buffer) {
    const kept = [buffer.subarray(0, 8)];
    const findings = [];
    let offset = 8;

    while (offset < buffer.length) {
        const length = buffer.readUInt32BE(offset);
        const type = buffer.toString('latin1', offset + 4, offset + 8);
        const chunk = buffer.subarray(offset, offset + 12 + length);
        if (PNG_METADATA_CHUNKS.has(type)) findings.push(type);
        else kept.push(chunk);
        offset += 12 + length;
        if (type === 'IEND') {
            if (offset < buffer.length) findings.push('data after IEND');
            break;
        }
    }

    return { output: Buffer.concat(kept), findings };
}

function stripWebp(buffer) {
    const chunks = [];
    const findings = [];
    let offset = 12;

    while (offset + 8 <= buffer.length) {
        const type = buffer.toString('latin1', offset, offset + 4);
        const length = buffer.readUInt32LE(offset + 4);
        const paddedLength = length + (length % 2);
        const chunk = Buffer.from(buffer.subarray(offset, offset + 8 + paddedLength));
        if (WEBP_METADATA_CHUNKS.has(type)) findings.push(type.trim());
        else chunks.push(chunk);
        offset += 8 + paddedLength;
    }

    const extendedHeader = chunks.find((chunk) => chunk.toString('latin1', 0, 4) === 'VP8X');
    if (extendedHeader) extendedHeader[8] &= ~(WEBP_EXIF_FLAG | WEBP_XMP_FLAG);

    const body = Buffer.concat(chunks);
    const header = Buffer.alloc(12);
    header.write('RIFF', 0, 'latin1');
    header.writeUInt32LE(4 + body.length, 4);
    header.write('WEBP', 8, 'latin1');
    return { output: Buffer.concat([header, body]), findings };
}

const strippers = { jpeg: stripJpeg, png: stripPng, webp: stripWebp };

function main() {
    const args = process.argv.slice(2);
    const checkOnly = args.includes('--check');
    const directories = args.filter((arg) => arg !== '--check');
    const files = (directories.length ? directories : defaultDirectories)
        .flatMap((directory) => collectImages(path.resolve(rootDirectory, directory)))
        .sort();

    const affected = [];
    files.forEach((file) => {
        const buffer = fs.readFileSync(file);
        const format = detectFormat(buffer);
        if (!format) throw new Error(`${file}: unrecognized image format`);
        const { output, findings } = strippers[format](buffer, file);
        if (!findings.length) return;

        const relativePath = path.relative(rootDirectory, file);
        affected.push(relativePath);
        console.log(`${relativePath}: ${findings.join(', ')}`);
        if (!checkOnly) fs.writeFileSync(file, output);
    });

    if (checkOnly && affected.length) {
        console.error(`\n${affected.length} image(s) contain metadata. Run: npm run images:strip`);
        process.exit(1);
    }
    console.log(checkOnly
        ? `${files.length} images checked; no embedded metadata found.`
        : `${files.length} images scanned; metadata removed from ${affected.length}.`);
}

main();
