/**
 * blink.ts — turning register write events into something a student can see.
 *
 * THE PROBLEM
 *
 * The UI paints at whatever rate the browser gives it; the core runs at
 * whatever rate the simulator gives it. Those are wildly different clocks, and
 * a register update is a single-cycle event. Three failure modes follow, and
 * each is handled by a different field below:
 *
 *  1. A write whose value happens to match what was already there.
 *     `add x5, x0, x0` into an already-zero x5, or a loop counter reloaded
 *     with the same bound every pass. Diffing values against the previous
 *     frame shows nothing, so the register sits dark while the hardware is
 *     demonstrably writing it. Handled by taking `writes` — a monotonic
 *     counter fed from the core's write strobe (see sim/tracker.h) — as the
 *     only source of truth about whether a write happened.
 *
 *  2. A write that is over before it can be drawn.
 *     Single-stepping, the write lands and the next frame is 16 ms later; a
 *     one-frame flash is easy to miss, and once several registers are being
 *     touched there is no way to tell which was most recent. Handled by
 *     `level`, a decay ramp computed from how many *core cycles* ago the
 *     write happened, so the highlight persists across the following few
 *     cycles and fades in recency order.
 *
 *  3. Writes that repeat faster than the display.
 *     A register written on consecutive cycles never leaves the top of the
 *     decay ramp, so a fade alone renders as a constant, static glow — the
 *     one case where "it is being written constantly" looks exactly like
 *     "nothing is happening". And in run mode, thousands of cycles pass
 *     between frames, so age-based decay says nothing useful at all.
 *     Handled by `key`/`parity`, which change on *every* write and give the
 *     renderer something to restart an animation from, and by `writesDelta`,
 *     which reports how many writes occurred since the previous frame
 *     regardless of how much simulated time that frame covered.
 *
 * Nothing in this file touches the DOM, imports the simulator, or reads a
 * clock. It is a pure function of (snapshot, previous snapshot's write counts),
 * so the rendering policy can be unit-tested and tuned on synthetic data.
 */

import { NEVER, type RegView } from './snapshot.js';

export interface BlinkOptions {
	/**
	 * Cycles over which a write highlight fades to nothing. Six is about right
	 * at one cycle per step: long enough to read, short enough that consecutive
	 * instructions stay distinguishable.
	 */
	decayCycles: number;
	/**
	 * Reads are re-asserted every cycle the instruction sits in X, so their tail
	 * is deliberately shorter.
	 */
	readDecayCycles: number;
}

export const DEFAULT_BLINK_OPTIONS: Readonly<BlinkOptions> = Object.freeze({
	decayCycles: 6,
	readDecayCycles: 2,
});

export { NEVER };

/**
 * Linear decay from 1 at age 0 to 0 at age >= span.
 *
 * @param age  cycles since the event
 * @param span cycles over which it fades
 */
export function decayLevel(age: number, span: number): number {
	if (!(span > 0)) return age === 0 ? 1 : 0;
	if (age < 0) return 0;
	if (age >= span) return 0;
	return 1 - age / span;
}

export interface RegBlink {
	/** Register number, 0..31. */
	index: number;
	value: number;
	/** Written since the previous frame, or recently enough to still be lit. */
	wrote: boolean;
	/** Architectural writes since the previous frame. */
	writesDelta: number;
	/** Lifetime write count, straight from the core's write strobe. */
	writes: number;
	/** Cycles since the last write, or null if never written. */
	ageCycles: number | null;
	/** 0..1 highlight intensity for the write. */
	level: number;
	/** Flips on every write — toggle an attribute to retrigger an animation. */
	parity: 0 | 1;
	/** Changes on every write — use as a keyed identity to restart one. */
	key: string;
	/** Being read by the instruction in execute this cycle. */
	read: boolean;
	readLevel: number;
}

/**
 * Highlight state for a single register.
 *
 * `prevWrites` is the lifetime write count as of the last frame *the viewer
 * actually saw*, which is what makes this correct in run mode: if 4000 cycles
 * elapsed and the register was written 12 times, the age-based ramp is
 * meaningless but `writesDelta` is 12 and the highlight goes to full. Pass null
 * for the first frame after a load or reset, when there is no previous frame
 * and nothing should be flagged as new.
 */
export function regBlink(
	reg: RegView,
	index: number,
	cycle: number,
	prevWrites: number | null,
	opts: BlinkOptions = DEFAULT_BLINK_OPTIONS,
): RegBlink {
	const writes = reg.writes;
	const writesDelta = prevWrites === null || prevWrites === undefined
		? 0
		: Math.max(0, writes - prevWrites);

	const everWritten = reg.lastWriteCycle !== NEVER;
	const ageCycles = everWritten ? cycle - reg.lastWriteCycle : null;

	// Two independent reasons to be lit, and the stronger one wins:
	//   - recency: the write is still inside its decay window
	//   - novelty: it happened since the viewer last looked, however long ago
	const byAge = ageCycles === null ? 0 : decayLevel(ageCycles, opts.decayCycles);
	const byDelta = writesDelta > 0 ? 1 : 0;
	const level = Math.max(byAge, byDelta);

	const everRead = reg.lastReadCycle !== NEVER;
	const readAge = everRead ? cycle - reg.lastReadCycle : null;
	const readLevel = readAge === null ? 0 : decayLevel(readAge, opts.readDecayCycles);

	return {
		index,
		value: reg.value,
		wrote: level > 0,
		writesDelta,
		writes,
		ageCycles,
		level,
		// Both derive from the write count, not from the value or the cycle, so
		// they change on every write and only on a write. A renderer that keys a
		// CSS animation off `key` gets a genuine re-blink even when a register is
		// written on ten consecutive cycles with the same data.
		parity: (writes & 1) as 0 | 1,
		key: `r${index}:${writes}`,
		read: readLevel > 0,
		readLevel,
	};
}

/**
 * Frame-to-frame blink state for the whole register file.
 *
 * Holds exactly one thing: the write counts as of the last frame handed to
 * update(). That is the minimum needed to answer "what changed since the
 * viewer last saw this", and it is what makes run mode work — the UI can skip
 * ten thousand cycles and still be told precisely which registers moved.
 */
export class BlinkTracker {
	readonly options: BlinkOptions;
	private prevWrites: number[] | null = null;
	private prevCycle = -1;

	constructor(opts: Partial<BlinkOptions> = {}) {
		this.options = { ...DEFAULT_BLINK_OPTIONS, ...opts };
	}

	/** Forget history, so the next frame reports nothing as new. */
	reset(): void {
		this.prevWrites = null;
		this.prevCycle = -1;
	}

	/** One entry per register, in register order. */
	update(snapshot: { cycle: number; regs: RegView[] }): RegBlink[] {
		const { cycle, regs } = snapshot;

		// A cycle count that went backwards means the machine was reset (or the
		// user scrubbed a trace); carrying write counts across that would light
		// up the whole file for one frame.
		if (cycle < this.prevCycle) this.reset();

		const prev = this.prevWrites;
		const out = regs.map((r, i) =>
			regBlink(r, i, cycle, prev ? (prev[i] ?? null) : null, this.options));

		this.prevWrites = regs.map((r) => r.writes);
		this.prevCycle = cycle;
		return out;
	}
}

/**
 * Registers worth drawing attention to this frame, brightest first. Handy when
 * space is tight — a status line, a narrow panel — and for asserting in tests.
 */
export function activeBlinks(blinks: RegBlink[]): RegBlink[] {
	return blinks
		.filter((b) => b.index !== 0 && b.level > 0)
		.sort((a, b) => b.level - a.level || a.index - b.index);
}
