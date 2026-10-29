import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';

export async function workerFingerprint(directory = new URL('../', import.meta.url)) {
  const files = ['package.json', 'package-lock.json', 'wrangler.jsonc'];
  for (const name of await readdir(new URL('src/', directory), { recursive: true })) {
    if ((await stat(new URL(`src/${name}`, directory))).isFile()) files.push(`src/${name}`);
  }
  const hash = createHash('sha256');
  for (const file of files.sort()) hash.update(file).update('\0').update(await readFile(new URL(file, directory))).update('\0');
  return hash.digest('hex');
}
