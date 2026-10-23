import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { verifyRelease } from './verify-release.mjs';

const directory = fileURLToPath(new URL('../', import.meta.url));
const root = fileURLToPath(new URL('../../../', import.meta.url));
try {
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim();
  assert.equal(status, '', 'Commit the release changes before deploying so the reported revision identifies the deployed code.');
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const config = JSON.parse(await readFile(new URL('../../../static/portfolio/sync-config.json', import.meta.url), 'utf8'));
  assert.equal(new URL(config.apiBase).protocol, 'https:', 'Deployments require the production HTTPS API address.');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  for (const args of [['test'], ['run', 'check']]) execFileSync(npm, args, { cwd: directory, stdio: 'inherit' });
  const wrangler = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
  execFileSync(process.execPath, [wrangler, 'whoami'], { cwd: directory, stdio: 'inherit' });
  execFileSync(process.execPath, [wrangler, 'deploy', '--var', `RELEASE_REVISION:${revision}`], { cwd: directory, stdio: 'inherit' });
  const health = await verifyRelease({ expectedRevision: revision, apiBase: config.apiBase, backendOnly: true });
  console.log(`Worker verified: ${health.revision} (Cloudflare ${health.versionId}). Verify the frontend after publishing Pages with npm run verify:release -- ${revision} from the repository root.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
