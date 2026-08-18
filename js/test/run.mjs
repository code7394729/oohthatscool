#!/usr/bin/env node
/**
 * run.mjs — the JavaScript-side test wrapper.
 *
 * Independently executable: `node js/test/run.mjs`, no test framework, no
 * node_modules, no browser. Exits nonzero on failure.
 *
 * Two tiers, and the split is deliberate:
 *
 *   pure   No WASM. Exercises the blink policy, the decoders and the renderers
 *          on literal objects. These are the tests that run in milliseconds and
 *          are where the interesting UI logic actually gets pinned down.
 *
 *   wasm   Loads the real module and drives the real core, then checks the JS
 *          layer against it — including that this side's names for the RTL's
 *          encodings agree with the strings C++ emits. Skipped with a notice if
 *          build/wasm/hz3.mjs has not been built, so the pure tier stays
 *          runnable anywhere.
 *
 *   node js/test/run.mjs             everything available
 *   node js/test/run.mjs --pure      skip the WASM tier
 *   node js/test/run.mjs --filter blink
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
	BlinkTracker, DEFAULT_BLINK_OPTIONS, NEVER, activeBlinks, decayLevel, regBlink,
} from '../src/blink.mjs';
import {
	BYPASS_NAMES, disasm, hex32, memOpName, stallCauses, stallReasonName,
} from '../src/decode.mjs';
import { parseTrace, validateTrace, writeEvents } from '../src/trace.mjs';
import { buildTimeline, renderFrame, renderRegisters, renderTimeline } from '../src/render-text.mjs';

const ROOT = new URL('../../', import.meta.url);
const WASM_MODULE = fileURLToPath(new URL('build/wasm/hz3.mjs', ROOT));
const HELLO_BIN = fileURLToPath(new URL('programs/hello/build/hello.bin', ROOT));

// ---------------------------------------------------------------------------
// Micro test framework

const tests = [];
const test = (name, fn) => tests.push({ name, fn, tier: 'pure' });
const wasmTest = (name, fn) => tests.push({ name, fn, tier: 'wasm' });

function assert(cond, msg) {
	if (!cond) throw new Error(msg ?? 'assertion failed');
}

function assertEq(actual, expected, msg) {
	if (!Object.is(actual, expected))
		throw new Error(`${msg ?? 'expected equal'}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

function assertClose(actual, expected, eps = 1e-9, msg) {
	if (Math.abs(actual - expected) > eps)
		throw new Error(`${msg ?? 'expected close'}: got ${actual}, want ${expected}`);
}

/** Build a RegView the way a snapshot carries one. */
function reg(value, writes, lastWriteCycle, lastReadCycle = NEVER) {
	return { value, writes, lastWriteCycle, lastReadCycle };
}

// ===========================================================================
// Blink policy — the reason this file exists
// ===========================================================================

test('decay ramps from full to nothing over the window', () => {
	assertEq(decayLevel(0, 6), 1);
	assertClose(decayLevel(3, 6), 0.5);
	assertEq(decayLevel(6, 6), 0);
	assertEq(decayLevel(99, 6), 0);
	assertEq(decayLevel(0, 0), 1, 'a zero window still shows the cycle of the write');
});

test('a rewrite of the same value still lights the register', () => {
	// The failure this whole mechanism exists to prevent: the value is
	// identical across the two frames, and the register must light up anyway.
	const before = reg(7, 3, 40);
	const after = reg(7, 4, 41);
	assertEq(before.value, after.value, 'the test is only meaningful if the value is unchanged');

	const b = regBlink(after, 5, 41, before.writes);
	assert(b.wrote, 'an unchanged-value write must still register as a write');
	assertEq(b.writesDelta, 1);
	assertEq(b.level, 1);
	assertEq(b.ageCycles, 0);
});

test('a register nobody touched stays dark', () => {
	const b = regBlink(reg(7, 3, 40), 5, 41, 3);
	assertEq(b.writesDelta, 0);
	assertClose(b.level, decayLevel(1, DEFAULT_BLINK_OPTIONS.decayCycles));
	const cold = regBlink(reg(7, 3, 40), 5, 400, 3);
	assertEq(cold.level, 0);
	assertEq(cold.wrote, false);
});

test('a never-written register has no age and no highlight', () => {
	const b = regBlink(reg(0, 0, NEVER), 9, 100, 0);
	assertEq(b.ageCycles, null);
	assertEq(b.level, 0);
	assertEq(b.read, false);
});

