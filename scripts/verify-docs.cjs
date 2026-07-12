const { execFileSync } = require('child_process');

const changes = execFileSync('git', ['status', '--porcelain', '--', 'docs'], {
    encoding: 'utf8',
}).trim();

if (changes) {
    console.error('docs/ is not synchronized with the production build:');
    console.error(changes);
    process.exit(1);
}

console.log('docs/ matches the production build.');
