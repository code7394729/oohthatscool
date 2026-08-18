/**
 * snapshot.ts — the shape of the state the simulator hands out.
 *
 * A direct transcription of `struct Snapshot` in sim/snapshot.h, which is the
 * authority. If the two ever disagree the JSON will still parse and everything
 * downstream will quietly read `undefined`, so the test runner asserts the
 * field set against a live snapshot rather than trusting this file.
 *
 * Timing convention (see sim/snapshot.h for the full note): a snapshot with
 * `cycle === N` describes the machine between posedges — `regs` hold everything
 * committed by the N posedges so far, and the stage fields describe what F / X
 * / M are doing *now*. A register write committed at posedge N is reported with
 * `lastWriteCycle === N`, the same cycle its new value appears in
 * `regs[rd].value`.
 */

/** Which source the operand mux in X selected (sim/snapshot.h, enum Bypass). */
export const Bypass = {
	None: 0,
	Regfile: 1,
	/** Forwarded from the X|M register. */
	M: 2,
	/** Forwarded from the M|W register. */
	W: 3,
} as const;
export type BypassCode = (typeof Bypass)[keyof typeof Bypass];

/** Bitmap of why execute is stalled; several bits can be set at once. */
export const Stall = {
	MStall: 1 << 0,
	Raw: 1 << 1,
	Muldiv: 1 << 2,
	Fence: 1 << 3,
	BusAphase: 1 << 4,
	Jump: 1 << 5,
	Starved: 1 << 6,
} as const;

/** Hazard3's "not a load or store" memory-op encoding. */
export const MEMOP_NONE = 0x10;

/** `lastWriteCycle` / `lastReadCycle` when it has never happened. */
export const NEVER = -1;

export interface StageF {
	pc: number;
	/** The F|X pipeline register — the instruction word itself. */
	cir: number;
	cirVld: number;
	is32bit: boolean;
	jumpReq: boolean;
	jumpRdy: boolean;
	jumpTarget: number;
}

export interface StageX {
	pc: number;
	instr: number;
	/** An instruction is present (the front end is not starved). */
	valid: boolean;
	/** ...and it advances to M at this posedge. */
	issue: boolean;
	rs1: number;
	rs2: number;
	rd: number;
	imm: number;
	aluOp: number;
	memOp: number;
	mulOp: number;
	branchCond: number;
	/** Post-bypass ALU inputs. */
	opA: number;
	opB: number;
	aluResult: number;
	/** The value the bypass network selected, before the operand mux. */
	rs1Bypass: number;
	rs2Bypass: number;
	bypassA: BypassCode;
	bypassB: BypassCode;
	jumpReq: boolean;
	stall: boolean;
	stallCause: number;
	/** Name of the highest-priority set bit; matches decode.stallReasonName(). */
	stallReason: string;
	starved: boolean;
	csrRen: boolean;
	csrWen: boolean;
	csrRdata: number;
	except: number;
}

export interface StageM {
	/** M holds a real instruction rather than a bubble (a probe-added signal). */
	valid: boolean;
	pc: number;
	instr: number;
	rd: number;
	/** Writeback data: load data or ALU result, after the result mux. */
	result: number;
	/** The X|M latched ALU result, which is also the M-stage forwarding source. */
	xmResult: number;
	memOp: number;
	stall: boolean;
	busStall: boolean;
	dphaseInFlight: boolean;
	/** A register write commits at this posedge — the update-indication source. */
	regWen: boolean;
	trapEnter: boolean;
	trapIsIrq: boolean;
	trapAddr: number;
	except: number;
}

export interface RegView {
	value: number;
	/**
	 * Monotonic count of architectural writes, from the core's write strobe.
	 * Increments on every write whether or not the value changed — see
	 * sim/tracker.h for why that matters.
	 */
	writes: number;
	lastWriteCycle: number;
	lastReadCycle: number;
}

export interface CsrView {
	mcycle: number;
	minstret: number;
	mepc: number;
	mtvec: number;
	mcause: number;
	mstatus: number;
}

export interface BusView {
	/** The core's two internal request streams, before the single-port arbiter. */
	iReq: boolean;
	iAddr: number;
	iDphReady: boolean;
	dReq: boolean;
	dAddr: number;
	dWrite: boolean;
	dWdata: number;
	dRdata: number;
	dDphReady: boolean;
	/** The muxed AHB5 port as the SoC sees it. */
	haddr: number;
	htrans: number;
	hwrite: boolean;
	hsize: number;
}