test('the highlight persists for several cycles after the write', () => {
	// Point 2 of the blink problem: a one-cycle event has to survive long
	// enough to be seen, and fade in recency order.
	const levels = [];
	for (let age = 0; age <= 7; age++)
		levels.push(regBlink(reg(1, 1, 100), 5, 100 + age, 1).level);

	assertEq(levels[0], 1);
	for (let i = 1; i < 6; i++)
		assert(levels[i] > 0 && levels[i] < levels[i - 1], `level must decay at age ${i}`);
	assertEq(levels[6], 0, 'and be gone by the end of the window');
	assertEq(levels[7], 0);
});

test('back-to-back writes retrigger instead of sitting at a constant glow', () => {
	// Point 3: consecutive writes never leave the top of the decay ramp, so
	// `level` alone is a constant and reads as "nothing is happening". The
	// animation key and parity must change on every single write.
	const keys = new Set();
	const parities = [];
	for (let i = 1; i <= 4; i++) {
		const b = regBlink(reg(7, i, 100 + i), 5, 100 + i, i - 1);
		assertEq(b.level, 1, 'consecutive writes stay at full level — that is the problem');
		keys.add(b.key);
		parities.push(b.parity);
	}
	assertEq(keys.size, 4, 'each write needs a distinct animation key');
	assertEq(parities.join(''), '1010', 'parity must alternate so an attribute toggle retriggers');
});

test('run mode reports writes the viewer never saw', () => {
	// Thousands of cycles between frames: the age-based ramp is useless (the
	// last write may be long past) but the write count is not.
	const b = regBlink(reg(0x2a, 512, 3000), 10, 9000, 500);
	assertEq(b.writesDelta, 12);
	assertEq(b.level, 1, 'unseen writes deserve full brightness however old they are');
	assert(b.ageCycles > DEFAULT_BLINK_OPTIONS.decayCycles, 'and the write really is old');
});

test('BlinkTracker shows nothing on its first frame', () => {
	const t = new BlinkTracker();
	const regs = Array.from({ length: 32 }, (_, i) => reg(i, i, i ? 1 : NEVER));
	const first = t.update({ cycle: 500, regs });
	assert(first.every((b) => b.writesDelta === 0), 'nothing is "new" before there is a previous frame');
	assert(first.every((b) => b.level === 0), 'and nothing is recent at cycle 500');
});

test('BlinkTracker tracks deltas between frames', () => {
	const t = new BlinkTracker();
	const mk = (writes) => ({
		cycle: 10,
		regs: Array.from({ length: 32 }, (_, i) => reg(0, i === 5 ? writes : 0, i === 5 ? 10 : NEVER)),
	});
	t.update(mk(1));
	const second = t.update(mk(4));
	assertEq(second[5].writesDelta, 3);
	assertEq(second[6].writesDelta, 0);
});

test('BlinkTracker forgets history when the machine is reset', () => {
	const t = new BlinkTracker();
	const regs = (writes) => Array.from({ length: 32 }, (_, i) => reg(0, i === 5 ? writes : 0, NEVER));
	t.update({ cycle: 900, regs: regs(50) });
	// Cycle went backwards: the sim was reset, so counts restart from zero and
	// must not read as "45 writes disappeared" or "the file all changed".
	const after = t.update({ cycle: 3, regs: regs(0) });
	assert(after.every((b) => b.writesDelta === 0), 'a reset must not light the whole file');
});

test('activeBlinks ranks by recency and skips x0', () => {
	const regs = Array.from({ length: 32 }, () => reg(0, 0, NEVER));
	regs[0] = reg(0, 9, 100);
	regs[3] = reg(0, 1, 98);
	regs[7] = reg(0, 1, 100);
	const blinks = regs.map((r, i) => regBlink(r, i, 100, r.writes));
	const active = activeBlinks(blinks);
	assertEq(active.map((b) => b.index).join(','), '7,3', 'most recent first, x0 excluded');
});

// ===========================================================================
// Decoding
// ===========================================================================

test('stall reason ranking matches the priority the simulator uses', () => {
	assertEq(stallReasonName(0), 'none');
	assertEq(stallReasonName(1 << 1), 'load-use');
	assertEq(stallReasonName(1 << 2), 'muldiv');
	// Load-use is the teachable one, so it wins over a generic downstream stall.
	assertEq(stallReasonName((1 << 0) | (1 << 1)), 'load-use');
	assertEq(stallReasonName(1 << 0), 'downstream-m');
	assertEq(stallCauses((1 << 1) | (1 << 2)).map((c) => c.id).join(','), 'load-use,muldiv');
});

