const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

function collectFiles(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const entryPath = path.join(directory, entry.name);
        return entry.isDirectory() ? collectFiles(entryPath) : [entryPath];
    });
}

function createBuildMetadata(rootDirectory) {
    const staticDirectory = path.join(rootDirectory, 'static');
    const hash = crypto.createHash('sha256');

    collectFiles(staticDirectory)
        .filter((file) => !file.endsWith('sitemap.xml'))
        .sort()
        .forEach((file) => {
            hash.update(path.relative(staticDirectory, file));
            hash.update(fs.readFileSync(file));
        });

    const sourceStatus = spawnSync(
        'git',
        ['diff', '--quiet', 'HEAD', '--', 'src', 'static'],
        { cwd: rootDirectory }
    );
    if (![0, 1].includes(sourceStatus.status)) {
        throw sourceStatus.error || new Error('Unable to inspect source changes');
    }

    const lastModified = sourceStatus.status === 1
        ? new Intl.DateTimeFormat('en-CA').format(new Date())
        : execFileSync(
            'git',
            ['log', '-1', '--format=%cs', '--', 'src', 'static'],
            { cwd: rootDirectory, encoding: 'utf8' }
        ).trim();

    return {
        assetVersion: hash.digest('hex').slice(0, 12),
        lastModified,
    };
}

module.exports = { createBuildMetadata };
