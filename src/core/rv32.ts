/**
 * rv32.ts — a small RV32IM assembler.
 *
 * The teaching examples are three to eight instructions each, engineered to
 * force one microarchitectural behaviour. Building them here rather than
 * shipping .bin fixtures means the browser page works with no RISC-V toolchain
 * anywhere in the picture, the program text sits next to the explanation of
 * what it demonstrates, and the same programs are available to the test runner.
 *
 * This is the TypeScript twin of sim/tests/rv32_asm.h, which does the same job
 * for the native tests.
 */

/** Register numbers by ABI name. */
export const X = Object.freeze({
	zero: 0, ra: 1, sp: 2, gp: 3, tp: 4,
	t0: 5, t1: 6, t2: 7,
	s0: 8, s1: 9,
	a0: 10, a1: 11, a2: 12, a3: 13, a4: 14, a5: 15, a6: 16, a7: 17,
	s2: 18, s3: 19, s4: 20, s5: 21, s6: 22, s7: 23, s8: 24, s9: 25, s10: 26, s11: 27,
	t3: 28, t4: 29, t5: 30, t6: 31,
});

export const CSR = Object.freeze({
	mstatus: 0x300, mtvec: 0x305, mcountinhibit: 0x320,
	mepc: 0x341, mcause: 0x342, mcycle: 0xb00, minstret: 0xb02,
});

// ---------------------------------------------------------------------------
// Encoding

const u = (v: number) => v >>> 0;

export const rType = (funct7: number, rs2: number, rs1: number, funct3: number, rd: number, opcode: number): number =>
	u((funct7 << 25) | (rs2 << 20) | (rs1 << 15) | (funct3 << 12) | (rd << 7) | opcode);

export const iType = (imm: number, rs1: number, funct3: number, rd: number, opcode: number): number =>
	u(((imm & 0xfff) << 20) | (rs1 << 15) | (funct3 << 12) | (rd << 7) | opcode);

export const sType = (imm: number, rs2: number, rs1: number, funct3: number, opcode: number): number =>
	u((((imm >> 5) & 0x7f) << 25) | (rs2 << 20) | (rs1 << 15) | (funct3 << 12) |
		((imm & 0x1f) << 7) | opcode);

export const bType = (imm: number, rs2: number, rs1: number, funct3: number, opcode: number): number =>
	u((((imm >> 12) & 1) << 31) | (((imm >> 5) & 0x3f) << 25) | (rs2 << 20) |
		(rs1 << 15) | (funct3 << 12) | (((imm >> 1) & 0xf) << 8) |
		(((imm >> 11) & 1) << 7) | opcode);

export const uType = (imm: number, rd: number, opcode: number): number =>
	u((imm & 0xfffff000) | (rd << 7) | opcode);

export const jType = (imm: number, rd: number, opcode: number): number =>
	u((((imm >> 20) & 1) << 31) | (((imm >> 1) & 0x3ff) << 21) |
		(((imm >> 11) & 1) << 20) | (((imm >> 12) & 0xff) << 12) |
		(rd << 7) | opcode);

export const addi = (rd: number, rs1: number, imm: number) => iType(imm, rs1, 0x0, rd, 0x13);
export const andi = (rd: number, rs1: number, imm: number) => iType(imm, rs1, 0x7, rd, 0x13);
export const ori = (rd: number, rs1: number, imm: number) => iType(imm, rs1, 0x6, rd, 0x13);
export const xori = (rd: number, rs1: number, imm: number) => iType(imm, rs1, 0x4, rd, 0x13);
export const slli = (rd: number, rs1: number, sh: number) => iType(sh, rs1, 0x1, rd, 0x13);
export const srli = (rd: number, rs1: number, sh: number) => iType(sh, rs1, 0x5, rd, 0x13);

export const add = (rd: number, rs1: number, rs2: number) => rType(0x00, rs2, rs1, 0x0, rd, 0x33);
export const sub = (rd: number, rs1: number, rs2: number) => rType(0x20, rs2, rs1, 0x0, rd, 0x33);
export const and_ = (rd: number, rs1: number, rs2: number) => rType(0x00, rs2, rs1, 0x7, rd, 0x33);
export const or_ = (rd: number, rs1: number, rs2: number) => rType(0x00, rs2, rs1, 0x6, rd, 0x33);
export const xor_ = (rd: number, rs1: number, rs2: number) => rType(0x00, rs2, rs1, 0x4, rd, 0x33);
export const sltu = (rd: number, rs1: number, rs2: number) => rType(0x00, rs2, rs1, 0x3, rd, 0x33);

