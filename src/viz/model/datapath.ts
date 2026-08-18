/**
 * datapath.ts — what Hazard3's datapath consists of.
 *
 * The semantic description, and nothing else: no coordinates, no colours, no
 * knowledge of the simulator. Every component and net carries the RTL name it
 * stands for, so this file doubles as the map between the picture and
 * third_party/hazard3/hdl.
 *
 * The structure being described is the real one (docs/design.md §3): three
 * stages, F / X / M, with decode fused into X — there is no separate decode
 * pipeline register the way the textbook 5-stage has. The two pipeline
 * registers are the CIR at the F|X boundary and the X|M group.
 *
 * A few honest simplifications, called out because a teaching diagram that
 * quietly fibs is worse than one that admits its edges:
 *
 *   - `xres` is drawn as a mux between the ALU and the sequential multiplier.
 *     The RTL writes `xm_result` from a conditional expression rather than a
 *     named mux, but selecting between two results is what it does.
 *   - `hazard` gathers Hazard3's forwarding-select and interlock logic into one
 *     block. In the RTL it is spread across `x_rs1_select_regs_xm_mw`,
 *     `x_stall_on_raw` and the predecode registers; drawing it as the textbook
 *     hazard unit is the usual and, here, an honest abstraction.
 *   - `wb` stands for the writeback control off the X|M register. In the RTL
 *     `xm_rd` and `m_reg_wen` are just signals, not a block.
 *   - The two AHB ports are drawn as separate `imem` and `dmem` blocks. The
 *     single-port build muxes them onto one bus outside the core; the internal
 *     request streams really are separate, which is what the snapshot's
 *     `bus.iReq` / `bus.dReq` report.
 */

import {
	alu, block, mux, net, register,
	type Datapath,
} from './types.js';

