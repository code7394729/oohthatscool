#!/usr/bin/env bash
# test.sh — run everything.
#
#   1. tsc -b            typecheck and build the TypeScript
#   2. hz3_test          native C++: the probe, the snapshot, the write tracker
#   3. dist/test/run.js  TypeScript: blink policy, decoders, renderers, the
#                        datapath model / layout / scene / bindings, and the
#                        WASM bridge driven from Node
#   4. differential      the standalone WASM program against the native one,
#                        which is what keeps the port honest
#
# Anything not built is reported and skipped rather than failing, so this is
# usable on a partial checkout.
#
#   --build    build everything first
#   --strict   treat a skipped suite as a failure
#
# --strict is what CI runs: on a partial checkout "skipped" is the useful
# answer, but on a machine that is supposed to have built everything it is a
# failure wearing a friendly word — a suite that never ran cannot pass.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

build=0
strict=0
for arg in "$@"; do
	case "$arg" in
		--build)  build=1 ;;
		--strict) strict=1 ;;
		*) echo "usage: test.sh [--build] [--strict]" >&2; exit 2 ;;
	esac
done

if [ "$build" = 1 ]; then
	./scripts/build-native.sh   > /dev/null || exit 1
	./scripts/build-wasm-lib.sh > /dev/null || exit 1
	./scripts/build-wasm.sh     > /dev/null || exit 1
fi

status=0
run() {
	echo
	echo "== $1 =="
	shift
	"$@" || status=1
}

# A suite that could not run. Under --strict that is a failure, not a note.
skip() {
	echo
	if [ "$strict" = 1 ]; then
		echo "== $1: MISSING ($2) =="
		status=1
	else
		echo "== $1: skipped ($2) =="
	fi
}

if [ -d node_modules/typescript ]; then
	run "typescript build" npx tsc -b
else
	skip "typescript" "run npm install"
fi

if [ -x build/native/hz3_test ]; then
	run "native probe + snapshot tests" ./build/native/hz3_test
else
	skip "native tests" "run ./scripts/build-native.sh"
fi

if [ -f dist/test/run.js ]; then
	run "typescript tests" node dist/test/run.js
else
	skip "typescript tests" "run npm install && npm run build"
fi

# Differential: the two builds must agree exactly, down to the cycle.
if [ -x build/native/hz3_sim ] && [ -f build/wasm/hz3_sim.cjs ] && \
   [ -f programs/hello/build/hello.bin ]; then
	echo
	echo "== native vs wasm differential =="
	nat=$(./build/native/hz3_sim --bin programs/hello/build/hello.bin 2>&1; echo "rc=$?")
	wsm=$(node build/wasm/hz3_sim.cjs --bin programs/hello/build/hello.bin 2>&1; echo "rc=$?")
	if [ "$nat" = "$wsm" ]; then
		echo "  identical output, exit code and cycle count"
	else
		echo "  MISMATCH between native and wasm:"
		diff <(echo "$nat") <(echo "$wsm") | sed 's/^/    /'
		status=1
	fi
else
	skip "differential" "needs both builds and programs/hello"
fi

echo
[ $status -eq 0 ] && echo "all suites passed" || echo "FAILURES"
exit $status
