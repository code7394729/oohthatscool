# toolchain.sh — locate the external tools the build needs. Sourced by the
# build scripts; sets EMXX and VROOT, or explains what is missing and exits.
#
# The point of this file is that "where is your Emscripten?" is answered in one
# place, the same way for every script, and the answer is overridable without
# editing anything.
#
# Emscripten, first match wins:
#
#   EMXX=/path/to/em++          an em++ binary, named exactly
#   EMSDK=/path/to/emsdk        an emsdk checkout; em++ is found inside it
#   em++ on PATH                i.e. you ran `source /path/to/emsdk/emsdk_env.sh`
#   /opt/emsdk                  the default this project documents
#
# EMSDK is also what emsdk_env.sh itself exports, so a sourced environment is
# picked up whichever of the two rules matches first.
#
# Verilator comes from PATH, and VERILATOR_ROOT (its include/ directory) is
# asked of the tool rather than guessed, so a hand-built Verilator works with
# no changes here.

# Sets EMXX to an executable em++, or exits 1 saying where it looked.
resolve_emxx() {
	if [ -n "${EMXX:-}" ]; then
		if [ ! -x "$EMXX" ]; then
			echo "error: EMXX=$EMXX is not an executable file" >&2
			exit 1
		fi
		return
	fi

	local candidates=()
	[ -n "${EMSDK:-}" ] && candidates+=("$EMSDK/upstream/emscripten/em++")
	local on_path
	on_path="$(command -v em++ 2>/dev/null || true)"
	[ -n "$on_path" ] && candidates+=("$on_path")
	candidates+=("/opt/emsdk/upstream/emscripten/em++")

	local c
	for c in "${candidates[@]}"; do
		if [ -x "$c" ]; then
			EMXX="$c"
			return
		fi
	done

	cat >&2 <<-MSG
	error: could not find Emscripten's em++. Looked at:
	$(printf '  %s\n' "${candidates[@]}")

	Point the build at your emsdk with either:
	  EMSDK=/path/to/emsdk $0
	  EMXX=/path/to/em++   $0
	or put em++ on PATH:
	  source /path/to/emsdk/emsdk_env.sh

	To install one where this project expects it:
	  git clone --depth 1 https://github.com/emscripten-core/emsdk /opt/emsdk
	  (cd /opt/emsdk && ./emsdk install latest && ./emsdk activate latest)
	MSG
	exit 1
}

# Sets VROOT to Verilator's root (the one holding include/verilated.cpp).
resolve_vroot() {
	if ! command -v verilator >/dev/null 2>&1; then
		echo "error: verilator is not on PATH (apt install verilator)" >&2
		exit 1
	fi
	VROOT="$(verilator --getenv VERILATOR_ROOT)"
	if [ ! -f "$VROOT/include/verilated.cpp" ]; then
		echo "error: no include/verilated.cpp under VERILATOR_ROOT=$VROOT" >&2
		exit 1
	fi
}
