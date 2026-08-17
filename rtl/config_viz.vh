// Hazard3 configuration for the visualizer.
//
// Deliberately small and pedagogy-oriented (see docs/design.md, decision Q2):
//   - RV32I + M            -> shows forwarding, load-use, and multi-cycle mul/div
//   - Machine CSRs + traps -> ecall / interrupts are observable
//   - Counters             -> mcycle / minstret
//   - FULL bypass network  -> forwarding is the interesting case, not a stub
//   - Sequential mul/div    -> the multi-cycle stall is visible, not hidden
//   - No C, A, Zb*, U-mode, PMP, or debug -> less noise on screen for now
//
// These localparams are `included into the module body of hz3_top.v, then
// passed down to the core via hazard3_config_inst.vh. W_ADDR / W_DATA are
// module parameters of hz3_top and are intentionally NOT set here.

localparam RESET_VECTOR        = 32'h80000000;
localparam MTVEC_INIT          = 32'h80000000;

localparam EXTENSION_A         = 0;
localparam EXTENSION_C         = 0;
localparam EXTENSION_E         = 0;
localparam EXTENSION_M         = 1;
localparam EXTENSION_ZBA       = 0;
localparam EXTENSION_ZBB       = 0;
localparam EXTENSION_ZBC       = 0;
localparam EXTENSION_ZBKB      = 0;
localparam EXTENSION_ZBKX      = 0;
localparam EXTENSION_ZBS       = 0;
localparam EXTENSION_ZCB       = 0;
localparam EXTENSION_ZCLSD     = 0;
localparam EXTENSION_ZCMP      = 0;
localparam EXTENSION_ZIFENCEI  = 0;
localparam EXTENSION_ZILSD     = 0;
localparam EXTENSION_XH3BEXTM  = 0;
localparam EXTENSION_XH3IRQ    = 0;
localparam EXTENSION_XH3PMPM   = 0;
localparam EXTENSION_XH3POWER  = 0;

localparam CSR_M_MANDATORY     = 1;
localparam CSR_M_TRAP          = 1;
localparam CSR_COUNTER         = 1;
localparam U_MODE              = 0;

localparam PMP_REGIONS         = 0;
localparam PMP_GRAIN           = 0;
localparam PMP_MATCH_NAPOT     = 1;
localparam PMP_MATCH_TOR       = 0;
localparam PMP_HARDWIRED       = {(PMP_REGIONS > 0 ? PMP_REGIONS : 1){1'b0}};
localparam PMP_HARDWIRED_ADDR  = {(PMP_REGIONS > 0 ? PMP_REGIONS : 1){32'h0}};
localparam PMP_HARDWIRED_CFG   = {(PMP_REGIONS > 0 ? PMP_REGIONS : 1){8'h00}};

localparam DEBUG_SUPPORT       = 0;
localparam BREAKPOINT_TRIGGERS = 0;

localparam NUM_IRQS            = 1;
localparam IRQ_PRIORITY_BITS   = 0;
localparam IRQ_INPUT_BYPASS    = {NUM_IRQS{1'b0}};

localparam MVENDORID_VAL       = 32'h0;
localparam MCONFIGPTR_VAL      = 32'h0;

localparam REDUCED_BYPASS      = 0;
localparam MULDIV_UNROLL       = 1;
localparam MUL_FAST            = 0;
localparam MUL_FASTER          = 0;
localparam MULH_FAST           = 0;
localparam FAST_BRANCHCMP      = 0;
localparam RESET_REGFILE       = 1;
localparam BRANCH_PREDICTOR    = 0;
localparam MTVEC_WMASK         = 32'hfffffffd;
