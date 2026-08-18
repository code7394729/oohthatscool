/*
 * hz3_top.v — minimal single-port Hazard3 top for the visualizer.
 *
 * Wraps hazard3_cpu_1port (one AHB5 master, instruction + load/store muxed
 * internally) with the small amount of glue the core needs:
 *   - power-up handshake (pwrup_ack follows pwrup_req)
 *   - fence handshake (tied ready; no caches in this SoC)
 *   - debug ports tied off (DEBUG_SUPPORT = 0)
 *   - interrupts tied off for now (wired up in a later milestone)
 *
 * The C++ harness (sim/) drives clk / rst_n and services the AHB port from a
 * flat RAM + a tiny MMIO block. Config comes from rtl/config_viz.vh.
 */

`default_nettype none

module hz3_top #(
	parameter W_ADDR = 32,
	parameter W_DATA = 32
) (
	input  wire               clk,
	input  wire               rst_n,

	// AHB5 master port (services both instruction fetch and load/store)
	output wire [W_ADDR-1:0]  haddr,
	output wire               hwrite,
	output wire [1:0]         htrans,
	output wire [2:0]         hsize,
	output wire [2:0]         hburst,
	output wire [3:0]         hprot,
	output wire               hmastlock,
	output wire [7:0]         hmaster,
	output wire               hexcl,
	input  wire               hready,
	input  wire               hresp,
	input  wire               hexokay,
	output wire [W_DATA-1:0]  hwdata,
	input  wire [W_DATA-1:0]  hrdata

	// Observability ports (read-only taps into the core) — see hz3_probe.vh.
`include "hz3_probe_ports.vh"
);

// Configuration localparams (EXTENSION_*, CSR_*, NUM_IRQS, ...).
`include "config_viz.vh"

// ----------------------------------------------------------------------------
// Power-up handshake: acknowledge immediately (reset asserts ack so the core
// may start fetching out of reset).
reg pwrup_ack_r;
wire pwrup_req;
wire clk_en;
wire unblock_out;
always @(posedge clk or negedge rst_n) begin
	if (!rst_n)
		pwrup_ack_r <= 1'b1;
	else
		pwrup_ack_r <= pwrup_req;
end

// Fence handshake: no caches to flush, so always ready.
wire fence_i_vld;
wire fence_d_vld;

hazard3_cpu_1port #(
`include "hazard3_config_inst.vh"
) cpu (
	.clk                        (clk),
	.clk_always_on              (clk),
	.rst_n                      (rst_n),

	.pwrup_req                  (pwrup_req),
	.pwrup_ack                  (pwrup_ack_r),
	.clk_en                     (clk_en),
	.unblock_out                (unblock_out),
	.unblock_in                 (unblock_out),

	.haddr                      (haddr),
	.hwrite                     (hwrite),
	.htrans                     (htrans),
	.hsize                      (hsize),
	.hburst                     (hburst),
	.hprot                      (hprot),
	.hmastlock                  (hmastlock),
	.hmaster                    (hmaster),
	.hexcl                      (hexcl),
	.hready                     (hready),
	.hresp                      (hresp),
	.hexokay                    (hexokay),
	.hwdata                     (hwdata),
	.hrdata                     (hrdata),

	.fence_i_vld                (fence_i_vld),
	.fence_d_vld                (fence_d_vld),
	.fence_rdy                  (1'b1),

	// Debug: disabled (DEBUG_SUPPORT = 0). Tie inputs off, leave outputs open.
	.dbg_req_halt               (1'b0),
	.dbg_req_halt_on_reset      (1'b0),
	.dbg_req_resume             (1'b0),
	.dbg_halted                 (/* open */),
	.dbg_running                (/* open */),
	.dbg_data0_rdata            (32'h0),
	.dbg_data0_wdata            (/* open */),
	.dbg_data0_wen              (/* open */),
	.dbg_instr_data             (32'h0),
	.dbg_instr_data_vld         (1'b0),
	.dbg_instr_data_rdy         (/* open */),
	.dbg_instr_caught_exception (/* open */),
	.dbg_instr_caught_ebreak    (/* open */),
	.dbg_sbus_addr              (32'h0),
	.dbg_sbus_write             (1'b0),
	.dbg_sbus_size              (2'h0),
	.dbg_sbus_vld               (1'b0),
	.dbg_sbus_rdy               (/* open */),
	.dbg_sbus_err               (/* open */),
	.dbg_sbus_wdata             (32'h0),
	.dbg_sbus_rdata             (/* open */),

	.mhartid_val                (32'h0),
	.eco_version                (4'h0),

	// Interrupts: tied off for now.
	.irq                        ({NUM_IRQS{1'b0}}),
	.soft_irq                   (1'b0),
	.timer_irq                  (1'b0)
);

// ----------------------------------------------------------------------------
// Observability. Reads only; drives nothing inside the core.
`include "hz3_probe.vh"

endmodule

`default_nettype wire
