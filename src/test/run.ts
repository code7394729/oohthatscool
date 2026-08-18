#!/usr/bin/env node
/**
 * run.ts — the TypeScript-side test wrapper.
 *
 * Independently executable: `node dist/test/run.js`, no test framework, no
 * runtime dependencies, no browser. Exits nonzero on failure.
 *
 * Two tiers, and the split is deliberate:
 *
 *   pure   No WASM, no DOM. Exercises the blink policy, the decoders, the
 *          renderers, and the whole of the visualization that is not the DOM:
 *          the datapath model, its layout, the scene builder and the snapshot
 *          bindings. That is most of the interesting logic, and it runs in
 *          milliseconds.
 *
 *   wasm   Loads the real module and drives the real core, then checks the
 *          TypeScript layer against it — including that this side's names for
 *          the RTL's encodings agree with the strings C++ emits. Skipped with a
 *          notice if build/wasm/hz3.mjs has not been built.
 *
 *   node dist/test/run.js             everything available
 *   node dist/test/run.js --pure      skip the WASM tier
 *   node dist/test/run.js --filter blink
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
	activeBlinks, BlinkTracker, DEFAULT_BLINK_OPTIONS, decayLevel, regBlink,
} from '../core/blink.js';
import { BYPASS_NAMES, disasm, hex32, memOpName, stallReasonName } from '../core/decode.js';
import { renderFrame, renderRegisters, renderTimeline } from '../core/render-text.js';
import { assemble, addi, add, X } from '../core/rv32.js';
import {
	Bypass, NEVER, snapshotShapeProblems, Stall,
	type RegView, type Snapshot,
} from '../core/snapshot.js';
import { buildTimeline } from '../core/timeline.js';
import { parseTrace, validateTrace, writeEvents } from '../core/trace.js';

import { computeDisplay } from '../viz/model/bindings.js';
import { datapath } from '../viz/model/datapath.js';
import { validateDatapath } from '../viz/model/types.js';
import { datapathLayout } from '../viz/layout/datapath-layout.js';
import { resolveLayout, validateLayout } from '../viz/layout/types.js';
import { polylinePath, route, simplify } from '../viz/layout/route.js';
import { buildScene, CID, NID, sceneToSvg } from '../viz/render/scene.js';
import { examples } from '../viz/programs.js';

const ROOT = new URL('../../', import.meta.url);
const WASM_MODULE = fileURLToPath(new URL('build/wasm/hz3.mjs', ROOT));
const HELLO_BIN = fileURLToPath(new URL('programs/hello/build/hello.bin', ROOT));

// ---------------------------------------------------------------------------
// Micro test framework

interface Test {
	name: string;
	fn: () => void | Promise<void>;
	tier: 'pure' | 'wasm';
}

const tests: Test[] = [];
const test = (name: string, fn: Test['fn']) => tests.push({ name, fn, tier: 'pure' });
const wasmTest = (name: string, fn: Test['fn']) => tests.push({ name, fn, tier: 'wasm' });

class SkipTest extends Error {}

function assert(cond: unknown, msg?: string): asserts cond {
	if (!cond) throw new Error(msg ?? 'assertion failed');
}

function assertEq<T>(actual: T, expected: T, msg?: string): void {
	if (!Object.is(actual, expected))
		throw new Error(`${msg ?? 'expected equal'}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

function assertClose(actual: number, expected: number, eps = 1e-9, msg?: string): void {
	if (Math.abs(actual - expected) > eps)
		throw new Error(`${msg ?? 'expected close'}: got ${actual}, want ${expected}`);
}

/** Build a RegView the way a snapshot carries one. */
function reg(value: number, writes: number, lastWriteCycle: number, lastReadCycle = NEVER): RegView {
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
	const levels: number[] = [];
	for (let age = 0; age <= 7; age++)
		levels.push(regBlink(reg(1, 1, 100), 5, 100 + age, 1).level);

	assertEq(levels[0], 1);
	for (let i = 1; i < 6; i++)
		assert(levels[i]! > 0 && levels[i]! < levels[i - 1]!, `level must decay at age ${i}`);
	assertEq(levels[6], 0, 'and be gone by the end of the window');
	assertEq(levels[7], 0);
});

