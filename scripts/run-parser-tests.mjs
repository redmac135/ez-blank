import { rm, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { build } from 'esbuild';
import { readdir } from 'node:fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = resolve(__dirname, '..');
const outdir = resolve(root, '.test-dist');
const testsDir = resolve(root, 'tests');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

const testEntries = (await readdir(testsDir))
	.filter((name) => name.endsWith('.test.ts'))
	.sort()
	.map((name) => ({
		entry: resolve(testsDir, name),
		outfile: resolve(outdir, name.replace(/\.ts$/, '.mjs'))
	}));

for (const testEntry of testEntries) {
	await build({
		entryPoints: [testEntry.entry],
		outfile: testEntry.outfile,
		bundle: true,
		format: 'esm',
		platform: 'node',
		target: 'node20',
		sourcemap: 'inline'
	});
}

await new Promise((resolvePromise, rejectPromise) => {
	const child = spawn(
		process.execPath,
		['--test', ...testEntries.map((testEntry) => testEntry.outfile)],
		{
		cwd: root,
		stdio: 'inherit'
		}
	);

	child.on('exit', (code) => {
		if (code === 0) {
			resolvePromise(undefined);
			return;
		}

		rejectPromise(new Error(`Parser tests failed with exit code ${code ?? 'unknown'}`));
	});

	child.on('error', rejectPromise);
});