test('bypass names line up with the RTL encoding', () => {
	assertEq(BYPASS_NAMES.join(','), 'none,regfile,M,W');
});

test('disassembler agrees with hand-encoded instructions', () => {
	const cases = [
		[0x00700293, 0x80000000, 'li t0, 7'],
		[0x00628333, 0x80000000, 'add t1, t0, t1'],
		[0x40628333, 0x80000000, 'sub t1, t0, t1'],
		[0x026283b3, 0x80000000, 'mul t2, t0, t1'],
		[0x0002a303, 0x80000000, 'lw t1, 0(t0)'],
		[0x0062a023, 0x80000000, 'sw t1, 0(t0)'],
		[0x00000063, 0x80000010, 'beqz zero, 0x80000010'],
		[0x00000013, 0x80000000, 'nop'],
		[0x00000073, 0x80000000, 'ecall'],
		[0x32005073, 0x80000000, 'csrrwi zero, mcountinhibit, 0'],
		[0x81000137, 0x80000000, 'lui sp, 0x81000'],
	];
	for (const [word, pc, want] of cases)
		assertEq(disasm(word, pc), want, `disasm(${hex32(word)})`);
});

test('memory op names cover the loads and stores', () => {
	assertEq(memOpName(0x00), 'lw');
	assertEq(memOpName(0x05), 'sw');
	assertEq(memOpName(0x10), 'none');
});

// ===========================================================================
// Traces and rendering
// ===========================================================================

/**
 * A hand-built trace of three `addi t0, zero, 7` in a row: one instruction
 * enters execute each cycle and reaches writeback the next, so t0 is written
 * three times with the same value.
 *
 * Written out by hand rather than recorded, so the pure tier stays runnable
 * with nothing built. It has to be *physically* consistent — M holds what X
 * issued the previous cycle — or buildTimeline is right to complain about it.
 */
function syntheticTrace() {
	const PC = 0x80000000;
	const ADDI_T0_7 = 0x00700293;

	// writes[c] = t0's lifetime write count as of cycle c. The first write
	// lands in cycle 2, when the first instruction reaches writeback.
	const writesAt = (cycle) => Math.max(0, cycle - 1);

	const frame = (cycle) => {
		const xPc = PC + 4 * (cycle - 1);
		const mValid = cycle > 1;
		const mPc = PC + 4 * (cycle - 2);
		const writes = writesAt(cycle);
		return {
			cycle, retired: cycle, exited: false, exitCode: 0,
			f: {
				pc: xPc + 4, cir: ADDI_T0_7, cirVld: 2, is32bit: true,
				jumpReq: false, jumpRdy: true, jumpTarget: 0,
			},
			x: {
				pc: xPc, instr: ADDI_T0_7, valid: true, issue: true,
				rs1: 0, rs2: 0, rd: 5, imm: 7, aluOp: 0, memOp: 0x10, mulOp: 0, branchCond: 0,
				opA: 0, opB: 7, aluResult: 7, rs1Bypass: 0, rs2Bypass: 0, bypassA: 0, bypassB: 0,
				jumpReq: false, stall: false, stallCause: 0, stallReason: 'none',
				starved: false, csrRen: false, csrWen: false, csrRdata: 0, except: 0,
			},
			m: {
				valid: mValid, pc: mValid ? mPc : 0, instr: mValid ? ADDI_T0_7 : 0,
				rd: mValid ? 5 : 0, result: 7, xmResult: 7, memOp: 0x10,
				stall: false, busStall: false, dphaseInFlight: false, regWen: mValid,
				trapEnter: false, trapIsIrq: false, trapAddr: 0, except: 0,
			},
			regs: Array.from({ length: 32 }, (_, i) =>
				i === 5 && writes > 0
					? reg(7, writes, cycle)
					: reg(0, 0, NEVER)),
			csr: { mcycle: 0, minstret: 0, mepc: 0, mtvec: PC, mcause: 0, mstatus: 0 },
			bus: {
				iReq: true, iAddr: xPc + 4, iDphReady: true, dReq: false, dAddr: 0,
				dWrite: false, dWdata: 0, dRdata: 0, dDphReady: false,
				haddr: xPc + 4, htrans: 2, hwrite: false, hsize: 2,
			},
		};
	};

	return [frame(1), frame(2), frame(3)];
}

