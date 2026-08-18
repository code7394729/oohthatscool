/**
 * render-text.ts — render a snapshot as text.
 *
 * This is the UI layer with the pixels removed. Every rendering decision the
 * SVG datapath makes — which stage holds what, which operand came from a bypass
 * instead of the register file, which registers are lit and how brightly — can
 * be made here too, against plain objects, in code that runs under `node` with
 * no DOM and can be diffed in a test.
 *
 * That is not just a testing convenience. It is also the fastest way to check
 * that the visualization is telling the truth: an ASCII pipeline view sitting
 * next to a disassembly is easy to read against the RTL, and anything wrong in
 * here would be wrong in the diagram too.
 */

import type { RegBlink } from './blink.js';
import {
	ABI_NAMES, bypassName, disasm, hex32, memOpName, regName, stallCauses,
} from './decode.js';
import { MEMOP_NONE, type Snapshot } from './snapshot.js';
import { buildTimeline } from './timeline.js';

const pad = (s: string | number, n: number) => String(s).padEnd(n);
const padStart = (s: string | number, n: number) => String(s).padStart(n);

export interface TextOptions {
	abi?: boolean;
}

/** The three pipeline stages, one line each, with the reason for any stall. */
export function renderPipeline(s: Snapshot, opts: TextOptions = {}): string {
	const abi = opts.abi !== false;
	const lines: string[] = [];

	lines.push(`cycle ${s.cycle}   retired ${s.retired}` +
		(s.exited ? `   EXITED code=${s.exitCode}` : ''));

	// F — the front end, which is an address and a prefetch buffer, not an
	// instruction slot. Showing the CIR here is the honest depiction: the CIR
	// *is* the F|X pipeline register.
	lines.push(`  F  ${hex32(s.f.pc)}  ` +
		(s.f.cirVld
			? `cir ${hex32(s.f.cir)}  ${disasm(s.f.cir, s.f.pc, { abi })}`
			: 'cir ----------  (prefetch buffer empty)') +
		(s.f.jumpReq ? `   <- redirect to ${hex32(s.f.jumpTarget)}` : ''));

	// X — decode and execute, fused in Hazard3. Operand provenance is the whole
	// point of the diagram, so it goes on the same line as the instruction.
	if (s.x.valid) {
		const notes: string[] = [];
		if (s.x.bypassA !== 0) notes.push(`a<-${bypassName(s.x.bypassA)}`);
		if (s.x.bypassB !== 0) notes.push(`b<-${bypassName(s.x.bypassB)}`);
		if (s.x.jumpReq) notes.push('jump');
		if (s.x.stall) notes.push(`STALL ${s.x.stallReason}`);
		else if (s.x.issue) notes.push('issue');
		lines.push(`  X  ${hex32(s.x.pc)}  ${pad(disasm(s.x.instr, s.x.pc, { abi }), 24)}` +
			`  ${notes.join(' ')}`);
	} else {
		lines.push(`  X  ${'-'.repeat(10)}  (bubble: ${s.x.stallReason})`);
	}

	// M — memory and writeback. pc/instr here come from the probe's shadow of
	// the X|M register (Hazard3 keeps no PC in M).
	if (s.m.valid) {
		const notes: string[] = [];
		if (s.m.memOp !== MEMOP_NONE) notes.push(`${memOpName(s.m.memOp)} @${hex32(s.bus.dAddr)}`);
		if (s.m.regWen) notes.push(`${regName(s.m.rd, abi)} <= ${hex32(s.m.result)}`);
		if (s.m.stall) notes.push(s.m.busStall ? 'STALL bus' : 'STALL');
		if (s.m.trapEnter) notes.push(`TRAP -> ${hex32(s.m.trapAddr)}`);
		lines.push(`  M  ${hex32(s.m.pc)}  ${pad(disasm(s.m.instr, s.m.pc, { abi }), 24)}` +
			`  ${notes.join(' ')}`);
	} else {
		lines.push(`  M  ${'-'.repeat(10)}  (bubble)`);
	}

	return lines.join('\n');
}

