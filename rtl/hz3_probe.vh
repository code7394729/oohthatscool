// hz3_probe.vh — pull Hazard3's internal microarchitectural state up to the
// top-level probe ports declared in hz3_probe_ports.vh.
//
// This is design option C ("probe wrapper", docs/design.md §4): the Hazard3
// submodule is never edited, and every hierarchical reference into it lives in
// this one file. If upstream renames a signal, elaboration fails here with the
// offending path named, instead of the visualizer silently showing stale data.
//
// Hierarchy reached from hz3_top:
//
//   cpu                      hazard3_cpu_1port
//   cpu.core                 hazard3_core
//   cpu.core.frontend        hazard3_frontend
//   cpu.core.csr_u           hazard3_csr
//   cpu.core.regs            hazard3_regfile_1w2r
//   cpu.core.has_muldiv      generate block (EXTENSION_M)
//
// Everything below is a *read*. The probe adds three registers of its own
// (m_valid / m_pc / m_instr) because that state does not exist in the core;
// they are clocked exactly like the core's own X|M pipeline register so they
// cannot drift from it.

// ----------------------------------------------------------------------------
// Retirement

assign p_instr_ret = cpu.core.x_instr_ret;

// ----------------------------------------------------------------------------
// Stage F

assign p_f_pc           = cpu.core.frontend.fetch_addr;
assign p_f_cir          = cpu.core.fd_cir;
assign p_f_cir_vld      = cpu.core.fd_cir_vld;
assign p_f_cir_is_32bit = cpu.core.fd_cir_is_32bit;
assign p_f_jump_req     = cpu.core.f_jump_req;
assign p_f_jump_rdy     = cpu.core.f_jump_rdy;
assign p_f_jump_target  = cpu.core.f_jump_target;

// ----------------------------------------------------------------------------
// Stage X

assign p_x_pc         = cpu.core.d_pc;
assign p_x_starved    = cpu.core.d_starved;
assign p_x_valid      = !cpu.core.d_starved;
assign p_x_rs1        = cpu.core.d_rs1;
assign p_x_rs2        = cpu.core.d_rs2;
assign p_x_rd         = cpu.core.d_rd;
assign p_x_imm        = cpu.core.d_imm;
assign p_x_aluop      = cpu.core.d_aluop;
assign p_x_memop      = cpu.core.d_memop;
assign p_x_mulop      = cpu.core.d_mulop;
assign p_x_branchcond = cpu.core.d_branchcond;
assign p_x_op_a       = cpu.core.x_op_a;
assign p_x_op_b       = cpu.core.x_op_b;
assign p_x_alu_result = cpu.core.x_alu_result;
assign p_x_rs1_bypass = cpu.core.x_rs1_bypass;
assign p_x_rs2_bypass = cpu.core.x_rs2_bypass;
assign p_x_jump_req   = cpu.core.x_jump_req;
assign p_x_stall      = cpu.core.x_stall;
assign p_x_csr_ren    = cpu.core.d_csr_ren;
assign p_x_csr_wen    = cpu.core.d_csr_wen;
assign p_x_csr_rdata  = cpu.core.x_csr_rdata;
assign p_x_except     = cpu.core.x_except;

// An instruction leaves X at this posedge. df_cir_use is the number of
// instruction halfwords the decoder consumes this cycle, so it is nonzero
// exactly when X issues; the trap term mirrors the core's own bubble
// insertion into the X|M register (see hazard3_core.v, "Pipe register").
wire probe_x_issue = |cpu.core.df_cir_use && !cpu.core.m_trap_enter_soon;
assign p_x_issue = probe_x_issue;

// Which source the operand mux picked. Hazard3 encodes this one-hot over
// {regfile, X|M result, M|W result}; all-zero means "this instruction has no
// register operand here", which is worth showing distinctly from "read x0".
assign p_x_bypass_a =
	cpu.core.x_rs1_select_regs_xm_mw[1] ? 2'd2 :  // forwarded from M
	cpu.core.x_rs1_select_regs_xm_mw[0] ? 2'd3 :  // forwarded from W
	cpu.core.x_rs1_select_regs_xm_mw[2] ? 2'd1 :  // straight from the regfile
	                                      2'd0;   // no register operand

assign p_x_bypass_b =
	cpu.core.x_rs2_select_regs_xm_mw[1] ? 2'd2 :
	cpu.core.x_rs2_select_regs_xm_mw[0] ? 2'd3 :
	cpu.core.x_rs2_select_regs_xm_mw[2] ? 2'd1 :
	                                      2'd0;

