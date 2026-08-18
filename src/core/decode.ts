/**
 * decode.ts — names for the raw encodings a snapshot carries, and a small
 * RV32IM disassembler.
 *
 * The snapshot deliberately ships the core's own encodings (`aluOp`, `memOp`,
 * `stallCause`, `bypassA`) rather than prose, so the seam stays narrow and the
 * simulator stays free of presentation decisions. This file is where those
 * numbers become words. It is pure — no DOM, no WASM — so it can be tested on
 * literals and reused by the SVG renderer, the reservation table and the CLI
 * alike.
 *
 * STALL_BITS and BYPASS_NAMES mirror constants defined in rtl/hz3_probe.vh and
 * sim/snapshot.h. The test runner checks the stall table against the string the
 * C++ side emits, so the two cannot drift apart silently.
 */

import { Bypass, Stall, type BypassCode } from './snapshot.js';

export interface StallBit {
	bit: number;
	id: string;
	label: string;
	blurb: string;
}

/** Bit positions of the stall-cause bitmap, LSB first. */
export const STALL_BITS: readonly StallBit[] = Object.freeze([
	{
		bit: Stall.MStall, id: 'downstream-m', label: 'M stage busy',
		blurb: 'The memory/writeback stage cannot accept a new instruction.',
	},
	{
		bit: Stall.Raw, id: 'load-use', label: 'load-use interlock',
		blurb: 'The next instruction needs a load result that has not arrived yet — the one hazard forwarding cannot fix.',
	},
	{
		bit: Stall.Muldiv, id: 'muldiv', label: 'multiply/divide',
		blurb: 'The sequential multiply/divide unit is still working; execute waits for it.',
	},
	{
		bit: Stall.Fence, id: 'fence', label: 'fence',
		blurb: 'Waiting for outstanding memory accesses to complete.',
	},
	{
		bit: Stall.BusAphase, id: 'bus-address-phase', label: 'bus busy',
		blurb: 'The load/store address phase has not been accepted by the bus.',
	},
	{
		bit: Stall.Jump, id: 'jump-not-ready', label: 'jump not accepted',
		blurb: 'The front end is not ready to take the new program counter.',
	},
	{
		bit: Stall.Starved, id: 'starved', label: 'no instruction',
		blurb: 'The front end has not delivered an instruction — usually the shadow of a taken branch.',
	},
]);

/**
 * Ranking used when only one reason can be shown. Matches
 * hz3::stallReasonName() in sim/snapshot.h: the most specific, most
 * teachable cause wins over the generic downstream ones.
 */
const STALL_PRIORITY = [
	'load-use', 'muldiv', 'bus-address-phase', 'fence',
	'jump-not-ready', 'downstream-m', 'starved',
];

/** The same string the C++ side puts in `stallReason`. */
export function stallReasonName(cause: number): string {
	if (!cause) return 'none';
	for (const id of STALL_PRIORITY) {
		const entry = STALL_BITS.find((e) => e.id === id);
		if (entry && (cause & entry.bit)) return id;
	}
	return 'unknown';
}

/**
 * Every cause currently asserted, not just the top one — several can be true
 * at once, and seeing that is often the explanation.
 */
export function stallCauses(cause: number): StallBit[] {
	return STALL_BITS.filter((e) => (cause & e.bit) !== 0);
}

/** Operand source selected by the bypass network (sim/snapshot.h, enum Bypass). */
export const BYPASS_NAMES = Object.freeze(['none', 'regfile', 'M', 'W'] as const);

export const BYPASS_LABELS: Readonly<Record<string, string>> = Object.freeze({
	none: 'no register operand',
	regfile: 'read from the register file',
	M: 'forwarded from the memory stage',
	W: 'forwarded from writeback',
});

export function bypassName(b: BypassCode | number): string {
	return BYPASS_NAMES[b as number] ?? 'unknown';
}

/** Hazard3 memory-op encoding (hazard3_ops.vh). */
export const MEMOP_NAMES: Readonly<Record<number, string>> = Object.freeze({
	0x00: 'lw', 0x01: 'lh', 0x02: 'lb', 0x03: 'lhu', 0x04: 'lbu',
	0x05: 'sw', 0x06: 'sh', 0x07: 'sb',
	0x08: 'lr.w', 0x09: 'sc.w', 0x0a: 'amo',
	0x10: 'none',
});

export { MEMOP_NONE } from './snapshot.js';

export function memOpName(m: number): string {
	return MEMOP_NAMES[m] ?? `0x${m.toString(16)}`;
}

