#!/usr/bin/env bash
# build-wasm.sh — Verilate the Hazard3 SoC, then compile the model + harness to
# WebAssembly with Emscripten, runnable under Node.
#
# Two clean stages (see docs/design.md §8):
#   1. verilator --cc      : Verilog -> C++ (generate only, do NOT native-build)
#   2. em++                : C++ (+ Verilator runtime + harness) -> wasm/JS
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
H3="$ROOT/third_party/hazard3/hdl"
BUILD="$ROOT/build/wasm"
OBJ="$BUILD/obj_dir"

EMXX="${EMXX:-/opt/emsdk/upstream/emscripten/em++}"
VROOT="$(verilator --getenv VERILATOR_ROOT)"
mkdir -p "$BUILD"

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

echo "== stage 1: verilate to C++ =="
rm -rf "$OBJ"
verilator --cc --top-module hz3_top -Wno-fatal \
	-I"$H3" -I"$ROOT/rtl" --Mdir "$OBJ" \
	"$ROOT/rtl/hz3_top.v" "${RTL[@]}"

echo "== stage 2: em++ -> wasm/js (node) =="
# NODERAWFS lets the same CLI harness read the real filesystem and argv under
# Node, so the WASM build behaves like the native one.
# -DVL_IGNORE_UNKNOWN_ARCH: Verilator's verilatedos.h has no VL_CPU_RELAX() for
# the wasm32 target and hard-errors; this built-in escape hatch defines it empty
# (a spin-relax hint is a no-op in single-threaded WASM). Avoids patching the
# installed Verilator headers.
"$EMXX" -O2 -std=c++17 \
	-DVL_IGNORE_UNKNOWN_ARCH \
	-I"$OBJ" -I"$VROOT/include" -I"$VROOT/include/vltstd" -I"$ROOT/sim" \
	"$OBJ"/*.cpp \
	"$VROOT/include/verilated.cpp" \
	"$VROOT/include/verilated_threads.cpp" \
	"$ROOT/sim/main.cpp" \
	-sALLOW_MEMORY_GROWTH=1 \
	-sNODERAWFS=1 \
	-sEXIT_RUNTIME=1 \
	-sENVIRONMENT=node \
	-o "$BUILD/hz3_sim.js"

echo "built $BUILD/hz3_sim.js"
