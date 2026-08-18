// hz3_probe_ports.vh — observability port declarations for hz3_top.
//
// Included into hz3_top's ANSI port list (hence the leading commas). Every
// probe signal is a *top-level output port* rather than a `verilator public`
// signal, which matters: Verilator gives top-level ports clean, stable member
// names on the generated class (`top->p_x_stall`), whereas public signals are
// reached through `rootp` under mangled, config-dependent names.
//
// The bodies of these ports live in hz3_probe.vh. Together those two files are
// the *only* place this project couples to Hazard3's internal signal names, so
// an upstream rename breaks here, loudly, at elaboration time.
//
// Nothing here drives the core: all assignments are reads.

	// ---- retirement -------------------------------------------------------
	// x_instr_ret: an instruction issues from X this cycle. This is the core's
	// own retire signal (it is what increments minstret), so our instruction
	// count is the hardware's, not a guess.
	, output wire          p_instr_ret

	// ---- stage F: fetch ---------------------------------------------------
	, output wire [31:0]   p_f_pc            // frontend fetch address
	, output wire [31:0]   p_f_cir           // CIR: the F|X pipeline register
	, output wire [ 1:0]   p_f_cir_vld       // valid halfwords in CIR
	, output wire          p_f_cir_is_32bit
	, output wire          p_f_jump_req      // front end being redirected
	, output wire          p_f_jump_rdy
	, output wire [31:0]   p_f_jump_target

	// ---- stage X: decode + execute ---------------------------------------
	, output wire [31:0]   p_x_pc
	, output wire          p_x_valid         // front end has supplied an instruction
	, output wire          p_x_issue         // ...and it moves to M at this posedge
	, output wire [ 4:0]   p_x_rs1
	, output wire [ 4:0]   p_x_rs2
	, output wire [ 4:0]   p_x_rd
	, output wire [31:0]   p_x_imm
	, output wire [ 5:0]   p_x_aluop
	, output wire [ 4:0]   p_x_memop
	, output wire [ 2:0]   p_x_mulop
	, output wire [ 1:0]   p_x_branchcond
	, output wire [31:0]   p_x_op_a          // post-bypass ALU operands
	, output wire [31:0]   p_x_op_b
	, output wire [31:0]   p_x_alu_result
	, output wire [31:0]   p_x_rs1_bypass    // value the bypass network selected
	, output wire [31:0]   p_x_rs2_bypass
	, output wire [ 1:0]   p_x_bypass_a      // 0 none, 1 regfile, 2 from M, 3 from W
	, output wire [ 1:0]   p_x_bypass_b
	, output wire          p_x_jump_req
	, output wire          p_x_stall
	, output wire [ 7:0]   p_x_stall_cause   // bitmap, see hz3_probe.vh
	, output wire          p_x_starved       // front end has not supplied an instruction
	, output wire          p_x_csr_ren
	, output wire          p_x_csr_wen
	, output wire [31:0]   p_x_csr_rdata
	, output wire [ 3:0]   p_x_except

	// ---- stage M: memory + writeback -------------------------------------
	// pc/instr/valid in M are *shadowed by the probe*: Hazard3 does not carry a
	// PC into M (it reconstructs mepc arithmetically), and a bubble is otherwise
	// indistinguishable from a real instruction with rd=x0 and no memory op.
	, output wire          p_m_valid
	, output wire [31:0]   p_m_pc
	, output wire [31:0]   p_m_instr
	, output wire [ 4:0]   p_m_rd
	, output wire [31:0]   p_m_result        // writeback data (post load/ALU mux)
	, output wire [31:0]   p_m_xm_result     // X|M latched ALU result
	, output wire [ 4:0]   p_m_memop
	, output wire          p_m_stall
	, output wire          p_m_bus_stall
	, output wire          p_m_dphase_in_flight
	, output wire          p_m_reg_wen       // regfile write strobe -> the blink source
	, output wire          p_m_trap_enter_vld
	, output wire          p_m_trap_is_irq
	, output wire [31:0]   p_m_trap_addr
	, output wire [ 3:0]   p_m_except

	// ---- architectural register file -------------------------------------
	// All 32 registers, flattened word-aligned so the C++ side indexes the
	// generated VlWide directly: p_regs[i] is xN.
	, output wire [1023:0] p_regs

	// ---- CSRs -------------------------------------------------------------
	, output wire [31:0]   p_csr_mcycle
	, output wire [31:0]   p_csr_minstret
	, output wire [31:0]   p_csr_mepc
	, output wire [31:0]   p_csr_mtvec
	, output wire [31:0]   p_csr_mcause
	, output wire [31:0]   p_csr_mstatus

	// ---- core-internal bus, before the 1-port arbiter --------------------
	// The top-level AHB signals show the *muxed* result; these show which side
	// actually wanted the bus, which is what explains a fetch starving.
	, output wire          p_bus_i_aph_req
	, output wire [31:0]   p_bus_i_addr
	, output wire          p_bus_i_dph_ready
	, output wire          p_bus_d_aph_req
	, output wire [31:0]   p_bus_d_addr
	, output wire          p_bus_d_write
	, output wire [31:0]   p_bus_d_wdata
	, output wire [31:0]   p_bus_d_rdata
	, output wire          p_bus_d_dph_ready