test('back-to-back writes retrigger instead of sitting at a constant glow', () => {
	// Point 3: consecutive writes never leave the top of the decay ramp, so
	// `level` alone is a constant and reads as "nothing is happening". The
	// animation key and parity must change on every single write.
	const keys = new Set<string>();
	const parities: number[] = [];
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
	assert(b.ageCycles! > DEFAULT_BLINK_OPTIONS.decayCycles, 'and the write really is old');
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
	const mk = (writes: number) => ({
		cycle: 10,
		regs: Array.from({ length: 32 }, (_, i) => reg(0, i === 5 ? writes : 0, i === 5 ? 10 : NEVER)),
	});
	t.update(mk(1));
	const second = t.update(mk(4));
	assertEq(second[5]!.writesDelta, 3);
	assertEq(second[6]!.writesDelta, 0);
});

test('BlinkTracker forgets history when the machine is reset', () => {
	const t = new BlinkTracker();
	const regs = (writes: number) =>
		Array.from({ length: 32 }, (_, i) => reg(0, i === 5 ? writes : 0, NEVER));
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
	assertEq(activeBlinks(blinks).map((b) => b.index).join(','), '7,3',
		'most recent first, x0 excluded');
});

// ===========================================================================
// Decoding
// ===========================================================================

test('stall reason ranking matches the priority the simulator uses', () => {
	assertEq(stallReasonName(0), 'none');
	assertEq(stallReasonName(Stall.Raw), 'load-use');
	assertEq(stallReasonName(Stall.Muldiv), 'muldiv');
	// Load-use is the teachable one, so it wins over a generic downstream stall.
	assertEq(stallReasonName(Stall.MStall | Stall.Raw), 'load-use');
	assertEq(stallReasonName(Stall.MStall), 'downstream-m');
});

test('bypass names line up with the RTL encoding', () => {
	assertEq(BYPASS_NAMES.join(','), 'none,regfile,M,W');
	assertEq(BYPASS_NAMES[Bypass.M], 'M');
});