export interface Snapshot {
	cycle: number;
	/** Instructions issued from X — the core's own count, matching minstret. */
	retired: number;
	exited: boolean;
	exitCode: number;
	f: StageF;
	x: StageX;
	m: StageM;
	/** Always 32 entries, indexed by register number. */
	regs: RegView[];
	csr: CsrView;
	bus: BusView;
}

/** Why a run() or stepInstruction() call stopped. */
export type StopReason = 'cycles' | 'exit' | 'breakpoint' | 'retired' | 'fault';

export interface RunResult {
	reason: StopReason;
	cycles: number;
	retired: number;
}

/** A $finish / $stop / $fatal raised inside the Verilated model. */
export interface SimFault {
	kind: 'finish' | 'stop' | 'fatal';
	file: string;
	line: number;
	hier: string;
	message: string;
}

export interface MemoryMap {
	memBase: number;
	memSize: number;
	ioBase: number;
	ioPrintChar: number;
	ioPrintU32: number;
	ioExit: number;
	noBreak: number;
}

/**
 * Field-by-field check that a parsed object really is a Snapshot. Used by the
 * test runner against a live snapshot, so a change to sim/snapshot.h that this
 * file has not caught up with fails loudly instead of surfacing as undefined
 * somewhere in the UI.
 */
export function snapshotShapeProblems(value: unknown): string[] {
	const problems: string[] = [];
	const s = value as Record<string, unknown>;
	if (typeof s !== 'object' || s === null) return ['not an object'];

	const want = (path: string, v: unknown, type: 'number' | 'boolean' | 'string') => {
		if (typeof v !== type) problems.push(`${path}: expected ${type}, got ${typeof v}`);
	};

	want('cycle', s['cycle'], 'number');
	want('retired', s['retired'], 'number');
	want('exited', s['exited'], 'boolean');
	want('exitCode', s['exitCode'], 'number');

	const group = (name: string, keys: Record<string, 'number' | 'boolean' | 'string'>) => {
		const g = s[name] as Record<string, unknown> | undefined;
		if (!g) { problems.push(`${name}: missing`); return; }
		for (const [k, t] of Object.entries(keys)) want(`${name}.${k}`, g[k], t);
	};

	group('f', {
		pc: 'number', cir: 'number', cirVld: 'number', is32bit: 'boolean',
		jumpReq: 'boolean', jumpRdy: 'boolean', jumpTarget: 'number',
	});
	group('x', {
		pc: 'number', instr: 'number', valid: 'boolean', issue: 'boolean',
		rs1: 'number', rs2: 'number', rd: 'number', imm: 'number',
		aluOp: 'number', memOp: 'number', mulOp: 'number', branchCond: 'number',
		opA: 'number', opB: 'number', aluResult: 'number',
		rs1Bypass: 'number', rs2Bypass: 'number', bypassA: 'number', bypassB: 'number',
		jumpReq: 'boolean', stall: 'boolean', stallCause: 'number',
		stallReason: 'string', starved: 'boolean', csrRen: 'boolean', csrWen: 'boolean',
		csrRdata: 'number', except: 'number',
	});
	group('m', {
		valid: 'boolean', pc: 'number', instr: 'number', rd: 'number',
		result: 'number', xmResult: 'number', memOp: 'number', stall: 'boolean',
		busStall: 'boolean', dphaseInFlight: 'boolean', regWen: 'boolean',
		trapEnter: 'boolean', trapIsIrq: 'boolean', trapAddr: 'number', except: 'number',
	});
	group('csr', {
		mcycle: 'number', minstret: 'number', mepc: 'number',
		mtvec: 'number', mcause: 'number', mstatus: 'number',
	});
	group('bus', {
		iReq: 'boolean', iAddr: 'number', iDphReady: 'boolean',
		dReq: 'boolean', dAddr: 'number', dWrite: 'boolean', dWdata: 'number',
		dRdata: 'number', dDphReady: 'boolean',
		haddr: 'number', htrans: 'number', hwrite: 'boolean', hsize: 'number',
	});

	const regs = s['regs'];
	if (!Array.isArray(regs)) problems.push('regs: expected an array');
	else if (regs.length !== 32) problems.push(`regs: expected 32 entries, got ${regs.length}`);
	else {
		const r = regs[0] as Record<string, unknown>;
		for (const k of ['value', 'writes', 'lastWriteCycle', 'lastReadCycle'])
			want(`regs[0].${k}`, r[k], 'number');
	}

	return problems;
}
