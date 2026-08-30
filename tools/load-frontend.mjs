/**
 * Compile Millennium-free frontend modules to CommonJS and require them.
 *
 * Node cannot import the frontend's extensionless TS imports directly, so the
 * named modules (and everything they import) are compiled into a temp dir and
 * required from there. The compilable subgraph is deliberately free of
 * Millennium imports; if that changes, this fails loudly.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Each name is a path under frontend/ without the .ts extension
 * ('notification', 'choose'); it is both a tsc entry file and a
 * key in the returned { name: module } map. rootDir is pinned so output
 * paths mirror frontend/ no matter which entries are compiled.
 */
export function loadFrontendModules(names) {
	const tmp = mkdtempSync(join(tmpdir(), 'snn-frontend-'));
	try {
		execFileSync(
			join(root, 'node_modules', '.bin', 'tsc'),
			[
				...names.map((name) => join(root, 'frontend', `${name}.ts`)),
				'--module', 'commonjs', '--target', 'es2022', '--skipLibCheck',
				'--rootDir', join(root, 'frontend'),
				'--outDir', tmp,
			],
			{ stdio: 'inherit' },
		);
		writeFileSync(join(tmp, 'package.json'), '{"type":"commonjs"}\n');
		const req = createRequire(import.meta.url);
		const modules = {};
		for (const name of names) modules[name] = req(join(tmp, `${name}.js`));
		return modules;
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}
