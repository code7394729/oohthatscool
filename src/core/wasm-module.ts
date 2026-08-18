/**
 * wasm-module.ts — the shape of the Emscripten module built by
 * scripts/build-wasm-lib.sh.
 *
 * That file is generated, so it is not converted to TypeScript; instead its
 * Embind surface is declared here and checked at the one place we cross into
 * it (sim.ts). The names must match the EMSCRIPTEN_BINDINGS block in
 * sim/bridge.cpp.
 */

import type { MemoryMap, RunResult, SimFault } from './snapshot.js';

/** The Embind `Sim` class. Instances must be delete()d — WASM has no GC hook. */
export interface EmbindSim {
	loadProgram(bytes: Uint8Array | number[], addr: number): void;
	reset(): void;
	stepCycle(): void;
	stepInstruction(maxCycles: number): RunResult;
	run(maxCycles: number, breakPC: number): RunResult;
	snapshotJson(): string;
	cycles(): number;
	retired(): number;
	exited(): boolean;
	exitCode(): number;
	readMem(addr: number): number;
	writeMem(addr: number, data: number): void;
	drainOutput(): string;
	fault(): SimFault | null;
	delete(): void;
}

export interface Hz3Runtime {
	Sim: {
		new (): EmbindSim;
		memoryMap(): MemoryMap;
	};
}

/** The module's default export is a factory returning the instantiated module. */
export type Hz3ModuleFactory = () => Promise<Hz3Runtime>;
