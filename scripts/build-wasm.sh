#!/usr/bin/env bash
# build-wasm.sh — the standalone WASM *program*.
#
# Same CLI as the native hz3_sim, compiled to WebAssembly and run under Node.
# It exists as the differential oracle: identical output, exit code and cycle
# count between this and the native build is what says the WASM port is faithful
# rather than merely compiling.
#
# For the importable library the browser and js/ use, see build-wasm-lib.sh.
#
# Two clean stages (see docs/design.md §8):
#   1. verilator --cc      : Verilog -> C++ (generate only, do NOT native-build)
#   2. em++                : C++ (+ Verilator runtime + harness) -> wasm/JS
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
H3="$ROOT/third_party/hazard3/hdl"
BUILD="$ROOT/build/wasm"
OBJ="$BUILD/obj_dir"

# shellcheck source=toolchain.sh
source "$ROOT/scripts/toolchain.sh"
# shellcheck source=rtl-files.sh
source "$ROOT/scripts/rtl-files.sh"

# EMXX / EMSDK / PATH / /opt/emsdk — see scripts/toolchain.sh.
resolve_emxx
resolve_vroot

mkdir -p "$BUILD"

echo "== stage 1: verilate to C++ =="
rm -rf "$OBJ"
verilator --cc --top-module hz3_top -Wno-fatal \
	-I"$H3" -I"$ROOT/rtl" --Mdir "$OBJ" \
	"${RTL[@]}"

echo "== stage 2: em++ -> wasm/js (node) =="
# NODERAWFS lets the same CLI harness read the real filesystem and argv under
# Node, so the WASM build behaves like the native one.
# -DVL_IGNORE_UNKNOWN_ARCH: Verilator's verilatedos.h has no VL_CPU_RELAX() for
# the wasm32 target and hard-errors; this built-in escape hatch defines it empty
# (a spin-relax hint is a no-op in single-threaded WASM). Avoids patching the
# installed Verilator headers.
# -DVL_USER_{FINISH,STOP,FATAL}: our handlers (sim/vl_hooks.cpp) record faults
# instead of aborting the instance.
"$EMXX" -O2 -std=c++17 \
	-DVL_IGNORE_UNKNOWN_ARCH \
	-DVL_USER_FINISH -DVL_USER_STOP -DVL_USER_FATAL \
	-I"$OBJ" -I"$VROOT/include" -I"$VROOT/include/vltstd" -I"$ROOT/sim" \
	"$OBJ"/*.cpp \
	"$VROOT/include/verilated.cpp" \
	"$VROOT/include/verilated_threads.cpp" \
	"$ROOT/sim/vl_hooks.cpp" \
	"$ROOT/sim/main.cpp" \
	-sALLOW_MEMORY_GROWTH=1 \
	-sNODERAWFS=1 \
	-sEXIT_RUNTIME=1 \
	-sENVIRONMENT=node \
	-o "$BUILD/hz3_sim.cjs"

echo "built $BUILD/hz3_sim.cjs"
