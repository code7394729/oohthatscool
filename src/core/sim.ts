/**
 * sim.ts — TypeScript wrapper around the WASM simulator.
 *
 * The only module in src/ that knows WASM exists. Everything else — blink
 * policy, decoding, the datapath model, the renderers — takes plain Snapshot
 * objects, so it runs and is tested without loading a 200 KB module.
 *
 * Environment-agnostic: the module is built with ENVIRONMENT=node,web, program
 * bytes are passed in by the caller rather than read from a filesystem, and
 * nothing here touches `document` or `window`. The browser and the Node CLI
 * load the identical artifact.
 */

import { hex32 } from './decode.js';
import type {
	MemoryMap, RunResult, SimFault, Snapshot,
} from './snapshot.js';
import type { EmbindSim, Hz3ModuleFactory, Hz3Runtime } from './wasm-module.js';

/**
 * Location of the built module, relative to this file's emitted location
 * (dist/core/sim.js), so it resolves to build/wasm/hz3.mjs from the repository
 * root under both Node and an HTTP server.
 */
export const DEFAULT_MODULE_URL = new URL('../../build/wasm/hz3.mjs', import.meta.url);

let runtimePromise: Promise<Hz3Runtime> | null = null;

/** Instantiate the Emscripten module (once per process/page). */
export async function loadRuntime(url: URL | string = DEFAULT_MODULE_URL): Promise<Hz3Runtime> {
	if (!runtimePromise) {
		const href = typeof url === 'string' ? url : url.href;
		runtimePromise = import(/* webpackIgnore: true */ href)
			.then((m: { default: Hz3ModuleFactory }) => m.default());
	}
	return runtimePromise;
}

/**
 * A running Hazard3.
 *
 * Thin by design: it drives the clock and hands back snapshots, and holds no
 * derived state of its own. Anything the UI wants to remember across frames
 * (blink history, a snapshot ring buffer for the reservation table) is the
 * UI's business, which keeps this object cheap to recreate and easy to fake in
 * a test.
 */
export class Hz3Sim {
	readonly map: MemoryMap;
	private sim: EmbindSim | null;

	constructor(runtime: Hz3Runtime) {
		this.sim = new runtime.Sim();
		this.map = runtime.Sim.memoryMap();
	}

	private get live(): EmbindSim {
		if (!this.sim) throw new Error('this Hz3Sim has been disposed');
		return this.sim;
	}

	/** Embind objects are not garbage collected; call this when finished. */
	dispose(): void {
		this.sim?.delete();
		this.sim = null;
	}

	/**
	 * @param bytes flat image
	 * @param addr  load address; defaults to the reset vector
	 */
	loadProgram(bytes: Uint8Array | number[], addr: number = this.map.memBase): void {
		this.live.loadProgram(bytes, addr >>> 0);
	}

	reset(): void { this.live.reset(); }

	stepCycle(): void { this.live.stepCycle(); }

	/** Advance until one more instruction retires. */
	stepInstruction(maxCycles = 10000): RunResult {
		return this.live.stepInstruction(maxCycles);
	}

	/** @param breakPC stop when this PC reaches execute; omit to disable. */
	run(maxCycles: number, breakPC: number = this.map.noBreak): RunResult {
		return this.live.run(maxCycles, breakPC >>> 0);
	}

	/** The full machine state, as described in sim/snapshot.h. */
	snapshot(): Snapshot {
		return JSON.parse(this.live.snapshotJson()) as Snapshot;
	}

	/** The raw JSON, for writing a trace without a parse/serialise round trip. */
	snapshotJson(): string { return this.live.snapshotJson(); }

	get cycles(): number { return this.live.cycles(); }
	get retired(): number { return this.live.retired(); }
	get exited(): boolean { return this.live.exited(); }
	get exitCode(): number { return this.live.exitCode(); }

	readMem(addr: number): number { return this.live.readMem(addr >>> 0) >>> 0; }
	writeMem(addr: number, data: number): void { this.live.writeMem(addr >>> 0, data >>> 0); }

	/** Console characters written since the last call. */
	drainOutput(): string { return this.live.drainOutput(); }

	/** A $finish/$stop/$fatal from inside the model, or null. */
	fault(): SimFault | null { return this.live.fault(); }

	toString(): string {
		return `Hz3Sim(cycle ${this.cycles}, retired ${this.retired}` +
			(this.exited ? `, exited ${hex32(this.exitCode)}` : '') + ')';
	}
}

/** Load the runtime and return a fresh simulator. */
export async function createSim(opts: { url?: URL | string } = {}): Promise<Hz3Sim> {
	const runtime = await loadRuntime(opts.url ?? DEFAULT_MODULE_URL);
	return new Hz3Sim(runtime);
}
