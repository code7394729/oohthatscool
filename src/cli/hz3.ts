#!/usr/bin/env node
/**
 * hz3.ts — the command line for the simulator.
 *
 * Drives the same WASM module the browser loads, through the same wrapper
 * (core/sim.ts) and the same rendering code (core/render-text.ts). So
 * everything above the WASM boundary can be exercised, demonstrated and
 * debugged from a terminal, and the browser only ever has to add pixels.
 *
 *   node dist/cli/hz3.js run      --bin prog.bin [--cycles N] [--break 0x...]
 *   node dist/cli/hz3.js step     --bin prog.bin [--instructions N] [--cycles N]
 *   node dist/cli/hz3.js trace    --bin prog.bin --out trace.jsonl [--cycles N]
 *   node dist/cli/hz3.js timeline (--bin prog.bin | --trace f.jsonl) [--cycles N]
 *   node dist/cli/hz3.js blink    (--bin prog.bin | --trace f.jsonl) [--reg N]
 *   node dist/cli/hz3.js example  <id>   run one of the browser's demo programs
 */

import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';

import { activeBlinks, BlinkTracker } from '../core/blink.js';
import { ABI_NAMES, hex32 } from '../core/decode.js';
import { renderFrame, renderTimeline } from '../core/render-text.js';
import { createSim, type Hz3Sim } from '../core/sim.js';
import type { Snapshot } from '../core/snapshot.js';
import { parseTrace, validateTrace, writeEvents } from '../core/trace.js';
import { examples, findExample } from '../viz/programs.js';

const USAGE = `usage: hz3 <command> [options]

commands:
  run        run a program to completion and report
  step       single-step, printing the pipeline each cycle or instruction
  trace      record a JSONL snapshot trace
  timeline   print the reservation table (instructions x cycles)
  blink      list register write events, including same-value rewrites
  example    list, or run, one of the browser's built-in demo programs

options:
  --bin PATH          flat binary to load at the reset vector
  --example ID        use a built-in demo program instead of --bin
  --trace PATH        read a recorded trace instead of simulating
  --out PATH          where to write (trace)
  --cycles N          cycle budget (default 100000, or 60 for step/timeline)
  --instructions N    number of instructions to step (step)
  --break ADDR        stop when this PC reaches execute (run)
  --reg N|NAME        restrict to one register (blink)
  --numeric           use x0..x31 instead of ABI register names
`;

interface Options {
	_: string[];
	[key: string]: string | string[] | boolean | undefined;
}

function parseArgs(argv: string[]): Options {
	const opts: Options = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (!a.startsWith('--')) { opts._.push(a); continue; }
		const key = a.slice(2);
		if (key === 'numeric' || key === 'help') { opts[key] = true; continue; }
		opts[key] = argv[++i];
	}
	return opts;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
// Number() already understands 0x..., which is how PCs get typed.
const num = (v: unknown, dflt: number): number => (typeof v === 'string' ? Number(v) : dflt);

function regIndex(spec: string | undefined): number | null {
	if (spec === undefined) return null;
	if (/^\d+$/.test(spec)) return Number(spec);
	if (/^x\d+$/.test(spec)) return Number(spec.slice(1));
	const i = ABI_NAMES.indexOf(spec);
	if (i < 0) throw new Error(`unknown register '${spec}'`);
	return i;
}

async function programBytes(opts: Options): Promise<Uint8Array> {
	const exampleId = str(opts['example']) ?? (str(opts['bin']) ? undefined : str(opts._[1]));
	if (exampleId) {
		const example = findExample(exampleId);
		if (!example) throw new Error(`unknown example '${exampleId}' (try: hz3 example)`);
		return example.build().bytes;
	}
	const bin = str(opts['bin']);
	if (!bin) throw new Error('--bin or --example is required');
	return new Uint8Array(await readFile(bin));
}

async function loadSim(opts: Options): Promise<Hz3Sim> {
	const bytes = await programBytes(opts);
	const sim = await createSim();
	sim.loadProgram(bytes);
	sim.reset();
	return sim;
}

/** Collect a snapshot per cycle, either by simulating or by reading a file. */
async function collect(opts: Options, defaultCycles: number):
Promise<{ snaps: Snapshot[]; sim: Hz3Sim | null }> {
	const tracePath = str(opts['trace']);
	if (tracePath) {
		const snaps = parseTrace(await readFile(tracePath, 'utf8'));
		const problems = validateTrace(snaps);
		if (problems.length) {
			console.error('trace problems:');
			for (const p of problems.slice(0, 10)) console.error('  ' + p);
		}
		return { snaps, sim: null };
	}
	const sim = await loadSim(opts);
	const budget = num(opts['cycles'], defaultCycles);
	const snaps: Snapshot[] = [];
	for (let i = 0; i < budget && !sim.exited; i++) {
		sim.stepCycle();
		snaps.push(sim.snapshot());
	}
	return { snaps, sim };
}

// ---------------------------------------------------------------------------