export function memOpIsLoad(m: number): boolean {
	return m <= 0x04;
}

export function memOpIsStore(m: number): boolean {
	return m >= 0x05 && m <= 0x07;
}

/** Hazard3 ALU-op encoding, restricted to what an RV32IM build can produce. */
export const ALUOP_NAMES: Readonly<Record<number, string>> = Object.freeze({
	0x00: 'add', 0x01: 'sub', 0x02: 'lt', 0x04: 'ltu', 0x06: 'and',
	0x07: 'or', 0x08: 'xor', 0x09: 'srl', 0x0a: 'sra', 0x0b: 'sll',
	0x0c: 'muldiv', 0x0d: 'rs2',
});

export function aluOpName(a: number): string {
	return ALUOP_NAMES[a] ?? `0x${a.toString(16)}`;
}

/** Sequential multiply/divide operation (hazard3_ops.vh, M_OP_*). */
export const MULOP_NAMES: Readonly<Record<number, string>> = Object.freeze({
	0: 'mul', 1: 'mulh', 2: 'mulhsu', 3: 'mulhu',
	4: 'div', 5: 'divu', 6: 'rem', 7: 'remu',
});

export function mulOpName(m: number): string {
	return MULOP_NAMES[m] ?? `0x${m.toString(16)}`;
}

// ---------------------------------------------------------------------------
// Registers

export const ABI_NAMES: readonly string[] = Object.freeze([
	'zero', 'ra', 'sp', 'gp', 'tp', 't0', 't1', 't2',
	's0', 's1', 'a0', 'a1', 'a2', 'a3', 'a4', 'a5',
	'a6', 'a7', 's2', 's3', 's4', 's5', 's6', 's7',
	's8', 's9', 's10', 's11', 't3', 't4', 't5', 't6',
]);

export function regName(n: number, abi = true): string {
	return abi ? (ABI_NAMES[n] ?? `x${n}`) : `x${n}`;
}

// ---------------------------------------------------------------------------
// Disassembly
//
// Keyed on the instruction word alone. The snapshot also carries what the core
// itself decoded (aluOp / memOp / rd / rs1 / rs2), so a caller that wants to be
// certain can cross-check the two — if they ever disagree, the disassembler is
// what is wrong, not the hardware.

const BRANCH: (string | null)[] = ['beq', 'bne', null, null, 'blt', 'bge', 'bltu', 'bgeu'];
const LOAD: (string | null)[] = ['lb', 'lh', 'lw', null, 'lbu', 'lhu'];
const STORE: (string | null)[] = ['sb', 'sh', 'sw'];
const OPIMM: (string | null)[] = ['addi', 'slli', 'slti', 'sltiu', 'xori', null, 'ori', 'andi'];
const OP: string[] = ['add', 'sll', 'slt', 'sltu', 'xor', 'srl', 'or', 'and'];
const MULDIV: string[] = ['mul', 'mulh', 'mulhsu', 'mulhu', 'div', 'divu', 'rem', 'remu'];
const CSR_OPS: Record<number, string> = {
	1: 'csrrw', 2: 'csrrs', 3: 'csrrc', 5: 'csrrwi', 6: 'csrrsi', 7: 'csrrci',
};

const CSR_NAMES: Readonly<Record<number, string>> = Object.freeze({
	0x300: 'mstatus', 0x304: 'mie', 0x305: 'mtvec', 0x320: 'mcountinhibit',
	0x340: 'mscratch', 0x341: 'mepc', 0x342: 'mcause', 0x343: 'mtval',
	0x344: 'mip', 0xb00: 'mcycle', 0xb02: 'minstret',
	0xf11: 'mvendorid', 0xf12: 'marchid', 0xf13: 'mimpid', 0xf14: 'mhartid',
});

const sx = (v: number, bits: number): number => (v << (32 - bits)) >> (32 - bits);
const hex = (v: number): string => (v < 0 ? '-0x' + (-v).toString(16) : '0x' + v.toString(16));

export interface DisasmOptions {
	/** Use ABI register names (a0, sp) rather than x10, x2. */
	abi?: boolean;
}

/**
 * Disassemble one RV32IM instruction.
 *
 * @param word the 32-bit instruction
 * @param pc   its address, used to resolve branch and jump targets
 */