test('disassembler agrees with hand-encoded instructions', () => {
	const cases: Array<[number, number, string]> = [
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

test('the assembler round-trips through the disassembler', () => {
	// The two are independent implementations of the same encoding, so agreeing
	// is real evidence rather than a tautology.
	const p = assemble((b) => {
		b.add(addi(X.t0, X.zero, 7));
		b.add(add(X.t1, X.t0, X.t2));
		b.label('here');
		b.branch('bne', X.t0, X.zero, 'here');
	});
	assertEq(disasm(p.words[0]!, p.addresses[0]!), 'li t0, 7');
	assertEq(disasm(p.words[1]!, p.addresses[1]!), 'add t1, t0, t2');
	assertEq(disasm(p.words[2]!, p.addresses[2]!), `bnez t0, ${hex32(p.addresses[2]!)}`);
	assertEq(p.bytes.length, 12);
});

// ===========================================================================
// Traces and text rendering
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
function syntheticTrace(): Snapshot[] {
	const PC = 0x80000000;
	const ADDI_T0_7 = 0x00700293;

	const frame = (cycle: number): Snapshot => {
		const xPc = PC + 4 * (cycle - 1);
		const mValid = cycle > 1;
		const mPc = PC + 4 * (cycle - 2);
		const writes = Math.max(0, cycle - 1);
		return {
			cycle, retired: cycle, exited: false, exitCode: 0,
			f: {
				pc: xPc + 4, cir: ADDI_T0_7, cirVld: 2, is32bit: true,
				jumpReq: false, jumpRdy: true, jumpTarget: 0,
			},
			x: {
				pc: xPc, instr: ADDI_T0_7, valid: true, issue: true,
				rs1: 0, rs2: 0, rd: 5, imm: 7, aluOp: 0, memOp: 0x10, mulOp: 0, branchCond: 0,
				opA: 0, opB: 7, aluResult: 7, rs1Bypass: 0, rs2Bypass: 0,
				bypassA: Bypass.None, bypassB: Bypass.None,
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
				i === 5 && writes > 0 ? reg(7, writes, cycle) : reg(0, 0, NEVER)),
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
	const back = parseTrace(snaps.map((s) => JSON.stringify(s)).join('\n') + '\n');
	assertEq(back.length, 3);
	assertEq(back[2]!.cycle, 3);
	assertEq(validateTrace(back).length, 0);
});

test('trace validation catches a gap and a rewound counter', () => {
	const gapped = syntheticTrace();
	gapped[1]!.cycle = 9;
	assert(validateTrace(gapped).some((p) => p.includes('contiguous')), 'gap not reported');

	const rewound = syntheticTrace();
	rewound[2]!.regs[5]!.writes = 0;   // was 2 in the previous frame
	assert(validateTrace(rewound).some((p) => p.includes('write count')), 'rewound count not reported');
});

test('writeEvents finds same-value rewrites in a trace', () => {
	// t0 is written on cycles 2 and 3 with the identical value both times; only
	// the write counter distinguishes the second one from nothing happening.
	const events = writeEvents(syntheticTrace(), 5);
	assertEq(events.length, 2, 'both writes must be recovered from the trace');
	assert(events.every((e) => e.value === 7), 'the value never changes');
	assertEq(events.map((e) => e.cycle).join(','), '2,3');
});

test('the synthetic trace matches the declared Snapshot shape', () => {
	// Keeps the fixture honest against src/core/snapshot.ts, which the WASM tier
	// separately checks against the real simulator.
	assertEq(snapshotShapeProblems(syntheticTrace()[0]).join('; '), '');
});

test('text renderers produce readable output without a DOM', () => {
	const snap = syntheticTrace().at(-1)!;
	const blinks = new BlinkTracker().update(snap);
	const frame = renderFrame(snap, blinks);
	assert(frame.includes('cycle 3'), 'header missing');
	assert(frame.includes('li t0, 7'), 'disassembly missing');
	assert(frame.includes('t0 <= 0x00000007'), 'writeback annotation missing');

	// The register just written is marked in the panel, on the strength of its
	// write cycle alone — its value is the same as it was two cycles ago.
	assertEq(blinks[5]!.level, 1);
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
// The visualization, minus the pixels
//
// Model, layout, routing, scene building and the snapshot bindings are all pure
// functions, so the great majority of the diagram is checkable here.
// ===========================================================================

test('the datapath model is internally consistent', () => {
	const { errors, warnings } = validateDatapath(datapath);
	assertEq(errors.join('\n'), '', 'model errors');
	// Every port should be wired: an unconnected one is either a missing net or
	// a port nobody needs.
	assertEq(warnings.join('\n'), '', 'model warnings');
});

test('every input port has exactly one driver', () => {
	// The invariant that stops the model from fudging a mux it should be
	// drawing. validateDatapath enforces it; assert the check itself works.
	const doubled = {
		components: datapath.components,
		nets: [...datapath.nets, {
			id: 'bogus', kind: 'data' as const,
			from: { component: 'alu', port: 'out' },
			to: [{ component: 'xm', port: 'd_result' }],
		}],
	};
	const { errors } = validateDatapath(doubled);
	assert(errors.some((e) => e.includes('driven by both')), `expected a driver conflict, got: ${errors}`);
});

test('the layout covers the model and nothing else', () => {
	const { errors, warnings } = validateLayout(datapath, datapathLayout);
	assertEq(errors.join('\n'), '', 'layout errors');
	assertEq(warnings.join('\n'), '', 'layout warnings (overlaps / out of canvas)');
});

test('every port resolves to a point on its component', () => {
	const resolved = resolveLayout(datapath, datapathLayout);
	for (const c of datapath.components) {
		const box = resolved.boxes.get(c.id);
		assert(box, `no box for ${c.id}`);
		for (const p of c.ports) {
			const a = resolved.anchors.get(`${c.id}.${p.id}`);
			assert(a, `no anchor for ${c.id}.${p.id}`);
			const onEdge =
				Math.abs(a.point.x - box.x) < 0.01 || Math.abs(a.point.x - (box.x + box.w)) < 0.01 ||
				Math.abs(a.point.y - box.y) < 0.01 || Math.abs(a.point.y - (box.y + box.h)) < 0.01;
			assert(onEdge, `${c.id}.${p.id} is not on the boundary of its box`);
		}
	}
});

test('routes are orthogonal and end where they were told to', () => {
	const points = route({
		from: { x: 100, y: 100 }, fromSide: 'e',
		to: { x: 400, y: 300 }, toSide: 'w',
	});
	assertEq(points[0]!.x, 100);
	assertEq(points.at(-1)!.x, 400);
	assertEq(points.at(-1)!.y, 300);
	for (let i = 1; i < points.length; i++) {
		const a = points[i - 1]!, b = points[i]!;
		assert(a.x === b.x || a.y === b.y, `segment ${i} is diagonal`);
	}
	assert(polylinePath(points).startsWith('M100,100'), 'path does not start at the source');
});

test('waypoints are honoured, and simplify removes redundant corners', () => {
	const points = route({
		from: { x: 100, y: 100 }, fromSide: 'e',
		to: { x: 100, y: 400 }, toSide: 'w',
		via: [{ x: 300, y: 250 }],
	});
	assert(points.some((p) => p.x === 300), 'the waypoint x was not visited');
	assertEq(simplify([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }]).length, 2);
	assertEq(simplify([{ x: 0, y: 0 }, { x: 0, y: 0 }]).length, 1);
});

test('the scene contains a shape and a wire for everything in the model', () => {
	const scene = buildScene(datapath, datapathLayout);
	const ids = new Set(scene.ids);

	for (const c of datapath.components) {
		assert(ids.has(CID(c.id)), `no group for component ${c.id}`);
		assert(ids.has(CID(c.id, 'shape')), `no shape for ${c.id}`);
		assert(ids.has(CID(c.id, 'value')), `no value slot for ${c.id}`);
	}
	for (const n of datapath.nets) {
		assert(ids.has(NID(n.id)), `no group for net ${n.id}`);
		n.to.forEach((_, k) => assert(ids.has(NID(n.id, `b${k}`)), `no path for ${n.id} branch ${k}`));
	}
	assertEq(new Set(scene.ids).size, scene.ids.length, 'duplicate ids in the scene');
	assert(scene.width > 0 && scene.height > 0);
});

test('the scene serialises to well-formed SVG', () => {
	const svg = sceneToSvg(buildScene(datapath, datapathLayout));
	assert(svg.startsWith('<svg '), 'not an svg element');
	assert(svg.includes('viewBox='), 'no viewBox');
	assert(svg.trimEnd().endsWith('</svg>'), 'unterminated');
	// Tags balance: a broken generator usually shows up here first.
	const open = (svg.match(/<(?!\/)[a-z]+/g) ?? []).length;
	const close = (svg.match(/<\/[a-z]+>/g) ?? []).length;
	const selfClose = (svg.match(/\/>/g) ?? []).length;
	assertEq(open, close + selfClose, 'unbalanced tags');
});

test('bindings light the forwarding path when the core forwards', () => {
	// The claim the diagram makes, checked directly: given a snapshot in which
	// the operand came from M, the "forward from M" wire is emphasised and the
	// register-file read is not active.
	const s = syntheticTrace().at(-1)!;
	s.x.bypassA = Bypass.M;
	s.x.rs1Bypass = 0x2a;
	s.m.xmResult = 0x2a;

	const d = computeDisplay(s);
	assertEq(d.nets['fwd_m']!.active, true);
	assertEq(d.nets['fwd_m']!.emphasis, 'highlight');
	assertEq(d.nets['fwd_m']!.value, hex32(0x2a));
	assertEq(d.nets['rf_rd1']!.active, false, 'the register file read is overridden');
	assertEq(d.components['bypassA']!.selected, 1, 'mux input 1 is "from M"');
});

test('bindings mark a stall, and a bubble, for what they are', () => {
	const stalled = syntheticTrace().at(-1)!;
	stalled.x.stall = true;
	stalled.x.stallCause = Stall.Raw;
	stalled.x.stallReason = 'load-use';
	const d1 = computeDisplay(stalled);
	assertEq(d1.components['cir']!.state, 'stalled');
	assertEq(d1.components['hazard']!.state, 'stalled');
	assertEq(d1.nets['hz_stall']!.emphasis, 'highlight');
	assertEq(d1.nets['hz_stall']!.value, 'load-use');

	const bubble = syntheticTrace().at(-1)!;
	bubble.x.valid = false;
	bubble.m.valid = false;
	const d2 = computeDisplay(bubble);
	assertEq(d2.components['decode']!.state, 'bubble');
	assertEq(d2.components['xm']!.state, 'bubble');
});

test('bindings mark the write strobe, whatever the value is', () => {
	// The diagram's half of the same-value-write story: the write control block
	// and the register file both show a write, and neither looks at the value.
	const s = syntheticTrace().at(-1)!;
	s.m.regWen = true;
	const d = computeDisplay(s);
	assertEq(d.components['wb']!.state, 'writing');
	assertEq(d.components['regfile']!.state, 'writing');
	assertEq(d.nets['wb_wen']!.active, true);
	assertEq(d.nets['wb_wen']!.emphasis, 'highlight');
});

test('bindings name a display state for every component in the model', () => {
	const d = computeDisplay(syntheticTrace().at(-1)!);
	const missing = datapath.components.filter((c) => !d.components[c.id]);
	assertEq(missing.map((c) => c.id).join(', '), '', 'components with no binding');
	const missingNets = datapath.nets.filter((n) => !d.nets[n.id]);
	assertEq(missingNets.map((n) => n.id).join(', '), '', 'nets with no binding');
});

test('every example program assembles', () => {
	for (const e of examples) {
		const p = e.build();
		assert(p.words.length >= 2, `${e.id}: suspiciously short`);
		assertEq(p.bytes.length, p.words.length * 4, `${e.id}: byte length`);
		assert(e.watch.length > 40, `${e.id}: needs a real "what to watch for"`);
	}
});

// ===========================================================================
// WASM tier — the real core, driven from TypeScript
// ===========================================================================

/** addi t0, x0, 7 three times, then park. Same value written every time. */
function sameValueProgram(): Uint8Array {
	return assemble((p) => {
		p.add(addi(X.t0, X.zero, 7));
		p.add(addi(X.t0, X.zero, 7));   // value unchanged
		p.add(addi(X.t0, X.zero, 7));   // value unchanged
		p.park();
	}).bytes;
}

async function freshSim(program: Uint8Array) {
	const { createSim } = await import('../core/sim.js');
	const sim = await createSim();
	sim.loadProgram(program);
	sim.reset();
	return sim;
}

wasmTest('the module loads and exposes the memory map', async () => {
	const sim = await freshSim(sameValueProgram());
	assertEq(sim.map.memBase, 0x80000000);
	assertEq(sim.map.ioExit, 0xc0000008);
	assertEq(sim.cycles, 0);
	sim.dispose();
});

wasmTest('a live snapshot matches the declared TypeScript type', async () => {
	// The one place src/core/snapshot.ts is checked against sim/snapshot.h. A
	// field added in C++ and forgotten here would otherwise read as undefined
	// somewhere in the UI, silently.
	const sim = await freshSim(sameValueProgram());
	sim.run(40);
	assertEq(snapshotShapeProblems(sim.snapshot()).join('; '), '');
	assertEq(sim.snapshot().regs.length, 32);
	sim.dispose();
});

wasmTest('this side names stall causes exactly as the simulator does', async () => {
	// The one place the RTL encoding is spelled out twice: sim/snapshot.h and
	// src/core/decode.ts. Check every cycle of a real run so they cannot drift.
	const sim = await freshSim(sameValueProgram());
	for (let i = 0; i < 80; i++) {
		sim.stepCycle();
		const s = sim.snapshot();
		assertEq(stallReasonName(s.x.stallCause), s.x.stallReason,
			`cycle ${s.cycle}: stall cause 0b${s.x.stallCause.toString(2)}`);
	}
	sim.dispose();
});

wasmTest('same-value writes reach the UI layer as three distinct writes', async () => {
	// End to end: the write strobe in the RTL, through the tracker, through the
	// JSON seam, into the blink policy — with a program whose register value
	// never changes after the first instruction.
	const sim = await freshSim(sameValueProgram());
	const blink = new BlinkTracker();
	const lit: Array<{ cycle: number; value: number }> = [];
	const values = new Set<number>();

	for (let i = 0; i < 60; i++) {
		sim.stepCycle();
		const s = sim.snapshot();
		const blinks = blink.update(s);
		values.add(s.regs[5]!.value);
		if (blinks[5]!.writesDelta > 0) lit.push({ cycle: s.cycle, value: s.regs[5]!.value });
	}

	assertEq(lit.length, 3, `expected three writes to t0, saw ${JSON.stringify(lit)}`);
	assert(lit.every((e) => e.value === 7), 'every write lands the same value');
	assertEq([...values].sort((a, b) => a - b).join(','), '0,7', 'the value only ever changes once');
	sim.dispose();
});

wasmTest('the diagram lights the forwarding path on a real dependent add', async () => {
	// The claim, against the actual core rather than a fixture: run the
	// forwarding example and assert that on some cycle the bindings emphasise
	// the M forwarding wire while the register file read is dark.
	const sim = await freshSim(examples.find((e) => e.id === 'forwarding')!.build().bytes);
	let sawForward = false;
	for (let i = 0; i < 60 && !sawForward; i++) {
		sim.stepCycle();
		const d = computeDisplay(sim.snapshot());
		if (d.nets['fwd_m']!.emphasis === 'highlight') {
			sawForward = true;
			assertEq(d.nets['rf_rd1']!.active, false, 'the register file read should be overridden');
			assert(d.components['bypassA']!.selected! >= 1 || d.components['bypassB']!.selected! >= 1,
				'a bypass mux should show a forwarded input selected');
		}
	}
	assert(sawForward, 'the forwarding example never forwarded');
	sim.dispose();
});

wasmTest('the diagram shows a stall on a real load-use hazard', async () => {
	const sim = await freshSim(examples.find((e) => e.id === 'loaduse')!.build().bytes);
	let sawStall = false;
	for (let i = 0; i < 120 && !sawStall; i++) {
		sim.stepCycle();
		const s = sim.snapshot();
		if ((s.x.stallCause & Stall.Raw) !== 0) {
			sawStall = true;
			const d = computeDisplay(s);
			assertEq(d.nets['hz_stall']!.emphasis, 'highlight');
			assertEq(d.components['cir']!.state, 'stalled');
			assertEq(s.x.stallReason, 'load-use');
		}
	}
	assert(sawStall, 'the load-use example never stalled');
	sim.dispose();
});

wasmTest('stepInstruction retires exactly one instruction', async () => {
	const sim = await freshSim(sameValueProgram());
	for (let i = 0; i < 4; i++) {
		const before = sim.retired;
		const res = sim.stepInstruction();
		assertEq(res.reason, 'retired');
		assertEq(sim.retired, before + 1);
	}
	sim.dispose();
});

wasmTest('a breakpoint stops with the instruction still in execute', async () => {
	const sim = await freshSim(sameValueProgram());
	const target = 0x80000008;
	assertEq(sim.run(500, target).reason, 'breakpoint');
	assertEq(sim.snapshot().x.pc, target);
	sim.dispose();
});

wasmTest('timeline over a real run has no inconsistencies', async () => {
	const sim = await freshSim(sameValueProgram());
	const snaps: Snapshot[] = [];
	for (let i = 0; i < 40; i++) { sim.stepCycle(); snaps.push(sim.snapshot()); }
	const { rows, warnings } = buildTimeline(snaps);
	assertEq(warnings.length, 0, `timeline disagreed with the model:\n  ${warnings.join('\n  ')}`);
	assert(rows.length >= 3, 'expected at least the three adds');
	sim.dispose();
});

wasmTest('hello.bin runs to the same result as the native build', async () => {
	if (!existsSync(HELLO_BIN)) throw new SkipTest('programs/hello/build/hello.bin not built');
	const sim = await freshSim(new Uint8Array(await readFile(HELLO_BIN)));
	assertEq(sim.run(200000).reason, 'exit');
	assertEq(sim.exitCode, 123);
	assertEq(sim.cycles, 476, 'cycle count must match the native run exactly');
	assert(sim.drainOutput().includes('Hello, world'), 'program output missing');
	assertEq(sim.fault(), null, 'the model raised a fault');
	sim.dispose();
});

// ===========================================================================

async function main(): Promise<void> {
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

		process.stdout.write(`  ${t.name.padEnd(64)} `);
		try {
			await t.fn();
			console.log('ok');
			passed++;
		} catch (err: unknown) {
			if (err instanceof SkipTest) { console.log(`skipped (${err.message})`); skipped++; continue; }
			console.log('FAILED');
			console.log(`      ${err instanceof Error ? err.message : String(err)}`);
			failed++;
		}
	}

	console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}`);
	process.exit(failed ? 1 : 0);
}

void main();
