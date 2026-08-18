/**
 * datapath-layout.ts — where everything sits.
 *
 * Pure geometry. This file knows the component and net *ids* from the model and
 * nothing else about them: not what they compute, not what the simulator is
 * doing, not what colour anything should be. Rearranging the picture means
 * editing numbers here and nowhere else.
 *
 * Conventions:
 *   - Left to right is F → X → M, so time runs the way English reads.
 *   - Backward paths (forwarding, the branch redirect, writeback) are routed
 *     out of the flow — over the top or along the bottom — so they read as
 *     "this goes back" at a glance rather than tangling with the forward path.
 *   - Port anchors are given only where the default (inputs west, outputs east,
 *     selects north) routes badly. See defaultAnchors() in ./types.ts.
 *   - `via` waypoints are corners: "go to this x, then this y". They exist so a
 *     wire can be steered around a block by hand rather than by a heuristic.
 */

import type { DatapathLayout } from './types.js';

/** Horizontal channel along the bottom used by the writeback path. */
const WB_TRUNK_Y = 690;
/** Channel above the execute units used by the M → X forwarding path. */
const FWD_TRUNK_Y = 258;

export const datapathLayout: DatapathLayout = {
	canvas: { width: 1280, height: 720 },

	bands: [
		{ id: 'F', label: 'F', sublabel: 'fetch', x: 16, w: 214 },
		{ id: 'X', label: 'X', sublabel: 'decode + execute', x: 242, w: 654 },
		{ id: 'M', label: 'M', sublabel: 'memory + writeback', x: 908, w: 356 },
	],

	components: {
		// ---- F -------------------------------------------------------------
		// Fetch reads top to bottom: address out, instruction back, into the CIR.
		pc: {
			box: { x: 56, y: 64, w: 140, h: 40 },
			ports: { q: { side: 's', at: 0.5 }, redirect: { side: 'n', at: 0.5 } },
		},
		imem: {
			box: { x: 46, y: 150, w: 160, h: 56 },
			ports: { addr: { side: 'n', at: 0.5 }, data: { side: 's', at: 0.5 } },
		},
		cir: {
			box: { x: 56, y: 248, w: 140, h: 58 },
			ports: {
				d: { side: 'n', at: 0.5 },
				q: { side: 'e', at: 0.5 },
				hold: { side: 'w', at: 0.5 },
			},
		},

		// ---- X ---------------------------------------------------------------
		decode: {
			box: { x: 262, y: 146, w: 122, h: 168 },
			ports: {
				instr: { side: 'w', at: 0.2 },
				// Register numbers head down to the register file and the hazard
				// unit; everything else heads right into the execute path.
				rs1: { side: 's', at: 0.22 },
				rs2: { side: 's', at: 0.55 },
				rd: { side: 'e', at: 0.1 },
				memop: { side: 'e', at: 0.26 },
				imm: { side: 'e', at: 0.46 },
				selA: { side: 'e', at: 0.64 },
				selB: { side: 'e', at: 0.8 },
				useMul: { side: 'e', at: 0.94 },
			},
		},
		regfile: {
			box: { x: 262, y: 372, w: 146, h: 126 },
			ports: {
				ra1: { side: 'n', at: 0.18 },
				ra2: { side: 'n', at: 0.42 },
				wa: { side: 'w', at: 0.3 },
				wd: { side: 'w', at: 0.58 },
				we: { side: 'w', at: 0.84 },
				rd1: { side: 'e', at: 0.28 },
				rd2: { side: 'e', at: 0.68 },
			},
		},
		hazard: {
			box: { x: 470, y: 556, w: 176, h: 96 },
			ports: {
				rs1: { side: 'w', at: 0.2 },
				rs2: { side: 'w', at: 0.4 },
				xmRd: { side: 'e', at: 0.3 },
				mwRd: { side: 'e', at: 0.65 },
				// The selects go straight up into the muxes they steer.
				selA: { side: 'n', at: 0.3 },
				selB: { side: 'n', at: 0.62 },
				stall: { side: 'w', at: 0.82 },
			},
		},
		xpc: {
			box: { x: 262, y: 66, w: 122, h: 34 },
			ports: { q: { side: 'e', at: 0.5 } },
		},

		bypassA: { box: { x: 486, y: 300, w: 30, h: 92 } },
		bypassB: { box: { x: 486, y: 424, w: 30, h: 92 } },
		opA: { box: { x: 566, y: 314, w: 26, h: 64 } },
		opB: { box: { x: 566, y: 438, w: 26, h: 64 } },

		alu: { box: { x: 646, y: 322, w: 78, h: 132 } },
		muldiv: {
			box: { x: 640, y: 484, w: 128, h: 60 },
			ports: { a: { side: 'w', at: 0.3 }, b: { side: 'w', at: 0.7 } },
		},
		xres: { box: { x: 818, y: 356, w: 26, h: 64 } },

		branch: {
			box: { x: 700, y: 60, w: 152, h: 48 },
			ports: {
				target: { side: 'w', at: 0.5 },
				cond: { side: 's', at: 0.3 },
				redirect: { side: 'n', at: 0.5 },
			},
		},

		// ---- M ---------------------------------------------------------------
		xm: {
			box: { x: 946, y: 330, w: 62, h: 120 },
			ports: {
				d_result: { side: 'w', at: 0.25 },
				d_rd: { side: 'w', at: 0.55 },
				d_memop: { side: 'w', at: 0.82 },
				// One anchor serves both the forwarding path and the result path;
				// they leave together over the top, which is also how the backward
				// direction of forwarding reads clearly.
				q_result: { side: 'n', at: 0.4 },
				q_rd: { side: 'e', at: 0.45 },
				q_memop: { side: 'e', at: 0.8 },
			},
		},
		dmem: {
			box: { x: 946, y: 486, w: 164, h: 56 },
			ports: {
				addr: { side: 'w', at: 0.3 },
				wdata: { side: 'w', at: 0.72 },
				rdata: { side: 'e', at: 0.5 },
			},
		},
		resultMux: {
			box: { x: 1176, y: 372, w: 26, h: 68 },
			ports: { sel: { side: 's', at: 0.5 } },
		},
		wb: {
			box: { x: 1040, y: 592, w: 168, h: 58 },
			ports: {
				rd: { side: 'e', at: 0.5 },
				waddr: { side: 'w', at: 0.32 },
				wen: { side: 'w', at: 0.72 },
			},
		},
	},

	nets: {
		// The instruction reaches decode across the F│X boundary.
		cir_decode: { via: [{ x: 232, y: 180 }] },

		// The hazard unit taps the register numbers, but must get past the
		// register file to do it — hence the channel at x = 236.
		rs1_addr: { branches: { 1: { via: [{ x: 236, y: 330 }, { x: 236, y: 576 }] } } },
		rs2_addr: { branches: { 1: { via: [{ x: 248, y: 342 }, { x: 248, y: 596 }] } } },

		// Forwarding from M: up out of the X│M register, back across the top of
		// the execute units, down into both bypass muxes.
		fwd_m: { via: [{ x: 470, y: FWD_TRUNK_Y }], labelBranch: 0 },
		xm_to_result: { via: [{ x: 1162, y: 300 }] },

		// Writeback: down, along the bottom, and back to the register file and
		// the bypass muxes. The single waypoint is enough because each branch
		// then closes with "along to my x, then up to my y".
		fwd_w: { via: [{ x: 1232, y: WB_TRUNK_Y }], labelBranch: 2 },
		wb_waddr: { via: [{ x: 1026, y: 664 }, { x: 226, y: 664 }] },
		wb_wen: { via: [{ x: 1014, y: 676 }, { x: 214, y: 676 }] },

		// Selects rise out of the hazard unit, threading between the mux column
		// and the register file.
		hz_selA: { via: [{ x: 452, y: 286 }] },
		hz_selB: { via: [{ x: 440, y: 410 }] },
		// The stall signal runs back along the bottom-left to hold the CIR.
		hz_stall: { via: [{ x: 30, y: 604 }] },

		// The redirect goes over the top of everything, which is what makes the
		// branch penalty legible: it is visibly a long way back.
		branch_pc: { via: [{ x: 776, y: 30 }, { x: 126, y: 30 }] },

		// The PC reaches the operand mux and the branch unit from above.
		xpc_opA: { branches: { 0: { via: [{ x: 540, y: 83 }] } } },

		alu_out: {
			branches: {
				1: { via: [{ x: 900, y: 500 }] },   // address to the data phase
				2: { via: [{ x: 738, y: 480 }] },   // sum/condition up to the branch unit
			},
		},
		bypB_opB: { branches: { 1: { via: [{ x: 620, y: 570 }, { x: 900, y: 570 }] } } },
		result_sel: { via: [{ x: 1189, y: 470 }] },
		xm_rd: { branches: { 1: { via: [{ x: 700, y: 578 }] } } },
	},
};