test('trace round-trips through JSONL', () => {
	const snaps = syntheticTrace();
	const text = snaps.map((s) => JSON.stringify(s)).join('\n') + '\n';
	const back = parseTrace(text);
	assertEq(back.length, 3);
	assertEq(back[2].cycle, 3);
	assertEq(validateTrace(back).length, 0);
});

test('trace validation catches a gap and a rewound counter', () => {
	const snaps = syntheticTrace();
	snaps[1].cycle = 9;
	assert(validateTrace(snaps).some((p) => p.includes('contiguous')), 'gap not reported');

	const rewound = syntheticTrace();
	rewound[2].regs[5].writes = 0;   // was 2 in the previous frame
	assert(validateTrace(rewound).some((p) => p.includes('write count')), 'rewound count not reported');
});

test('writeEvents finds same-value rewrites in a trace', () => {
	// t0 is written on cycles 2 and 3 with the identical value both times; only
	// the write counter distinguishes the second one from nothing happening.
	const snaps = syntheticTrace();
	const events = writeEvents(snaps, 5);
	assertEq(events.length, 2, 'both writes must be recovered from the trace');
	assert(events.every((e) => e.value === 7), 'the value never changes');
	assertEq(events.map((e) => e.cycle).join(','), '2,3');
});

test('renderers produce readable text without a DOM', () => {
	const snap = syntheticTrace().at(-1);
	const blinks = new BlinkTracker().update(snap);
	const frame = renderFrame(snap, blinks);
	assert(frame.includes('cycle 3'), 'header missing');
	assert(frame.includes('li t0, 7'), 'disassembly missing');
	assert(frame.includes('t0 <= 0x00000007'), 'writeback annotation missing');

	// The register just written is marked in the panel, on the strength of its
	// write cycle alone — its value is the same as it was two cycles ago.
	assertEq(blinks[5].level, 1);
	const panel = renderRegisters(snap, blinks);
	assert(/\bt0!/.test(panel), `t0 not marked as updated:\n${panel}`);
});

test('timeline reconstructs stage occupancy without complaint', () => {
	const snaps = syntheticTrace();
	const { rows, warnings } = buildTimeline(snaps);
	assertEq(warnings.length, 0, `timeline warnings: ${warnings.join('; ')}`);
	assert(rows.length >= 1, 'no instructions tracked');
	assert(renderTimeline(snaps).includes('X issue'), 'legend missing');
});

// ===========================================================================
// WASM tier — the real core, driven from JavaScript
// ===========================================================================

/** addi t0, x0, 7 three times, then park. Same value written every time. */
const SAME_VALUE_PROGRAM = new Uint32Array([
	0x00700293, // addi t0, zero, 7
	0x00700293, // addi t0, zero, 7   (value unchanged)
	0x00700293, // addi t0, zero, 7   (value unchanged)
	0x00000063, // beq zero, zero, 0  (park)
]);

async function freshSim(program) {
	const { createSim } = await import('../src/sim.mjs');
	const sim = await createSim();
	sim.loadProgram(new Uint8Array(program.buffer ?? program));
	sim.reset();
	return sim;
}

wasmTest('the module loads and exposes the memory map', async () => {
	const sim = await freshSim(SAME_VALUE_PROGRAM);
	assertEq(sim.map.memBase, 0x80000000);
	assertEq(sim.map.ioExit, 0xc0000008);
	assertEq(sim.cycles, 0);
	sim.dispose();
});

wasmTest('snapshot shape matches what the renderers expect', async () => {
	const sim = await freshSim(SAME_VALUE_PROGRAM);
	sim.run(40);
	const s = sim.snapshot();
	for (const k of ['cycle', 'retired', 'f', 'x', 'm', 'regs', 'csr', 'bus'])
		assert(k in s, `snapshot is missing '${k}'`);
	assertEq(s.regs.length, 32);
	for (const k of ['value', 'writes', 'lastWriteCycle', 'lastReadCycle'])
		assert(k in s.regs[0], `register view is missing '${k}'`);
	sim.dispose();
});

wasmTest('this side names stall causes exactly as the simulator does', async () => {
	// The one place the RTL encoding is spelled out twice: sim/snapshot.h and
	// js/src/decode.mjs. Check every cycle of a real run so they cannot drift.
	const sim = await freshSim(SAME_VALUE_PROGRAM);
	let checked = 0;
	for (let i = 0; i < 80; i++) {
		sim.stepCycle();
		const s = sim.snapshot();
		assertEq(stallReasonName(s.x.stallCause), s.x.stallReason,
			`cycle ${s.cycle}: stall cause 0b${s.x.stallCause.toString(2)}`);
		checked++;
	}
	assert(checked === 80);
	sim.dispose();
});