// Why X is stalled, decomposed. x_stall is a flat OR in the core, but "the
// pipeline is stalled" is only interesting to a student alongside *which*
// hazard did it, so we re-derive the individual terms here. Bit order matches
// STALL_* in sim/snapshot.h and STALL_BITS in js/src/decode.mjs.
assign p_x_stall_cause = {
	1'b0,                                                            // [7] reserved
	cpu.core.d_starved,                                              // [6] front end starved
	cpu.core.x_jump_req && !cpu.core.f_jump_rdy,                     // [5] jump not accepted
	cpu.core.bus_aph_req_d && !cpu.core.bus_aph_ready_d,             // [4] bus address phase
	cpu.core.x_stall_on_fence,                                       // [3] fence
	cpu.core.x_stall_muldiv,                                         // [2] sequential mul/div
	cpu.core.x_stall_on_raw,                                         // [1] load-use / RAW
	cpu.core.m_stall                                                 // [0] downstream (M)
};

// ----------------------------------------------------------------------------
// Stage M
//
// The probe's own X|M shadow. Clocked on the same condition as the core's
// xm_* registers (advance unless M is stalled) and cleared by the same bubble
// condition, so p_m_valid is true exactly when M holds a real instruction.

reg        probe_m_valid;
reg [31:0] probe_m_pc;
reg [31:0] probe_m_instr;

always @ (posedge clk or negedge rst_n) begin
	if (!rst_n) begin
		probe_m_valid <= 1'b0;
		probe_m_pc    <= 32'h0;
		probe_m_instr <= 32'h0;
	end else if (!cpu.core.m_stall) begin
		probe_m_valid <= probe_x_issue;
		if (probe_x_issue) begin
			probe_m_pc    <= cpu.core.d_pc;
			probe_m_instr <= cpu.core.fd_cir;
		end
	end
end

assign p_m_valid            = probe_m_valid;
assign p_m_pc               = probe_m_pc;
assign p_m_instr            = probe_m_instr;
assign p_m_rd               = cpu.core.xm_rd;
assign p_m_result           = cpu.core.m_result;
assign p_m_xm_result        = cpu.core.xm_result;
assign p_m_memop            = cpu.core.xm_memop;
assign p_m_stall            = cpu.core.m_stall;
assign p_m_bus_stall        = cpu.core.m_bus_stall;
assign p_m_dphase_in_flight = cpu.core.m_dphase_in_flight;
assign p_m_trap_enter_vld   = cpu.core.m_trap_enter_vld;
assign p_m_trap_is_irq      = cpu.core.m_trap_is_irq;
assign p_m_trap_addr        = cpu.core.m_trap_addr;
assign p_m_except           = cpu.core.xm_except;

// The register-file write strobe. This is the whole basis of the "register
// updated" indication in the UI: it pulses on every architectural write, so a
// write of a value equal to the one already there is still observable. Nothing
// downstream may infer writes by diffing p_regs.
assign p_m_reg_wen = cpu.core.m_reg_wen;

// ----------------------------------------------------------------------------
// Architectural register file
//
// Read straight out of the core's storage rather than mirrored, so the panel
// cannot disagree with the machine. Path depends on RESET_REGFILE (see
// hazard3_regfile_1w2r.v); config_viz.vh sets it to 1.

genvar probe_i;
generate
for (probe_i = 0; probe_i < 32; probe_i = probe_i + 1) begin: probe_regs_gen
	assign p_regs[probe_i * 32 +: 32] = cpu.core.regs.real_dualport_reset.mem[probe_i];
end
endgenerate

// ----------------------------------------------------------------------------
// CSRs
//
// mstatus and mcause are assembled from individual flops in hazard3_csr, in
// the same bit positions the CSR read port uses.

assign p_csr_mcycle   = cpu.core.csr_u.mcycle;
assign p_csr_minstret = cpu.core.csr_u.minstret;
assign p_csr_mepc     = cpu.core.csr_u.mepc;
assign p_csr_mtvec    = cpu.core.csr_u.mtvec;

assign p_csr_mcause   = {
	cpu.core.csr_u.mcause_irq,
	27'h0,
	cpu.core.csr_u.mcause_code
};

assign p_csr_mstatus  = {
	14'h0,
	cpu.core.csr_u.mstatus_mprv,   // [17] MPRV
	4'h0,
	cpu.core.csr_u.mstatus_mpp,    // [12] MPP (only the MSB is implemented)
	4'h0,
	cpu.core.csr_u.mstatus_mpie,   // [7]  MPIE
	3'h0,
	cpu.core.csr_u.mstatus_mie,    // [3]  MIE
	3'h0
};

// ----------------------------------------------------------------------------
// Core-internal bus requests (pre-arbitration)

assign p_bus_i_aph_req   = cpu.core.bus_aph_req_i;
assign p_bus_i_addr      = cpu.core.bus_haddr_i;
assign p_bus_i_dph_ready = cpu.core.bus_dph_ready_i;
assign p_bus_d_aph_req   = cpu.core.bus_aph_req_d;
assign p_bus_d_addr      = cpu.core.bus_haddr_d;
assign p_bus_d_write     = cpu.core.bus_hwrite_d;
assign p_bus_d_wdata     = cpu.core.bus_wdata_d;
assign p_bus_d_rdata     = cpu.core.bus_rdata_d;
assign p_bus_d_dph_ready = cpu.core.bus_dph_ready_d;
