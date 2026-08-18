#!/usr/bin/env node
/**
 * hz3.mjs — the JavaScript-side command line for the simulator.
 *
 * Drives the same WASM module the browser will load, through the same wrapper
 * (js/src/sim.mjs) and the same rendering code (js/src/render-text.mjs). So
 * everything above the WASM boundary can be exercised, demonstrated and
 * debugged from a terminal, and the browser only ever has to add pixels.
 *
 *   node js/cli/hz3.mjs run      --bin prog.bin [--cycles N] [--break 0x...]
 *   node js/cli/hz3.mjs step     --bin prog.bin [--instructions N] [--cycles N]
 *   node js/cli/hz3.mjs trace    --bin prog.bin --out trace.jsonl [--cycles N]
 *   node js/cli/hz3.mjs timeline (--bin prog.bin | --trace f.jsonl) [--cycles N]
 *   node js/cli/hz3.mjs blink    (--bin prog.bin | --trace f.jsonl) [--reg N]
 */

import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';

import { BlinkTracker, activeBlinks } from '../src/blink.mjs';
import { ABI_NAMES, hex32 } from '../src/decode.mjs';
import { createSim } from '../src/sim.mjs';
import { parseTrace, validateTrace, writeEvents } from '../src/trace.mjs';
import { renderFrame, renderTimeline } from '../src/render-text.mjs';

const USAGE = `usage: hz3 <command> [options]

commands:
  run        run a program to completion and report
  step       single-step, printing the pipeline each cycle or instruction
  trace      record a JSONL snapshot trace
  timeline   print the reservation table (instructions x cycles)
  blink      list register write events, including same-value rewrites

options:
  --bin PATH          flat binary to load at the reset vector
  --trace PATH        read a recorded trace instead of simulating
  --out PATH          where to write (trace)
  --cycles N          cycle budget (default 100000, or 60 for step)
  --instructions N    number of instructions to step (step)
  --break ADDR        stop when this PC reaches execute (run)
  --reg N|NAME        restrict to one register (blink)
  --numeric           use x0..x31 instead of ABI register names
`;

function parseArgs(argv) {
	const opts = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith('--')) { opts._.push(a); continue; }
		const key = a.slice(2);
		if (key === 'numeric') { opts.numeric = true; continue; }
		if (key === 'help') { opts.help = true; continue; }
		opts[key] = argv[++i];
	}
	return opts;
}

// Number() already understands 0x..., which is how PCs get typed.
const num = (v, dflt) => (v === undefined ? dflt : Number(v));

function regIndex(spec) {
	if (spec === undefined) return null;
	if (/^\d+$/.test(spec)) return Number(spec);
	if (/^x\d+$/.test(spec)) return Number(spec.slice(1));
	const i = ABI_NAMES.indexOf(spec);
	if (i < 0) throw new Error(`unknown register '${spec}'`);
	return i;
}

async function loadSim(opts) {
	if (!opts.bin) throw new Error('--bin is required');
	const bytes = new Uint8Array(await readFile(opts.bin));
	const sim = await createSim();
	sim.loadProgram(bytes);
	sim.reset();
	return sim;
}

/** Collect a snapshot per cycle, either by simulating or by reading a file. */
async function collect(opts, defaultCycles) {
	if (opts.trace) {
		const snaps = parseTrace(await readFile(opts.trace, 'utf8'));
		const problems = validateTrace(snaps);
		if (problems.length) {
			console.error('trace problems:');
			for (const p of problems.slice(0, 10)) console.error('  ' + p);
		}
		return { snaps, sim: null };
	}
	const sim = await loadSim(opts);
	const budget = num(opts.cycles, defaultCycles);
	const snaps = [];
	for (let i = 0; i < budget && !sim.exited; i++) {
		sim.stepCycle();
		snaps.push(sim.snapshot());
	}
	return { snaps, sim };
}

// ---------------------------------------------------------------------------

async function cmdRun(opts) {
	const sim = await loadSim(opts);
	const breakPC = opts.break === undefined ? sim.map.noBreak : num(opts.break);
	const res = sim.run(num(opts.cycles, 100000), breakPC);

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

async function cmdStep(opts) {
	const sim = await loadSim(opts);
	const abi = !opts.numeric;
	const blink = new BlinkTracker();

	const byInstruction = opts.instructions !== undefined;
	const count = byInstruction ? num(opts.instructions, 10) : num(opts.cycles, 20);

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

async function cmdTrace(opts) {
	if (!opts.out) throw new Error('--out is required');
	const sim = await loadSim(opts);
	const budget = num(opts.cycles, 100000);

	const lines = [];
	for (let i = 0; i < budget && !sim.exited; i++) {
		sim.stepCycle();
		lines.push(sim.snapshotJson());
	}
	await writeFile(opts.out, lines.join('\n') + '\n');
	console.error(`[hz3] wrote ${lines.length} snapshots to ${opts.out}`);
	sim.dispose();
	return 0;
}

async function cmdTimeline(opts) {
	const { snaps, sim } = await collect(opts, 60);
	console.log(renderTimeline(snaps, { abi: !opts.numeric }));
	sim?.dispose();
	return 0;
}

async function cmdBlink(opts) {
	const { snaps, sim } = await collect(opts, 200);
	const only = regIndex(opts.reg);

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
		console.log(`${ABI_NAMES[r].padStart(5)}  ${events.length} writes: ${marks.join('  ')}`);
	}
	console.log(`\n${total} writes total, ${sameValue} of which left the value unchanged.`);
	sim?.dispose();
	return 0;
}

// ---------------------------------------------------------------------------

const COMMANDS = {
	run: cmdRun, step: cmdStep, trace: cmdTrace,
	timeline: cmdTimeline, blink: cmdBlink,
};

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	const cmd = opts._[0];
	if (opts.help || !cmd || !COMMANDS[cmd]) {
		process.stdout.write(USAGE);
		return cmd && !COMMANDS[cmd] ? 2 : 0;
	}
	return COMMANDS[cmd](opts);
}

main().then(
	(code) => process.exit(code ?? 0),
	(err) => {
		console.error(`hz3: ${err.message}`);
		if (String(err.message).includes('Cannot find module'))
			console.error('hint: build the WASM module first — ./scripts/build-wasm-lib.sh');
		process.exit(2);
	},
);