export function disasm(word: number, pc = 0, opts: DisasmOptions = {}): string {
	const abi = opts.abi !== false;
	const r = (n: number) => regName(n, abi);

	const w = word >>> 0;
	const op = w & 0x7f;
	const rd = (w >>> 7) & 0x1f;
	const f3 = (w >>> 12) & 7;
	const rs1 = (w >>> 15) & 0x1f;
	const rs2 = (w >>> 20) & 0x1f;
	const f7 = w >>> 25;

	const iImm = sx(w >>> 20, 12);
	const sImm = sx((((w >>> 25) & 0x7f) << 5) | ((w >>> 7) & 0x1f), 12);
	const bImm = sx(
		((w >>> 31) << 12) | (((w >>> 7) & 1) << 11) |
		(((w >>> 25) & 0x3f) << 5) | (((w >>> 8) & 0xf) << 1), 13);
	const jImm = sx(
		((w >>> 31) << 20) | (((w >>> 12) & 0xff) << 12) |
		(((w >>> 20) & 1) << 11) | (((w >>> 21) & 0x3ff) << 1), 21);
	const uImm = w & 0xfffff000;

	switch (op) {
	case 0x37: return `lui ${r(rd)}, ${hex(uImm >>> 12)}`;
	case 0x17: return `auipc ${r(rd)}, ${hex(uImm >>> 12)}`;
	case 0x6f:
		return rd === 0
			? `j ${hex((pc + jImm) >>> 0)}`
			: `jal ${r(rd)}, ${hex((pc + jImm) >>> 0)}`;
	case 0x67:
		if (rd === 0 && rs1 === 1 && iImm === 0) return 'ret';
		return `jalr ${r(rd)}, ${iImm}(${r(rs1)})`;
	case 0x63: {
		const m = BRANCH[f3];
		if (!m) break;
		if (rs2 === 0 && m === 'beq') return `beqz ${r(rs1)}, ${hex((pc + bImm) >>> 0)}`;
		if (rs2 === 0 && m === 'bne') return `bnez ${r(rs1)}, ${hex((pc + bImm) >>> 0)}`;
		return `${m} ${r(rs1)}, ${r(rs2)}, ${hex((pc + bImm) >>> 0)}`;
	}
	case 0x03: {
		const m = LOAD[f3];
		if (!m) break;
		return `${m} ${r(rd)}, ${iImm}(${r(rs1)})`;
	}
	case 0x23: {
		const m = STORE[f3];
		if (!m) break;
		return `${m} ${r(rs2)}, ${sImm}(${r(rs1)})`;
	}
	case 0x13: {
		if (w === 0x13) return 'nop';
		if (f3 === 0 && rs1 === 0) return `li ${r(rd)}, ${iImm}`;
		if (f3 === 0 && iImm === 0) return `mv ${r(rd)}, ${r(rs1)}`;
		if (f3 === 1) return `slli ${r(rd)}, ${r(rs1)}, ${rs2}`;
		if (f3 === 5) return `${f7 & 0x20 ? 'srai' : 'srli'} ${r(rd)}, ${r(rs1)}, ${rs2}`;
		const m = OPIMM[f3];
		if (!m) break;
		return `${m} ${r(rd)}, ${r(rs1)}, ${iImm}`;
	}
	case 0x33: {
		if (f7 === 0x01) return `${MULDIV[f3]} ${r(rd)}, ${r(rs1)}, ${r(rs2)}`;
		if (f7 === 0x20) return `${f3 === 0 ? 'sub' : 'sra'} ${r(rd)}, ${r(rs1)}, ${r(rs2)}`;
		return `${OP[f3]} ${r(rd)}, ${r(rs1)}, ${r(rs2)}`;
	}
	case 0x0f: return f3 === 1 ? 'fence.i' : 'fence';
	case 0x73: {
		if (w === 0x00000073) return 'ecall';
		if (w === 0x00100073) return 'ebreak';
		if (w === 0x30200073) return 'mret';
		const m = CSR_OPS[f3];
		if (!m) break;
		const csr = (w >>> 20) & 0xfff;
		const name = CSR_NAMES[csr] ?? hex(csr);
		return f3 >= 5
			? `${m} ${r(rd)}, ${name}, ${rs1}`
			: `${m} ${r(rd)}, ${name}, ${r(rs1)}`;
	}
	default: break;
	}
	return `.word ${hex(w)}`;
}

export function hex32(v: number, width = 8): string {
	return '0x' + (v >>> 0).toString(16).padStart(width, '0');
}

/** Signed interpretation of a 32-bit word, for the register panel's toggle. */
export function asSigned(v: number): number {
	return v | 0;
}

export { Bypass };