wasmTest('same-value writes reach JavaScript as three distinct writes', async () => {
	// End to end: the write strobe in the RTL, through the tracker, through the
	// JSON seam, into the blink policy — with a program whose register value
	// never changes after the first instruction.
	const sim = await freshSim(SAME_VALUE_PROGRAM);
	const blink = new BlinkTracker();
	const lit = [];
	const values = new Set();

	for (let i = 0; i < 60; i++) {
		sim.stepCycle();
		const s = sim.snapshot();
		const blinks = blink.update(s);
		values.add(s.regs[5].value);
		if (blinks[5].writesDelta > 0) lit.push({ cycle: s.cycle, value: s.regs[5].value });
	}

	assertEq(lit.length, 3, `expected three writes to t0, saw ${JSON.stringify(lit)}`);
	assert(lit.every((e) => e.value === 7), 'every write lands the same value');
	assertEq([...values].sort((a, b) => a - b).join(','), '0,7', 'the value only ever changes once');
	sim.dispose();
});

wasmTest('stepInstruction retires exactly one instruction', async () => {
	const sim = await freshSim(SAME_VALUE_PROGRAM);
	for (let i = 0; i < 4; i++) {
		const before = sim.retired;
		const res = sim.stepInstruction();
		assertEq(res.reason, 'retired');
		assertEq(sim.retired, before + 1);
	}
	sim.dispose();
});

wasmTest('a breakpoint stops with the instruction still in execute', async () => {
	const sim = await freshSim(SAME_VALUE_PROGRAM);
	const target = 0x80000008;
	const res = sim.run(500, target);
	assertEq(res.reason, 'breakpoint');
	assertEq(sim.snapshot().x.pc, target);
	sim.dispose();
});

wasmTest('timeline over a real run has no inconsistencies', async () => {
	const sim = await freshSim(SAME_VALUE_PROGRAM);
	const snaps = [];
	for (let i = 0; i < 40; i++) { sim.stepCycle(); snaps.push(sim.snapshot()); }
	const { rows, warnings } = buildTimeline(snaps);
	assertEq(warnings.length, 0, `timeline disagreed with the model:\n  ${warnings.join('\n  ')}`);
	assert(rows.length >= 3, 'expected at least the three adds');
	sim.dispose();
});

wasmTest('hello.bin runs to the same result as the native build', async () => {
	if (!existsSync(HELLO_BIN)) {
		throw { skip: 'programs/hello/build/hello.bin not built' };
	}
	const bytes = new Uint8Array(await readFile(HELLO_BIN));
	const sim = await freshSim(bytes);
	const res = sim.run(200000);
	assertEq(res.reason, 'exit');
	assertEq(sim.exitCode, 123);
	assertEq(sim.cycles, 476, 'cycle count must match the native run exactly');
	assert(sim.drainOutput().includes('Hello, world'), 'program output missing');
	assertEq(sim.fault(), null, 'the model raised a fault');
	sim.dispose();
});

// ===========================================================================

async function main() {
	const argv = process.argv.slice(2);
	const pureOnly = argv.includes('--pure');
	const filterIdx = argv.indexOf('--filter');
	const filter = filterIdx >= 0 ? argv[filterIdx + 1] : null;

	const haveWasm = existsSync(WASM_MODULE);
	if (!pureOnly && !haveWasm)
		console.log('  (build/wasm/hz3.mjs not found — run ./scripts/build-wasm-lib.sh for the WASM tier)\n');

	let passed = 0, failed = 0, skipped = 0;
	for (const t of tests) {
		if (filter && !t.name.includes(filter)) continue;
		if (t.tier === 'wasm' && (pureOnly || !haveWasm)) { skipped++; continue; }

		process.stdout.write(`  ${t.name.padEnd(62)} `);
		try {
			await t.fn();
			console.log('ok');
			passed++;
		} catch (err) {
			if (err && err.skip) { console.log(`skipped (${err.skip})`); skipped++; continue; }
			console.log('FAILED');
			console.log(`      ${err.message ?? err}`);
			failed++;
		}
	}

	console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}`);
	process.exit(failed ? 1 : 0);
}

main();
