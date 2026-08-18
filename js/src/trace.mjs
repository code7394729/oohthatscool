/**
 * trace.mjs — reading recorded snapshot traces.
 *
 * `hz3_sim --trace out.jsonl` writes one snapshot per line, in the same format
 * the WASM bridge produces. Replaying such a file gives the UI layers a real,
 * cycle-accurate data source with no simulator attached: the reservation table,
 * the blink policy and the datapath renderer can all be developed and regression
 * tested against a checked-in trace, and a failure can be reproduced from a file
 * instead of a sequence of clicks.
 *
 * The parsing half is pure. Only readTraceFile touches a filesystem, and it
 * imports node:fs lazily so this module stays loadable in a browser.
 */

/**
 * @param {string} text  JSONL, one snapshot per line
 * @returns {any[]}
 */
export function parseTrace(text) {
	const out = [];
	for (const line of text.split('\n')) {
		const s = line.trim();
		if (s) out.push(JSON.parse(s));
	}
	return out;
}

/**
 * @param {string} path
 * @returns {Promise<any[]>}
 */
export async function readTraceFile(path) {
	const { readFile } = await import('node:fs/promises');
	return parseTrace(await readFile(path, 'utf8'));
}

/**
 * Sanity-check a trace before anything trusts it. Cheap, and it turns "the
 * chart looks wrong" into a specific complaint about a specific cycle.
 *
 * @param {any[]} snapshots
 * @returns {string[]} problems found; empty means the trace is consistent
 */
export function validateTrace(snapshots) {
	const problems = [];
	let prev = null;
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
				if (s.regs[i].writes < prev.regs[i].writes)
					problems.push(`cycle ${s.cycle}: x${i} write count went backwards`);
			}
		}
		prev = s;
	}
	return problems;
}

/**
 * Every cycle at which a given register was written, from a trace. The write
 * count is what makes this exact: repeated writes of an unchanged value are
 * counted, which is precisely the case a value diff would miss.
 *
 * @param {any[]} snapshots
 * @param {number} reg
 * @returns {{cycle:number, value:number, writes:number}[]}
 */
export function writeEvents(snapshots, reg) {
	const out = [];
	let prevWrites = null;
	for (const s of snapshots) {
		const r = s.regs[reg];
		if (prevWrites !== null && r.writes > prevWrites)
			out.push({ cycle: s.cycle, value: r.value, writes: r.writes });
		prevWrites = r.writes;
	}
	return out;
}
