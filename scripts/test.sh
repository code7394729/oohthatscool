#!/usr/bin/env bash
# test.sh — run everything.
#
#   1. hz3_test          native C++: the probe, the snapshot, the write tracker
#   2. js/test/run.mjs   JavaScript: blink policy, decoders, renderers, and the
#                        WASM bridge driven from Node
#   3. differential      the standalone WASM program against the native one,
#                        which is what keeps the port honest
#
# Anything not built is reported and skipped rather than failing, so this is
# usable on a partial checkout. Pass --build to build everything first.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ "${1:-}" = "--build" ]; then
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

if [ -x build/native/hz3_test ]; then
	run "native probe + snapshot tests" ./build/native/hz3_test
else
	echo "== native tests: skipped (run ./scripts/build-native.sh) =="
fi

run "javascript tests" node js/test/run.mjs

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
	echo
	echo "== differential: skipped (needs both builds and programs/hello) =="
fi

echo
[ $status -eq 0 ] && echo "all suites passed" || echo "FAILURES"
exit $status
