#!/usr/bin/env bash
# build-native.sh — Verilate the Hazard3 SoC and build the native executables.
#
# Fast feedback / correctness oracle: plain g++, no WASM in the way. The model
# is verilated once into a static library, then linked into each front end.
#
#   build/native/hz3_sim    CLI runner + JSONL snapshot tracer
#   build/native/hz3_test   probe + snapshot test suite (self-contained)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
H3="$ROOT/third_party/hazard3/hdl"
BUILD="$ROOT/build/native"
OBJ="$BUILD/obj_dir"

# shellcheck source=toolchain.sh
source "$ROOT/scripts/toolchain.sh"
# shellcheck source=rtl-files.sh
source "$ROOT/scripts/rtl-files.sh"

resolve_vroot

mkdir -p "$BUILD"

echo "== verilating =="
verilator --cc --build -j 0 \
	--top-module hz3_top \
	-Wno-fatal \
	-I"$H3" -I"$ROOT/rtl" \
	--Mdir "$OBJ" \
	"${RTL[@]}"

# VL_USER_{FINISH,STOP,FATAL}: use our handlers (sim/vl_hooks.cpp) rather than
# Verilator's exit()/abort() ones, so the native and WASM builds behave the same
# when the model raises something — and so the tests exercise that path.
CXXFLAGS=(-O2 -std=c++17
	-DVL_USER_FINISH -DVL_USER_STOP -DVL_USER_FATAL
	-I"$OBJ" -I"$VROOT/include" -I"$VROOT/include/vltstd"
	-I"$ROOT/sim" -I"$ROOT/sim/tests")

# The Verilator runtime and our hooks, compiled once and shared by both binaries.
echo "== building runtime =="
g++ "${CXXFLAGS[@]}" -c "$VROOT/include/verilated.cpp" -o "$BUILD/verilated.o"
g++ "${CXXFLAGS[@]}" -c "$VROOT/include/verilated_threads.cpp" -o "$BUILD/verilated_threads.o"
g++ "${CXXFLAGS[@]}" -c "$ROOT/sim/vl_hooks.cpp" -o "$BUILD/vl_hooks.o"

RUNTIME=("$OBJ/Vhz3_top__ALL.a" "$BUILD/verilated.o" "$BUILD/verilated_threads.o" "$BUILD/vl_hooks.o")

echo "== building hz3_sim =="
g++ "${CXXFLAGS[@]}" "$ROOT/sim/main.cpp" "${RUNTIME[@]}" -pthread -o "$BUILD/hz3_sim"

echo "== building hz3_test =="
g++ "${CXXFLAGS[@]}" "$ROOT/sim/tests/test_main.cpp" "${RUNTIME[@]}" -pthread -o "$BUILD/hz3_test"

echo "built $BUILD/hz3_sim and $BUILD/hz3_test"
