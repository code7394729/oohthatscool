/**
 * trace.ts — recorded snapshot traces.
 *
 * `hz3_sim --trace out.jsonl` writes one snapshot per line, in the same format
 * the WASM bridge produces. Replaying such a file gives the UI layers a real,
 * cycle-accurate data source with no simulator attached: the reservation table,
 * the blink policy and the datapath renderer can all be developed and regression
 * tested against a checked-in trace, and a failure can be reproduced from a file
 * instead of a sequence of clicks.
 *
 * Everything here is pure. Reading a file is the caller's business (see
 * src/cli/hz3.ts), which keeps this module loadable in the browser.
 */

import type { Snapshot } from './snapshot.js';

/** @param text JSONL, one snapshot per line. */
export function parseTrace(text: string): Snapshot[] {
	const out: Snapshot[] = [];
	for (const line of text.split('\n')) {
		const s = line.trim();
		if (s) out.push(JSON.parse(s) as Snapshot);
	}
	return out;
}

/**
 * Sanity-check a trace before anything trusts it. Cheap, and it turns "the
 * chart looks wrong" into a specific complaint about a specific cycle.
 *
 * @returns problems found; empty means the trace is consistent
 */
export function validateTrace(snapshots: Snapshot[]): string[] {
	const problems: string[] = [];
	let prev: Snapshot | null = null;
	for (const s of snapshots) {
		if (typeof s.cycle !== 'number') { problems.push('snapshot without a cycle'); break; }
		if (!Array.isArray(s.regs) || s.regs.length !== 32)
			problems.push(`cycle ${s.cycle}: expected 32 registers`);
		if (prev) {
			if (s.cycle !== prev.cycle + 1)
				problems.push(`cycle ${s.cycle}: follows ${prev.cycle}, expected a contiguous trace`);
			if (s.retired < prev.retired)
				problems.push(`cycle ${s.cycle}: retire count went backwards`);
			for (let i = 0; i < 32; i++) {
				const now = s.regs[i], before = prev.regs[i];
				if (now && before && now.writes < before.writes)
					problems.push(`cycle ${s.cycle}: x${i} write count went backwards`);
			}
		}
		prev = s;
	}
	return problems;
}

export interface WriteEvent {
	cycle: number;
	value: number;
	writes: number;
}

/**
 * Every cycle at which a given register was written, from a trace. The write
 * count is what makes this exact: repeated writes of an unchanged value are
 * counted, which is precisely the case a value diff would miss.
 */
export function writeEvents(snapshots: Snapshot[], reg: number): WriteEvent[] {
	const out: WriteEvent[] = [];
	let prevWrites: number | null = null;
	for (const s of snapshots) {
		const r = s.regs[reg];
		if (!r) continue;
		if (prevWrites !== null && r.writes > prevWrites)
			out.push({ cycle: s.cycle, value: r.value, writes: r.writes });
		prevWrites = r.writes;
	}
	return out;
}