export const datapath: Datapath = {
	components: [
		// ---- F: fetch -----------------------------------------------------
		block('pc', {
			stage: 'F',
			label: 'fetch address',
			rtl: 'hazard3_frontend.fetch_addr',
			note: 'Where the front end is fetching from. Advances on its own until execute redirects it.',
			inputs: [{ id: 'redirect', dir: 'in', kind: 'address', label: 'redirect' }],
			outputs: [{ id: 'q', dir: 'out', kind: 'address' }],
		}),
		block('imem', {
			stage: 'F',
			type: 'memory',
			label: 'instruction fetch',
			sublabel: 'AHB5 · prefetch FIFO',
			rtl: 'bus_haddr_i / bus_rdata_i',
			note: 'Fetches ahead of the pipeline into a small buffer, which is why a taken branch costs cycles rather than being free.',
			inputs: [{ id: 'addr', dir: 'in', kind: 'address', role: 'address' }],
			outputs: [{ id: 'data', dir: 'out', kind: 'instruction' }],
		}),
		register('cir', {
			stage: 'F',
			label: 'CIR',
			sublabel: 'F │ X',
			hold: true,
			rtl: 'fd_cir / fd_cir_vld',
			note: 'The instruction register between fetch and execute — one of only two pipeline registers in this core. A stall holds it.',
		}),

		// ---- X: decode + execute -------------------------------------------
		block('decode', {
			stage: 'X',
			label: 'decode',
			sublabel: 'combinational',
			rtl: 'hazard3_decode',
			note: 'Decode is not a pipeline stage here: it happens inside execute, in the same cycle the ALU runs.',
			inputs: [{ id: 'instr', dir: 'in', kind: 'instruction' }],
			outputs: [
				{ id: 'rs1', dir: 'out', kind: 'control', label: 'rs1' },
				{ id: 'rs2', dir: 'out', kind: 'control', label: 'rs2' },
				{ id: 'rd', dir: 'out', kind: 'control', label: 'rd' },
				{ id: 'imm', dir: 'out', kind: 'data', label: 'imm' },
				{ id: 'selA', dir: 'out', kind: 'control', label: 'alusrc a' },
				{ id: 'selB', dir: 'out', kind: 'control', label: 'alusrc b' },
				{ id: 'useMul', dir: 'out', kind: 'control', label: 'muldiv' },
				{ id: 'memop', dir: 'out', kind: 'control', label: 'memop' },
			],
		}),
		block('hazard', {
			stage: 'X',
			label: 'hazard unit',
			sublabel: 'forwarding · interlock',
			rtl: 'x_rs1_select_regs_xm_mw / x_stall_on_raw',
			note: 'Compares the operands this instruction wants against the destinations still in flight, and either forwards or stalls.',
			inputs: [
				{ id: 'rs1', dir: 'in', kind: 'control', label: 'rs1' },
				{ id: 'rs2', dir: 'in', kind: 'control', label: 'rs2' },
				{ id: 'xmRd', dir: 'in', kind: 'control', label: 'rd in M' },
				{ id: 'mwRd', dir: 'in', kind: 'control', label: 'rd in W' },
			],
			outputs: [
				{ id: 'selA', dir: 'out', kind: 'control', label: 'fwd a' },
				{ id: 'selB', dir: 'out', kind: 'control', label: 'fwd b' },
				{ id: 'stall', dir: 'out', kind: 'control', label: 'stall' },
			],
		}),
		block('xpc', {
			stage: 'X',
			type: 'source',
			label: 'PC in X',
			rtl: 'd_pc',
			note: 'The address of the instruction currently in execute — the operand for auipc, jal and branch targets.',
			outputs: [{ id: 'q', dir: 'out', kind: 'address' }],
		}),
		block('regfile', {
			stage: 'X',
			type: 'regfile',
			label: 'register file',
			sublabel: '32 × 32 · 1W 2R',
			rtl: 'hazard3_regfile_1w2r',
			note: 'Two reads for execute, one write from the memory stage. x0 is hardwired to zero and never written.',
			inputs: [
				{ id: 'ra1', dir: 'in', kind: 'control', role: 'address', label: 'raddr1' },
				{ id: 'ra2', dir: 'in', kind: 'control', role: 'address', label: 'raddr2' },
				{ id: 'wa', dir: 'in', kind: 'control', role: 'address', label: 'waddr' },
				{ id: 'wd', dir: 'in', kind: 'data', role: 'writedata', label: 'wdata' },
				{ id: 'we', dir: 'in', kind: 'control', role: 'enable', label: 'wen' },
			],
			outputs: [
				{ id: 'rd1', dir: 'out', kind: 'data', label: 'rdata1' },
				{ id: 'rd2', dir: 'out', kind: 'data', label: 'rdata2' },
			],
		}),

		// The bypass network. Its whole job is to answer "where does this
		// operand actually come from", which is the single most useful thing
		// this diagram can show.
		mux('bypassA', {
			stage: 'X',
			label: 'fwd A',
			inputs: ['register file', 'from M', 'from W'],
			rtl: 'x_rs1_bypass',
			note: 'Picks the newest value of rs1: the register file, or a result still in flight one or two stages ahead.',
		}),
		mux('bypassB', {
			stage: 'X',
			label: 'fwd B',
			inputs: ['register file', 'from M', 'from W'],
			rtl: 'x_rs2_bypass',
			note: 'The same for rs2.',
		}),
		mux('opA', {
			stage: 'X',
			label: 'A',
			inputs: ['rs1', 'PC'],
			rtl: 'x_op_a / d_alusrc_a',
			note: 'auipc and jal add to the PC instead of to a register.',
		}),
		mux('opB', {
			stage: 'X',
			label: 'B',
			inputs: ['rs2', 'immediate'],
			rtl: 'x_op_b / d_alusrc_b',
			note: 'Immediate for addi and friends, rs2 for register-register operations.',
		}),
		alu('alu', {
			stage: 'X',
			label: 'ALU',
			rtl: 'hazard3_alu',
			note: 'Single-cycle arithmetic, and the address adder for loads, stores and jumps.',
		}),
		block('muldiv', {
			stage: 'X',
			label: 'mul / div',
			sublabel: 'sequential',
			rtl: 'hazard3_muldiv_seq',
			note: 'Iterative: with MULDIV_UNROLL = 1 it takes tens of cycles, and holds execute still while it works.',
			inputs: ['a', 'b'],
			outputs: ['out'],
		}),
		mux('xres', {
			stage: 'X',
			label: 'res',
			inputs: ['ALU', 'mul / div'],
			rtl: 'xm_result assignment',
			note: 'Which unit produced the result this instruction carries into the memory stage.',
		}),
		block('branch', {
			stage: 'X',
			label: 'branch / jump',
			rtl: 'x_jump_req / x_jump_target',
			note: 'Redirects the front end. Instructions already fetched behind a taken branch are discarded — that is the branch penalty.',
			inputs: [
				{ id: 'target', dir: 'in', kind: 'address', label: 'PC' },
				{ id: 'cond', dir: 'in', kind: 'control', label: 'sum / cond' },
			],
			outputs: [{ id: 'redirect', dir: 'out', kind: 'address' }],
		}),

		// ---- M: memory + writeback -----------------------------------------
		register('xm', {
			stage: 'M',
			label: 'X │ M',
			fields: ['result', 'rd', 'memop'],
			rtl: 'xm_result / xm_rd / xm_memop',
			note: 'The second and last pipeline register. Its contents are also the nearer of the two forwarding sources.',
		}),
		block('dmem', {
			stage: 'M',
			type: 'memory',
			label: 'load / store',
			sublabel: 'AHB5 data phase',
			rtl: 'bus_haddr_d / bus_wdata_d / bus_rdata_d',
			note: 'The address phase is issued from execute and the data comes back here a cycle later. That gap is what a load-use hazard is.',
			inputs: [
				{ id: 'addr', dir: 'in', kind: 'address', role: 'address' },
				{ id: 'wdata', dir: 'in', kind: 'data', role: 'writedata', label: 'store data' },
			],
			outputs: [{ id: 'rdata', dir: 'out', kind: 'data', role: 'readdata', label: 'load data' }],
		}),
		mux('resultMux', {
			stage: 'M',
			label: 'wb',
			inputs: ['ALU result', 'load data'],
			rtl: 'm_result',
			note: 'Chooses between what the ALU computed and what memory returned.',
		}),
		block('wb', {
			stage: 'M',
			label: 'write control',
			sublabel: 'xm_rd · m_reg_wen',
			rtl: 'xm_rd / m_reg_wen',
			note: 'Which register is written, and whether the write happens at all. This strobe is what makes a register flash — including when the value written equals the one already there.',
			inputs: [{ id: 'rd', dir: 'in', kind: 'control', label: 'rd' }],
			outputs: [
				{ id: 'waddr', dir: 'out', kind: 'control', label: 'waddr' },
				{ id: 'wen', dir: 'out', kind: 'control', role: 'enable', label: 'wen' },
			],
		}),
	],

	nets: [
		// ---- F ------------------------------------------------------------
		net('pc_imem', 'pc.q', 'imem.addr', { kind: 'address', label: 'fetch PC' }),
		net('imem_cir', 'imem.data', 'cir.d', { kind: 'instruction', label: 'instr' }),
		net('cir_decode', 'cir.q', 'decode.instr', {
			kind: 'instruction', label: 'instr', rtl: 'fd_cir',
		}),

		// ---- decode fan-out -------------------------------------------------
		net('rs1_addr', 'decode.rs1', ['regfile.ra1', 'hazard.rs1'], { kind: 'control', rtl: 'd_rs1' }),
		net('rs2_addr', 'decode.rs2', ['regfile.ra2', 'hazard.rs2'], { kind: 'control', rtl: 'd_rs2' }),
		net('rd_to_xm', 'decode.rd', 'xm.d_rd', { kind: 'control', rtl: 'd_rd' }),
		net('memop_to_xm', 'decode.memop', 'xm.d_memop', { kind: 'control', rtl: 'd_memop' }),
		net('imm_opB', 'decode.imm', 'opB.in1', { label: 'imm', rtl: 'd_imm' }),
		net('selA', 'decode.selA', 'opA.sel', { kind: 'control', rtl: 'd_alusrc_a' }),
		net('selB', 'decode.selB', 'opB.sel', { kind: 'control', rtl: 'd_alusrc_b' }),
		net('xres_sel', 'decode.useMul', 'xres.sel', { kind: 'control', rtl: 'd_aluop == ALUOP_MULDIV' }),

		// ---- register reads into the bypass network -------------------------
		net('rf_rd1', 'regfile.rd1', 'bypassA.in0', { label: 'rs1', rtl: 'x_rdata1' }),
		net('rf_rd2', 'regfile.rd2', 'bypassB.in0', { label: 'rs2', rtl: 'x_rdata2' }),

		// The two forwarding paths — what students are here to see.
		net('fwd_m', 'xm.q_result', ['bypassA.in1', 'bypassB.in1'], {
			label: 'forward from M', rtl: 'xm_result',
			note: 'The result of the instruction one stage ahead, before it has reached the register file.',
		}),
		net('fwd_w', 'resultMux.out', ['bypassA.in2', 'bypassB.in2', 'regfile.wd'], {
			label: 'forward from W', rtl: 'mw_result / m_result',
			note: 'The value being written back this cycle, handed straight to execute rather than waiting a cycle.',
		}),

		// ---- hazard unit ----------------------------------------------------
		net('hz_selA', 'hazard.selA', 'bypassA.sel', { kind: 'control' }),
		net('hz_selB', 'hazard.selB', 'bypassB.sel', { kind: 'control' }),
		net('hz_stall', 'hazard.stall', 'cir.hold', {
			kind: 'control', label: 'stall', rtl: 'x_stall',
			note: 'Holds the instruction in execute for another cycle and inserts a bubble behind it.',
		}),
		net('xm_rd', 'xm.q_rd', ['wb.rd', 'hazard.xmRd'], { kind: 'control', rtl: 'xm_rd' }),

		// ---- operand muxes and execute --------------------------------------
		net('bypA_opA', 'bypassA.out', 'opA.in0', { rtl: 'x_rs1_bypass' }),
		net('bypB_opB', 'bypassB.out', ['opB.in0', 'dmem.wdata'], { rtl: 'x_rs2_bypass' }),
		net('xpc_opA', 'xpc.q', ['opA.in1', 'branch.target'], { kind: 'address', label: 'PC' }),
		net('opA_alu', 'opA.out', ['alu.a', 'muldiv.a'], { label: 'A', rtl: 'x_op_a' }),
		net('opB_alu', 'opB.out', ['alu.b', 'muldiv.b'], { label: 'B', rtl: 'x_op_b' }),
		net('alu_out', 'alu.out', ['xres.in0', 'dmem.addr', 'branch.cond'], { rtl: 'x_alu_result' }),
		net('muldiv_out', 'muldiv.out', 'xres.in1', { rtl: 'x_muldiv_result' }),
		net('xres_xm', 'xres.out', 'xm.d_result'),

		// The redirect closes the loop back to fetch.
		net('branch_pc', 'branch.redirect', 'pc.redirect', {
			kind: 'address', label: 'redirect', rtl: 'x_jump_req / f_jump_target',
			note: 'Two cycles of instructions behind a taken branch are thrown away when this fires.',
		}),

		// ---- memory and writeback -------------------------------------------
		net('xm_to_result', 'xm.q_result', 'resultMux.in0', { rtl: 'xm_result' }),
		net('dmem_rdata', 'dmem.rdata', 'resultMux.in1', { label: 'load data', rtl: 'bus_rdata_d' }),
		net('result_sel', 'xm.q_memop', 'resultMux.sel', { kind: 'control', rtl: 'xm_memop' }),
		net('wb_waddr', 'wb.waddr', ['regfile.wa', 'hazard.mwRd'], { kind: 'control', rtl: 'xm_rd' }),
		net('wb_wen', 'wb.wen', 'regfile.we', {
			kind: 'control', label: 'wen', rtl: 'm_reg_wen',
			note: 'The write strobe. It pulses on every architectural write, which is why a register rewritten with the value it already held still lights up.',
		}),
	],
};