async function cmdRun(opts: Options): Promise<number> {
	const sim = await loadSim(opts);
	const breakArg = str(opts['break']);
	const breakPC = breakArg === undefined ? sim.map.noBreak : Number(breakArg);
	const res = sim.run(num(opts['cycles'], 100000), breakPC);

	const out = sim.drainOutput();
	if (out) process.stdout.write(out);

	const fault = sim.fault();
	if (fault) console.error(`\n[fault] ${fault.kind}: ${fault.message} (${fault.file}:${fault.line})`);

	console.error(`\n[hz3] stopped: ${res.reason} after ${res.cycles} cycles, ` +
		`${res.retired} instructions retired`);

	const { exited, exitCode } = sim;
	if (exited) console.error(`[hz3] exit code ${exitCode}`);
	sim.dispose();
	return exited && exitCode !== 0 ? 1 : 0;
}

async function cmdStep(opts: Options): Promise<number> {
	const sim = await loadSim(opts);
	const abi = !opts['numeric'];
	const blink = new BlinkTracker();

	const byInstruction = opts['instructions'] !== undefined;
	const count = byInstruction ? num(opts['instructions'], 10) : num(opts['cycles'], 20);

	for (let i = 0; i < count && !sim.exited; i++) {
		if (byInstruction) sim.stepInstruction();
		else sim.stepCycle();

		const snap = sim.snapshot();
		const blinks = blink.update(snap);
		console.log(renderFrame(snap, blinks, { abi }));

		// Only registers actually written since the previous frame; the decay
		// tail is a rendering effect, not news.
		const written = activeBlinks(blinks).filter((b) => b.writesDelta > 0);
		if (written.length)
			console.log('  updated: ' + written
				.map((b) => `${ABI_NAMES[b.index]}=${hex32(b.value)} (write #${b.writes})`)
				.join(', '));
		console.log('');
	}

	const out = sim.drainOutput();
	if (out) process.stdout.write(`program output: ${JSON.stringify(out)}\n`);
	sim.dispose();
	return 0;
}

async function cmdTrace(opts: Options): Promise<number> {
	const out = str(opts['out']);
	if (!out) throw new Error('--out is required');
	const sim = await loadSim(opts);
	const budget = num(opts['cycles'], 100000);

	const lines: string[] = [];
	for (let i = 0; i < budget && !sim.exited; i++) {
		sim.stepCycle();
		lines.push(sim.snapshotJson());
	}
	await writeFile(out, lines.join('\n') + '\n');
	console.error(`[hz3] wrote ${lines.length} snapshots to ${out}`);
	sim.dispose();
	return 0;
}

async function cmdTimeline(opts: Options): Promise<number> {
	const { snaps, sim } = await collect(opts, 60);
	console.log(renderTimeline(snaps, { abi: !opts['numeric'] }));
	sim?.dispose();
	return 0;
}

async function cmdBlink(opts: Options): Promise<number> {
	const { snaps, sim } = await collect(opts, 200);
	const only = regIndex(str(opts['reg']));

	console.log('Register writes, taken from the core write strobe. A row with an');
	console.log('unchanged value is a real write that a value diff would have missed.\n');

	let total = 0, sameValue = 0;
	for (let r = 1; r < 32; r++) {
		if (only !== null && r !== only) continue;
		const events = writeEvents(snaps, r);
		if (!events.length) continue;
		let prevValue = 0;
		const marks = events.map((e) => {
			const same = e.value === prevValue;
			prevValue = e.value;
			if (same) sameValue++;
			return `c${e.cycle}=${hex32(e.value)}${same ? ' (unchanged)' : ''}`;
		});
		total += events.length;
		console.log(`${ABI_NAMES[r]!.padStart(5)}  ${events.length} writes: ${marks.join('  ')}`);
	}
	console.log(`\n${total} writes total, ${sameValue} of which left the value unchanged.`);
	sim?.dispose();
	return 0;
}

async function cmdExample(opts: Options): Promise<number> {
	const id = str(opts._[1]);
	if (!id) {
		console.log('Built-in demo programs (also the browser\'s example menu):\n');
		for (const e of examples)
			console.log(`  ${e.id.padEnd(12)} ${e.name} — ${e.blurb}`);
		console.log('\nRun one with:  hz3 step --example <id> --cycles 20');
		return 0;
	}
	const example = findExample(id);
	if (!example) { console.error(`unknown example '${id}'`); return 2; }
	console.log(`${example.name}: ${example.watch}\n`);
	return cmdStep({ ...opts, example: id, cycles: str(opts['cycles']) ?? '24' });
}

// ---------------------------------------------------------------------------

const COMMANDS: Record<string, (o: Options) => Promise<number>> = {
	run: cmdRun, step: cmdStep, trace: cmdTrace,
	timeline: cmdTimeline, blink: cmdBlink, example: cmdExample,
};

async function main(): Promise<number> {
	const opts = parseArgs(process.argv.slice(2));
	const cmd = str(opts._[0]);
	if (opts['help'] || !cmd || !COMMANDS[cmd]) {
		process.stdout.write(USAGE);
		return cmd && !COMMANDS[cmd] ? 2 : 0;
	}
	return COMMANDS[cmd]!(opts);
}

main().then(
	(code) => process.exit(code ?? 0),
	(err: unknown) => {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`hz3: ${msg}`);
		if (msg.includes('Cannot find module') || msg.includes('ERR_MODULE_NOT_FOUND'))
			console.error('hint: build the WASM module first — ./scripts/build-wasm-lib.sh');
		process.exit(2);
	},
);