export interface RegisterTextOptions extends TextOptions {
	columns?: number;
	showWrites?: boolean;
	only?: 'all' | 'active';
}

/**
 * The register file, with update highlighting.
 *
 * The marker after each register name is the text stand-in for the SVG's flash:
 *   `!`  written on this very cycle
 *   `*`  written recently, still inside the decay window
 *   `:`  read by the instruction in execute
 *
 * Note that a register can be marked `!` while its value is identical to the
 * previous frame's — that is the case this whole mechanism exists for.
 */
export function renderRegisters(
	s: Snapshot,
	blinks: RegBlink[] | null = null,
	opts: RegisterTextOptions = {},
): string {
	const columns = opts.columns ?? 4;
	const abi = opts.abi !== false;
	const cells: string[] = [];

	for (let i = 0; i < 32; i++) {
		const b = blinks ? blinks[i] : null;
		let mark = ' ';
		if (b) {
			if (b.level >= 1) mark = '!';
			else if (b.level > 0) mark = '*';
			else if (b.read) mark = ':';
		}
		if (opts.only === 'active' && mark === ' ') continue;
		const name = abi ? ABI_NAMES[i]! : `x${i}`;
		let cell = `${padStart(name, 4)}${mark} ${hex32(s.regs[i]!.value).slice(2)}`;
		if (opts.showWrites) cell += ` w${padStart(s.regs[i]!.writes, 3)}`;
		cells.push(cell);
	}

	const lines: string[] = [];
	for (let i = 0; i < cells.length; i += columns)
		lines.push(cells.slice(i, i + columns).join('  '));
	return lines.join('\n');
}

/**
 * The reservation table: instructions down the page, cycles across it. The
 * clearest way to see a stall push everything behind it.
 */
export function renderTimeline(
	snapshots: Snapshot[],
	opts: TextOptions & { maxRows?: number } = {},
): string {
	const { rows, cycles, warnings } = buildTimeline(snapshots);
	if (!rows.length) return '(no instructions in this window)';

	const shown = opts.maxRows ? rows.slice(0, opts.maxRows) : rows;
	const label = (r: { pc: number; instr: number }) =>
		`${hex32(r.pc)}  ${pad(disasm(r.instr, r.pc, { abi: opts.abi !== false }), 22)}`;
	const width = Math.max(...shown.map((r) => label(r).length));

	const lines: string[] = [];
	// Cycle ruler: a digit every ten cycles, so the grid stays readable.
	let ruler = ' '.repeat(width + 2);
	for (const c of cycles) ruler += c % 10 === 0 ? String((c / 10) % 10) : ' ';
	lines.push(ruler);

	for (const r of shown) {
		let line = pad(label(r), width) + '  ';
		for (const c of cycles) line += r.cells.get(c) ?? '.';
		lines.push(line);
	}

	lines.push('');
	lines.push('  X issue   x stalled in execute   M writeback   m stalled in M');
	for (const w of warnings) lines.push(`  ! ${w}`);
	return lines.join('\n');
}

/** One line per cycle, for eyeballing a long run. */
export function renderCycleLine(s: Snapshot, opts: TextOptions = {}): string {
	const abi = opts.abi !== false;
	const x = s.x.valid ? disasm(s.x.instr, s.x.pc, { abi }) : '-';
	const stall = s.x.stall ? ` [${s.x.stallReason}]` : '';
	const wb = s.m.regWen ? `  ${regName(s.m.rd, abi)}<=${hex32(s.m.result)}` : '';
	return `${padStart(s.cycle, 7)}  ${hex32(s.x.pc)}  ${pad(x, 24)}${stall}${wb}`;
}

/** Everything at once: pipeline, active stall causes, registers. */
export function renderFrame(
	s: Snapshot,
	blinks: RegBlink[] | null = null,
	opts: RegisterTextOptions = {},
): string {
	const parts = [renderPipeline(s, opts)];
	const causes = stallCauses(s.x.stallCause);
	if (causes.length) parts.push('  why: ' + causes.map((c) => c.label).join(', '));
	parts.push('');
	parts.push(renderRegisters(s, blinks, opts));
	return parts.join('\n');
}
