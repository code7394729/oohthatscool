/**
 * dev.ts — the development server.
 *
 * A static file server over the repository root, plus a live-reload channel.
 * That is all it needs to be: there is no bundler in this project, so the
 * browser loads exactly the files `tsc` emitted, and "the thing the server
 * serves" and "the thing on disk" are the same thing. Debugging a module means
 * reading it, not reading a bundle.
 *
 * Serving the repository root rather than a staging directory is deliberate:
 * `dist/viz/app.js` imports `../../build/wasm/hz3.mjs`, and that relative path
 * has to mean the same thing to Node and to the browser. It does, if the root
 * is the root.
 *
 *   node dist/server/dev.js [--port 8080] [--watch] [--host 0.0.0.0]
 *
 * --watch additionally runs `tsc -b --watch` as a child process, so one command
 * gives you a compiler and a server.
 */

import { spawn } from 'node:child_process';
import { createReadStream, existsSync, statSync, watch } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));

const MIME: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.cjs': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.map': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.ico': 'image/x-icon',
	'.woff2': 'font/woff2',
	// The one that actually matters: a wasm file served as anything else makes
	// instantiateStreaming refuse it, with an error that does not say so.
	'.wasm': 'application/wasm',
	'.bin': 'application/octet-stream',
	'.ts': 'text/plain; charset=utf-8',
	'.vh': 'text/plain; charset=utf-8',
	'.v': 'text/plain; charset=utf-8',
};

/** Directories the browser is allowed to reach. Everything else is 403. */
const ALLOWED_PREFIXES = ['web', 'dist', 'build', 'programs', 'docs'];

interface Options {
	port: number;
	host: string;
	watch: boolean;
}

function parseArgs(argv: string[]): Options {
	const opts: Options = { port: 8080, host: '127.0.0.1', watch: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--port' && argv[i + 1]) opts.port = Number(argv[++i]);
		else if (a === '--host' && argv[i + 1]) opts.host = argv[++i]!;
		else if (a === '--watch') opts.watch = true;
		else if (a === '--help') {
			process.stdout.write(
				'usage: node dist/server/dev.js [--port 8080] [--host 127.0.0.1] [--watch]\n');
			process.exit(0);
		}
	}
	return opts;
}

// ---------------------------------------------------------------------------
// Live reload
//
// One SSE stream per page. The server watches the directories the page loads
// from and pushes a line; the client reloads. No websocket library, no polling,
// about fifteen lines on each side.

const clients = new Set<ServerResponse>();
let reloadTimer: NodeJS.Timeout | null = null;

function notifyReload(what: string): void {
	// Coalesce: tsc writes many files per build, and each one fires an event.
	if (reloadTimer) clearTimeout(reloadTimer);
	reloadTimer = setTimeout(() => {
		reloadTimer = null;
		if (clients.size) console.log(`  reload (${what}) -> ${clients.size} client(s)`);
		for (const res of clients) res.write(`data: reload\n\n`);
	}, 120);
}

function startWatching(): void {
	for (const dir of ['dist', 'web']) {
		const path = join(ROOT, dir);
		if (!existsSync(path)) continue;
		try {
			watch(path, { recursive: true }, (_event, filename) => {
				// .map and .d.ts churn on every build and change nothing visible.
				if (filename && /\.(d\.ts|map|tsbuildinfo)$/.test(filename)) return;
				notifyReload(`${dir}/${filename ?? ''}`);
			});
		} catch {
			console.warn(`  (cannot watch ${dir}; live reload disabled for it)`);
		}
	}
}

// ---------------------------------------------------------------------------
// Static serving

function resolveRequestPath(urlPath: string): string | null {
	let rel = decodeURIComponent(urlPath.split('?')[0] ?? '/');
	if (rel === '/') rel = '/web/index.html';
	if (rel.endsWith('/')) rel += 'index.html';

	const abs = normalize(join(ROOT, rel));
	// Refuse anything that escaped the root, and anything outside the handful of
	// directories the page has business reading.
	const relToRoot = relative(ROOT, abs);
	if (relToRoot.startsWith('..') || relToRoot.startsWith(sep)) return null;
	const top = relToRoot.split(sep)[0] ?? '';
	if (!ALLOWED_PREFIXES.includes(top)) return null;
	return abs;
}

function serve(req: IncomingMessage, res: ServerResponse): void {
	const url = req.url ?? '/';

	if (url.startsWith('/__dev/reload')) {
		res.writeHead(200, {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache',
			connection: 'keep-alive',
		});
		res.write('retry: 1000\n\n');
		clients.add(res);
		req.on('close', () => clients.delete(res));
		return;
	}

	const path = resolveRequestPath(url);
	if (!path) {
		res.writeHead(403, { 'content-type': 'text/plain' });
		res.end('forbidden\n');
		return;
	}

	if (!existsSync(path) || !statSync(path).isFile()) {
		res.writeHead(404, { 'content-type': 'text/plain' });
		res.end(`not found: ${url}\n` +
			(url.includes('/build/wasm/')
				? '\nThe WASM module is not built. Run ./scripts/build-wasm-lib.sh\n'
				: url.includes('/dist/')
					? '\nThe TypeScript is not built. Run npm run build\n'
					: ''));
		return;
	}

	res.writeHead(200, {
		'content-type': MIME[extname(path)] ?? 'application/octet-stream',
		// Dev server: never cache, or an edit takes a hard refresh to show up.
		'cache-control': 'no-store',
	});
	createReadStream(path).pipe(res);
}

// ---------------------------------------------------------------------------

function main(): void {
	const opts = parseArgs(process.argv.slice(2));

	if (opts.watch) {
		const tsc = spawn('npx', ['tsc', '-b', '--watch', '--preserveWatchOutput'], {
			cwd: ROOT, stdio: 'inherit',
		});
		process.on('exit', () => tsc.kill());
		process.on('SIGINT', () => { tsc.kill(); process.exit(0); });
	}

	startWatching();

	const server = createServer(serve);
	server.listen(opts.port, opts.host, () => {
		const url = `http://${opts.host}:${opts.port}/`;
		console.log(`hazard3 visualizer dev server`);
		console.log(`  serving ${ROOT}`);
		console.log(`  ${url}`);
		if (!existsSync(join(ROOT, 'build/wasm/hz3.mjs')))
			console.log('  ! build/wasm/hz3.mjs missing — run ./scripts/build-wasm-lib.sh');
		if (!existsSync(join(ROOT, 'dist/viz/app.js')))
			console.log('  ! dist/viz/app.js missing — run npm run build');
	});
}

main();
