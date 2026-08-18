# rtl-files.sh — the RTL that makes up this SoC. Sourced by the build scripts.
#
# Hazard3 ships hdl/hazard3.f for this, but consuming it needs their `scripts/`
# submodule (an uninitialised sibling repo), so we keep an explicit list. It is
# hazard3.f minus the debug subsystem and the 2-port top, which this
# single-AHB-port build does not instantiate.
#
# Expects ROOT and H3 to be set; sets RTL.

RTL=(
	"$ROOT/rtl/hz3_top.v"
	"$H3/hazard3_core.v"
	"$H3/hazard3_cpu_1port.v"
	"$H3/arith/hazard3_alu.v"
	"$H3/arith/hazard3_branchcmp.v"
	"$H3/arith/hazard3_mul_fast.v"
	"$H3/arith/hazard3_muldiv_seq.v"
	"$H3/arith/hazard3_onehot_encode.v"
	"$H3/arith/hazard3_onehot_priority.v"
	"$H3/arith/hazard3_onehot_priority_dynamic.v"
	"$H3/arith/hazard3_priority_encode.v"
	"$H3/arith/hazard3_shift_barrel.v"
	"$H3/hazard3_csr.v"
	"$H3/hazard3_decode.v"
	"$H3/hazard3_frontend.v"
	"$H3/hazard3_instr_decompress.v"
	"$H3/hazard3_irq_ctrl.v"
	"$H3/hazard3_pmp.v"
	"$H3/hazard3_power_ctrl.v"
	"$H3/hazard3_regfile_1w2r.v"
	"$H3/hazard3_triggers.v"
)
