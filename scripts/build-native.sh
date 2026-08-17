#!/usr/bin/env bash
# build-native.sh — Verilate the Hazard3 SoC and build the native CLI harness.
#
# Fast feedback / correctness oracle: this is plain g++, no WASM in the way.
# Produces build/native/obj_dir/hz3_sim.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
H3="$ROOT/third_party/hazard3/hdl"
BUILD="$ROOT/build/native"
mkdir -p "$BUILD"

# Core + arithmetic RTL (from hdl/hazard3.f, minus the debug subsystem and the
# 2-port top, which this single-port build does not use).
RTL=(
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

verilator --cc --exe --build -j 0 \
	--top-module hz3_top \
	-Wno-fatal \
	-I"$H3" -I"$ROOT/rtl" \
	--Mdir "$BUILD/obj_dir" \
	-CFLAGS "-I$ROOT/sim -O2" \
	-o hz3_sim \
	"$ROOT/rtl/hz3_top.v" "${RTL[@]}" \
	"$ROOT/sim/main.cpp"

echo "built $BUILD/obj_dir/hz3_sim"
