/**
 * render-text.mjs — render a snapshot as text.
 *
 * This is the UI layer with the pixels removed. Every rendering decision the
 * SVG datapath will make — which stage holds what, which operand came from a
 * bypass instead of the register file, which registers are lit and how brightly
 * — is made here first, against plain objects, in code that runs under `node`
 * with no DOM and can be diffed in a test.
 *
 * That is not just a testing convenience. It is also the fastest way to check
 * that the visualization is telling the truth: an ASCII pipeline view sitting
 * next to a disassembly is easy to read against the RTL, and anything wrong in
 * here would be wrong in the diagram too.
 */

import {
	ABI_NAMES, bypassName, disasm, hex32, memOpName, MEMOP_NONE,
	regName, stallCauses,
} from './decode.mjs';

/** @param {string} s @param {number} n */
const pad = (s, n) => String(s).padEnd(n);
/** @param {string} s @param {number} n */
const padStart = (s, n) => String(s).padStart(n);

/**
 * The three pipeline stages, one line each, with the reason for any stall.
 *
 * @param {any} s snapshot
 * @param {{abi?:boolean}} [opts]
 * @returns {string}
 */
export function renderPipeline(s, opts = {}) {
	const abi = opts.abi !== false;
	const lines = [];

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
		const notes = [];
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
		const notes = [];
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
 *
 * @param {any} s snapshot
 * @param {import('./blink.mjs').RegBlink[]} [blinks]
 * @param {{columns?:number, abi?:boolean, showWrites?:boolean, only?:'all'|'active'}} [opts]
 * @returns {string}
 */
export function renderRegisters(s, blinks = null, opts = {}) {
	const columns = opts.columns ?? 4;
	const abi = opts.abi !== false;
	const cells = [];

	for (let i = 0; i < 32; i++) {
		const b = blinks ? blinks[i] : null;
		let mark = ' ';
		if (b) {
			if (b.level >= 1) mark = '!';
			else if (b.level > 0) mark = '*';
			else if (b.read) mark = ':';
		}
		if (opts.only === 'active' && mark === ' ') continue;
		const name = abi ? ABI_NAMES[i] : `x${i}`;
		let cell = `${padStart(name, 4)}${mark} ${hex32(s.regs[i].value).slice(2)}`;
		if (opts.showWrites) cell += ` w${padStart(s.regs[i].writes, 3)}`;
		cells.push(cell);
	}

	const lines = [];
	for (let i = 0; i < cells.length; i += columns)
		lines.push(cells.slice(i, i + columns).join('  '));
	return lines.join('\n');
}

/**
 * Reconstruct per-instruction stage occupancy from a sequence of snapshots —
 * the data behind the reservation table.
 *
 * Only X and M are attributed to instructions. Fetch deliberately is not: the
 * front end runs a prefetch FIFO ahead of the pipeline, so "which fetch cycle
 * belongs to which instruction" has no single honest answer, and inventing one
 * would teach a fiction. Stalled cycles are distinguished from issuing ones,
 * which is what makes a bubble visible as a bubble.
 *
 * @param {any[]} snapshots contiguous, oldest first
 * @returns {{rows:{pc:number, instr:number, cells:Map<number,string>}[], cycles:number[], warnings:string[]}}
 */
export function buildTimeline(snapshots) {
	const rows = [];
	const cycles = [];
	const warnings = [];

	let current = null;   // instruction occupying X
	let inM = null;       // instruction occupying M
	let prev = null;

	for (const s of snapshots) {
		cycles.push(s.cycle);

		// M advances on the same condition the hardware uses: unless M is
		// stalled, it takes whatever X issued last cycle (or a bubble).
		if (prev && !prev.m.stall) {
			inM = prev.x.issue ? prev.owner : null;
		}
		if (s.m.valid && inM && inM.pc !== s.m.pc) {
			warnings.push(`cycle ${s.cycle}: M shows ${hex32(s.m.pc)}, expected ${hex32(inM.pc)}`);
		}
		if (s.m.valid && !inM) {
			warnings.push(`cycle ${s.cycle}: M is occupied but no instruction was tracked into it`);
		}

		let owner = null;
		if (s.x.valid) {
			// A new instruction is in X if the slot was empty, the PC changed, or
			// the previous occupant issued and moved on.
			const isNew = !current || current.pc !== s.x.pc || current.done;
			if (isNew) {
				current = { pc: s.x.pc, instr: s.x.instr, cells: new Map(), done: false };
				rows.push(current);
			}
			current.cells.set(s.cycle, s.x.stall ? 'x' : 'X');
			owner = current;
			if (s.x.issue) current.done = true;
		} else {
			current = null;
		}

		if (inM) inM.cells.set(s.cycle, s.m.stall ? 'm' : 'M');

		prev = { ...s, owner };
	}

	return { rows, cycles, warnings };
}

/**
 * The reservation table: instructions down the page, cycles across it. The
 * clearest way to see a stall push everything behind it.
 *
 * @param {any[]} snapshots
 * @param {{abi?:boolean, maxRows?:number}} [opts]
 * @returns {string}
 */
export function renderTimeline(snapshots, opts = {}) {
	const { rows, cycles, warnings } = buildTimeline(snapshots);
	if (!rows.length) return '(no instructions in this window)';

	const shown = opts.maxRows ? rows.slice(0, opts.maxRows) : rows;
	const label = (r) => `${hex32(r.pc)}  ${pad(disasm(r.instr, r.pc, { abi: opts.abi !== false }), 22)}`;
	const width = Math.max(...shown.map((r) => label(r).length));

	const lines = [];
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

/**
 * One line per cycle, for eyeballing a long run.
 *
 * @param {any} s snapshot
 * @param {{abi?:boolean}} [opts]
 * @returns {string}
 */
export function renderCycleLine(s, opts = {}) {
	const abi = opts.abi !== false;
	const x = s.x.valid ? disasm(s.x.instr, s.x.pc, { abi }) : '-';
	const stall = s.x.stall ? ` [${s.x.stallReason}]` : '';
	const wb = s.m.regWen ? `  ${regName(s.m.rd, abi)}<=${hex32(s.m.result)}` : '';
	return `${padStart(s.cycle, 7)}  ${hex32(s.x.pc)}  ${pad(x, 24)}${stall}${wb}`;
}

/**
 * Everything at once: pipeline, active stall causes, registers.
 *
 * @param {any} s
 * @param {import('./blink.mjs').RegBlink[]} [blinks]
 * @param {{abi?:boolean}} [opts]
 */
export function renderFrame(s, blinks = null, opts = {}) {
	const parts = [renderPipeline(s, opts)];
	const causes = stallCauses(s.x.stallCause);
	if (causes.length)
		parts.push('  why: ' + causes.map((c) => c.label).join(', '));
	parts.push('');
	parts.push(renderRegisters(s, blinks, opts));
	return parts.join('\n');
}
