/**
 * timeline.ts — per-instruction stage occupancy, reconstructed from a sequence
 * of snapshots. The data behind the reservation table.
 *
 * Only X and M are attributed to instructions. Fetch deliberately is not: the
 * front end runs a prefetch FIFO ahead of the pipeline, so "which fetch cycle
 * belongs to which instruction" has no single honest answer, and inventing one
 * would teach a fiction. Stalled cycles are distinguished from issuing ones,
 * which is what makes a bubble visible as a bubble.
 *
 * This re-derives, independently, the same thing the probe's X|M shadow
 * registers track in RTL — so when the two disagree, something is wrong and
 * `warnings` says where. The test runner asserts it stays empty over real runs.
 */

import { hex32 } from './decode.js';
import type { Snapshot } from './snapshot.js';

/** What an instruction was doing in a given cycle. */
export type Occupancy =
	| 'X'  // in execute, issuing this cycle
	| 'x'  // in execute, stalled
	| 'M'  // in memory/writeback
	| 'm'; // in M, stalled

export interface TimelineRow {
	pc: number;
	instr: number;
	/** cycle -> what this instruction was doing then. */
	cells: Map<number, Occupancy>;
	/** First and last cycle this instruction appears, for windowing. */
	firstCycle: number;
	lastCycle: number;
}

export interface Timeline {
	rows: TimelineRow[];
	cycles: number[];
	warnings: string[];
}

interface Tracked extends TimelineRow {
	done: boolean;
}

/** @param snapshots contiguous, oldest first */
export function buildTimeline(snapshots: Snapshot[]): Timeline {
	const rows: Tracked[] = [];
	const cycles: number[] = [];
	const warnings: string[] = [];

	let current: Tracked | null = null;   // instruction occupying X
	let inM: Tracked | null = null;       // instruction occupying M
	let prev: { snap: Snapshot; owner: Tracked | null } | null = null;

	const touch = (row: Tracked, cycle: number, what: Occupancy) => {
		row.cells.set(cycle, what);
		row.lastCycle = cycle;
	};

	for (const s of snapshots) {
		cycles.push(s.cycle);

		// M advances on the same condition the hardware uses: unless M is
		// stalled, it takes whatever X issued last cycle (or a bubble).
		if (prev && !prev.snap.m.stall) {
			inM = prev.snap.x.issue ? prev.owner : null;
		}
		if (s.m.valid && inM && inM.pc !== s.m.pc)
			warnings.push(`cycle ${s.cycle}: M shows ${hex32(s.m.pc)}, expected ${hex32(inM.pc)}`);
		if (s.m.valid && !inM)
			warnings.push(`cycle ${s.cycle}: M is occupied but no instruction was tracked into it`);

		let owner: Tracked | null = null;
		if (s.x.valid) {
			// A new instruction is in X if the slot was empty, the PC changed, or
			// the previous occupant issued and moved on.
			if (!current || current.pc !== s.x.pc || current.done) {
				current = {
					pc: s.x.pc, instr: s.x.instr, cells: new Map(),
					firstCycle: s.cycle, lastCycle: s.cycle, done: false,
				};
				rows.push(current);
			}
			touch(current, s.cycle, s.x.stall ? 'x' : 'X');
			owner = current;
			if (s.x.issue) current.done = true;
		} else {
			current = null;
		}

		if (inM) touch(inM, s.cycle, s.m.stall ? 'm' : 'M');

		prev = { snap: s, owner };
	}

	return { rows, cycles, warnings };
}
