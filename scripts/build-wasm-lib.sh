#!/usr/bin/env bash
# build-wasm-lib.sh — build the simulator as an importable WASM module.
#
# Unlike build-wasm.sh (which produces a standalone CLI program and exists as
# the differential oracle against the native build), this produces a *library*:
# an ES module exporting the Embind `Sim` class, loadable by Node and by the
# browser from the same file. Node is where its tests run, so the whole bridge
# is exercised without a browser anywhere in the loop.
#
#   build/wasm/hz3.mjs + hz3.wasm
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
H3="$ROOT/third_party/hazard3/hdl"
BUILD="$ROOT/build/wasm"
OBJ="$BUILD/obj_dir_lib"

EMXX="${EMXX:-/opt/emsdk/upstream/emscripten/em++}"
VROOT="$(verilator --getenv VERILATOR_ROOT)"

# shellcheck source=rtl-files.sh
source "$ROOT/scripts/rtl-files.sh"

mkdir -p "$BUILD"

echo "== stage 1: verilate to C++ =="
rm -rf "$OBJ"
verilator --cc --top-module hz3_top -Wno-fatal \
	-I"$H3" -I"$ROOT/rtl" --Mdir "$OBJ" \
	"${RTL[@]}"

echo "== stage 2: em++ -> ES module =="
# -DVL_IGNORE_UNKNOWN_ARCH : Verilator's verilatedos.h has no VL_CPU_RELAX() for
#   wasm32 and hard-errors; this built-in escape hatch defines it empty. A spin
#   hint is a no-op in a single-threaded runtime anyway.
# -DVL_USER_{FINISH,STOP,FATAL} : use our handlers (sim/vl_hooks.cpp) so a
#   $fatal inside the model records a fault instead of aborting the instance.
# verilated_threads.cpp is linked because verilated.cpp references VlThreadPool
#   even single-threaded; no -pthread, so no SharedArrayBuffer / COOP-COEP
#   requirement on the eventual static host.
# --no-entry : this is a library, there is no main().
"$EMXX" -O2 -std=c++17 \
	-DVL_IGNORE_UNKNOWN_ARCH \
	-DVL_USER_FINISH -DVL_USER_STOP -DVL_USER_FATAL \
	-I"$OBJ" -I"$VROOT/include" -I"$VROOT/include/vltstd" -I"$ROOT/sim" \
	"$OBJ"/*.cpp \
	"$VROOT/include/verilated.cpp" \
	"$VROOT/include/verilated_threads.cpp" \
	"$ROOT/sim/vl_hooks.cpp" \
	"$ROOT/sim/bridge.cpp" \
	--bind --no-entry \
	-sMODULARIZE=1 \
	-sEXPORT_ES6=1 \
	-sEXPORT_NAME=createHz3 \
	-sALLOW_MEMORY_GROWTH=1 \
	-sENVIRONMENT=node,web \
	-o "$BUILD/hz3.mjs"

echo "built $BUILD/hz3.mjs ($(stat -c%s "$BUILD/hz3.mjs") B) + hz3.wasm ($(stat -c%s "$BUILD/hz3.wasm") B)"
