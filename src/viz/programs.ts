/**
 * programs.ts — the teaching examples.
 *
 * Each is a handful of instructions engineered to make one microarchitectural
 * phenomenon unmistakable, assembled in the browser (src/core/rv32.ts) so the
 * page needs no RISC-V toolchain and no fetch to run any of them. The
 * explanation of what to watch for lives next to the code that produces it,
 * which is the whole point of keeping them here rather than as .bin fixtures.
 *
 * `hello` is the exception: it is built by the RISC-V toolchain and fetched
 * over HTTP, and is simply absent from the menu if it has not been built.
 */

import {
	add, addi, assemble, csrrwi, CSR, lui, lw, mul, sub, sw, X,
	type AssembledProgram,
} from '../core/rv32.js';

export interface Example {
	id: string;
	name: string;
	/** One line under the menu: what this program is for. */
	blurb: string;
	/** What to look for while stepping it. Shown next to the diagram. */
	watch: string;
	/** Suggested cycles for "run" so the interesting part is on screen. */
	cycles?: number;
	build(): AssembledProgram;
}

export const examples: Example[] = [
	{
		id: 'forwarding',
		name: 'Forwarding chain',
		blurb: 'Dependent adds, back to back.',
		watch: 'Every operand arrives on the "forward from M" wire, one cycle before the '
			+ 'register file would have it. Watch the register file stay quiet while the '
			+ 'chain runs.',
		build: () => assemble((p) => {
			p.add(addi(X.t0, X.zero, 1));
			p.add(addi(X.t1, X.t0, 1));   // needs t0, produced last cycle
			p.add(addi(X.t2, X.t1, 1));
			p.add(add(X.a0, X.t2, X.t1));
			p.add(add(X.a1, X.a0, X.t2));
			p.add(sub(X.a2, X.a1, X.a0));
			p.park();
		}),
	},
	{
		id: 'loaduse',
		name: 'Load–use hazard',
		blurb: 'The one bubble forwarding cannot remove.',
		watch: 'The load result does not exist yet when the next instruction wants it, so '
			+ 'the hazard unit holds execute for a cycle. Watch the stall wire light up and '
			+ 'the CIR go amber.',
		build: () => assemble((p) => {
			p.add(lui(X.sp, 0x80800));          // somewhere in the middle of RAM
			p.add(addi(X.t0, X.zero, 0x2a));
			p.add(sw(X.t0, X.sp, 0));
			// The store and the fetch share one AHB port, so give the prefetch
			// buffer a few cycles to refill. Without this the front end is still
			// starved when the load retires and the interlock never has to fire —
			// which is true to the hardware, but not what this example is for.
			p.add(addi(X.zero, X.zero, 0), addi(X.zero, X.zero, 0),
				addi(X.zero, X.zero, 0), addi(X.zero, X.zero, 0));
			p.add(lw(X.t1, X.sp, 0));
			p.add(add(X.t2, X.t1, X.t1));       // needs the load result immediately
			p.add(addi(X.a0, X.t2, 1));
			p.park();
		}),
	},
	{
		id: 'muldiv',
		name: 'Sequential multiply',
		blurb: 'A multi-cycle unit parking the pipeline.',
		watch: 'The multiplier is iterative in this build, so execute sits still for tens '
			+ 'of cycles. The mul/div block goes amber and the cycle counter keeps climbing '
			+ 'while nothing retires.',
		cycles: 80,
		build: () => assemble((p) => {
			p.add(addi(X.t0, X.zero, 1000));
			p.add(addi(X.t1, X.zero, 7));
			p.add(mul(X.t2, X.t0, X.t1));
			p.add(addi(X.a0, X.t2, 1));     // waits for the multiply
			p.park();
		}),
	},
	{
		id: 'branch',
		name: 'Branchy loop',
		blurb: 'A taken branch flushing the front end.',
		watch: 'Each time the branch is taken, the redirect wire fires across the top and '
			+ 'the instructions already fetched behind it are discarded — the front end runs '
			+ 'dry for a couple of cycles.',
		cycles: 120,
		build: () => assemble((p) => {
			p.add(addi(X.t0, X.zero, 5));      // counter
			p.add(addi(X.t1, X.zero, 0));      // accumulator
			p.label('loop');
			p.add(addi(X.t1, X.t1, 3));
			p.add(addi(X.t0, X.t0, -1));
			p.branch('bne', X.t0, X.zero, 'loop');
			p.add(addi(X.a0, X.t1, 0));
			p.park();
		}),
	},
	{
		id: 'samevalue',
		name: 'Same-value writes',
		blurb: 'Register writes a value diff would miss.',
		watch: 'Every one of these instructions writes a register with the value it already '
			+ 'holds. Nothing in the register panel changes — and yet each write flashes, '
			+ 'because the indication comes from the write strobe, not from comparing values.',
		build: () => assemble((p) => {
			p.add(addi(X.t0, X.zero, 7));
			p.add(addi(X.t0, X.zero, 7));   // same value again
			p.add(addi(X.t0, X.zero, 7));
			p.add(add(X.t1, X.zero, X.zero));  // zero into an already-zero register
			p.add(add(X.t1, X.zero, X.zero));
			p.add(add(X.t1, X.zero, X.zero));
			p.park();
		}),
	},
	{
		id: 'counters',
		name: 'CSR counters',
		blurb: 'Starting mcycle and minstret.',
		watch: 'Hazard3 comes out of reset with the counters inhibited, so software has to '
			+ 'enable them. Watch mcycle and minstret start moving after the csrrwi.',
		build: () => assemble((p) => {
			p.add(csrrwi(X.zero, CSR.mcountinhibit, 0));
			p.add(addi(X.t0, X.zero, 1));
			p.add(addi(X.t1, X.zero, 2));
			p.add(add(X.t2, X.t0, X.t1));
			p.add(mul(X.a0, X.t2, X.t2));
			p.park();
		}),
	},
];

export function findExample(id: string): Example | undefined {
	return examples.find((e) => e.id === id);
}

/** A toolchain-built image, if the repository has one. */
export interface FetchedProgram {
	id: string;
	name: string;
	blurb: string;
	watch: string;
	url: string;
}

export const fetchedPrograms: FetchedProgram[] = [
	{
		id: 'hello',
		name: 'Hello, world',
		blurb: 'A real C program (needs ./programs/build.sh hello).',
		watch: 'A whole program: a string copy loop feeding a character-output register, '
			+ 'with load-use stalls and taken branches on every pass.',
		url: '/programs/hello/build/hello.bin',
	},
];
