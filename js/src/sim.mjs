/**
 * sim.mjs — JavaScript wrapper around the WASM simulator.
 *
 * The only file in js/ that knows WASM exists. Everything else — blink policy,
 * decoding, rendering — takes plain snapshot objects, so it runs and is tested
 * without loading a 200 KB module.
 *
 * Environment-agnostic: the module is built with ENVIRONMENT=node,web, program
 * bytes are passed in by the caller rather than read from a filesystem, and
 * nothing here touches `document` or `window`. The browser and the Node CLI
 * load the identical artifact.
 */

import { hex32 } from './decode.mjs';

/** Location of the built module, relative to this file. */
export const DEFAULT_MODULE_URL = new URL('../../build/wasm/hz3.mjs', import.meta.url);

/** @type {Promise<any>|null} */
let runtimePromise = null;

/**
 * Instantiate the Emscripten module (once per process).
 *
 * @param {URL|string} [url]
 * @returns {Promise<any>} the Emscripten module object
 */
export async function loadRuntime(url = DEFAULT_MODULE_URL) {
	if (!runtimePromise) {
		const href = typeof url === 'string' ? url : url.href;
		runtimePromise = import(href).then((m) => m.default());
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
	/** @param {any} runtime  the instantiated Emscripten module */
	constructor(runtime) {
		this.runtime = runtime;
		this.sim = new runtime.Sim();
		/** Memory map constants, so callers do not hardcode addresses. */
		this.map = runtime.Sim.memoryMap();
	}

	/** Embind objects are not garbage collected; call this when finished. */
	dispose() {
		if (this.sim) {
			this.sim.delete();
			this.sim = null;
		}
	}

	/**
	 * @param {Uint8Array|number[]} bytes flat image
	 * @param {number} [addr] load address; defaults to the reset vector
	 */
	loadProgram(bytes, addr = this.map.memBase) {
		this.sim.loadProgram(bytes, addr >>> 0);
	}

	reset() { this.sim.reset(); }

	stepCycle() { this.sim.stepCycle(); }

	/**
	 * Advance until one more instruction retires.
	 * @param {number} [maxCycles] guard against a program that never retires
	 * @returns {{reason:string, cycles:number, retired:number}}
	 */
	stepInstruction(maxCycles = 10000) {
		return this.sim.stepInstruction(maxCycles);
	}

	/**
	 * @param {number} maxCycles
	 * @param {number} [breakPC] stop when this PC reaches execute
	 * @returns {{reason:string, cycles:number, retired:number}}
	 */
	run(maxCycles, breakPC = this.map.noBreak) {
		return this.sim.run(maxCycles, breakPC >>> 0);
	}

	/**
	 * The full machine state, as described in sim/snapshot.h.
	 * @returns {any}
	 */
	snapshot() {
		return JSON.parse(this.sim.snapshotJson());
	}

	/** The raw JSON, for writing a trace without a parse/serialise round trip. */
	snapshotJson() { return this.sim.snapshotJson(); }

	get cycles() { return this.sim.cycles(); }
	get retired() { return this.sim.retired(); }
	get exited() { return this.sim.exited(); }
	get exitCode() { return this.sim.exitCode(); }

	/** @param {number} addr */
	readMem(addr) { return this.sim.readMem(addr >>> 0) >>> 0; }

	/** @param {number} addr @param {number} data */
	writeMem(addr, data) { this.sim.writeMem(addr >>> 0, data >>> 0); }

	/** Console characters written since the last call. */
	drainOutput() { return this.sim.drainOutput(); }

	/** A $finish/$stop/$fatal from inside the model, or null. */
	fault() { return this.sim.fault(); }

	/** Human-readable one-liner, handy in a REPL. */
	toString() {
		return `Hz3Sim(cycle ${this.cycles}, retired ${this.retired}` +
			(this.exited ? `, exited ${hex32(this.exitCode)}` : '') + ')';
	}
}

/**
 * Convenience: load the runtime and return a fresh simulator.
 *
 * @param {{url?: URL|string}} [opts]
 * @returns {Promise<Hz3Sim>}
 */
export async function createSim(opts = {}) {
	const runtime = await loadRuntime(opts.url ?? DEFAULT_MODULE_URL);
	return new Hz3Sim(runtime);
}