export const mul = (rd: number, rs1: number, rs2: number) => rType(0x01, rs2, rs1, 0x0, rd, 0x33);
export const mulh = (rd: number, rs1: number, rs2: number) => rType(0x01, rs2, rs1, 0x1, rd, 0x33);
export const div = (rd: number, rs1: number, rs2: number) => rType(0x01, rs2, rs1, 0x4, rd, 0x33);
export const divu = (rd: number, rs1: number, rs2: number) => rType(0x01, rs2, rs1, 0x5, rd, 0x33);
export const remu = (rd: number, rs1: number, rs2: number) => rType(0x01, rs2, rs1, 0x7, rd, 0x33);

export const lui = (rd: number, imm20: number) => uType(imm20 << 12, rd, 0x37);
export const auipc = (rd: number, imm20: number) => uType(imm20 << 12, rd, 0x17);

export const lw = (rd: number, rs1: number, imm: number) => iType(imm, rs1, 0x2, rd, 0x03);
export const lbu = (rd: number, rs1: number, imm: number) => iType(imm, rs1, 0x4, rd, 0x03);
export const sw = (rs2: number, rs1: number, imm: number) => sType(imm, rs2, rs1, 0x2, 0x23);
export const sb = (rs2: number, rs1: number, imm: number) => sType(imm, rs2, rs1, 0x0, 0x23);

export const jalr = (rd: number, rs1: number, imm: number) => iType(imm, rs1, 0x0, rd, 0x67);

export const csrrw = (rd: number, csr: number, rs1: number) => iType(csr, rs1, 0x1, rd, 0x73);
export const csrrs = (rd: number, csr: number, rs1: number) => iType(csr, rs1, 0x2, rd, 0x73);
export const csrrwi = (rd: number, csr: number, uimm: number) => iType(csr, uimm, 0x5, rd, 0x73);

export const nop = () => addi(X.zero, X.zero, 0);
export const ecall = () => 0x00000073;

// ---------------------------------------------------------------------------
// Programs

/**
 * An instruction, or a function that produces one once label addresses are
 * known. The second form is what makes forward branches writable.
 */
export type Emitter = number | ((pc: number, labels: ReadonlyMap<string, number>) => number);

export interface AssembledProgram {
	base: number;
	words: number[];
	bytes: Uint8Array;
	/** Address of each label, for breakpoints and annotations. */
	labels: Map<string, number>;
	/** Address of each emitted instruction, in order. */
	addresses: number[];
}

/**
 * A program under construction.
 *
 * Two passes: the first fixes every instruction's address (each is four bytes,
 * since this build has no compressed instructions), the second resolves label
 * references. Small enough to read in one sitting, which matters because the
 * examples it builds are the curriculum.
 */
export class Program {
	readonly base: number;
	private items: Emitter[] = [];
	private pending = new Map<string, number>();

	constructor(base = 0x80000000) {
		this.base = base;
	}

	/** Address the next emitted instruction will occupy. */
	get pc(): number {
		return this.base + 4 * this.items.length;
	}

	label(name: string): this {
		this.pending.set(name, this.pc);
		return this;
	}

	add(...items: Emitter[]): this {
		this.items.push(...items);
		return this;
	}

	/** Branch to a label, resolved on assemble. */
	branch(kind: 'beq' | 'bne' | 'blt' | 'bge' | 'bltu' | 'bgeu', rs1: number, rs2: number, target: string): this {
		const f3 = { beq: 0, bne: 1, blt: 4, bge: 5, bltu: 6, bgeu: 7 }[kind];
		return this.add((pc, labels) => bType(requireLabel(labels, target) - pc, rs2, rs1, f3, 0x63));
	}

	jal(rd: number, target: string): this {
		return this.add((pc, labels) => jType(requireLabel(labels, target) - pc, rd, 0x6f));
	}

	/** Branch to self: a defined end for a program the UI keeps clocking. */
	park(): this {
		return this.add(bType(0, X.zero, X.zero, 0, 0x63));
	}

	assemble(): AssembledProgram {
		const labels = new Map(this.pending);
		const addresses = this.items.map((_, i) => this.base + 4 * i);
		const words = this.items.map((item, i) =>
			typeof item === 'function' ? u(item(addresses[i]!, labels)) : u(item));

		const bytes = new Uint8Array(words.length * 4);
		const view = new DataView(bytes.buffer);
		words.forEach((w, i) => view.setUint32(i * 4, w, true));

		return { base: this.base, words, bytes, labels, addresses };
	}
}

function requireLabel(labels: ReadonlyMap<string, number>, name: string): number {
	const addr = labels.get(name);
	if (addr === undefined) throw new Error(`undefined label '${name}'`);
	return addr;
}

/** Convenience for the common "a few instructions then park" shape. */
export function assemble(build: (p: Program) => void, base = 0x80000000): AssembledProgram {
	const p = new Program(base);
	build(p);
	return p.assemble();
}
