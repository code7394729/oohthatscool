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

# Sets RUNTIME_SRCS to the Verilator runtime .cpp files this model needs
# linked, as absolute paths. Call after verilating; needs VROOT.
#
#   resolve_runtime_srcs <obj-dir> <prefix>     e.g. build/wasm/obj_dir Vhz3_top
#
# Verilator writes the list into the makefile it generates, as VM_GLOBAL_FAST
# and VM_GLOBAL_SLOW. Reading it back beats hard-coding "verilated.cpp and
# verilated_threads.cpp": which files the runtime needs is a property of the
# Verilator version and of what the design uses, and newer Verilators ship
# several more (verilated_timing, verilated_random, ...) that a design can pull
# in. make itself does the parsing, so the format is Verilator's business.
resolve_runtime_srcs() {
	local objdir="$1" prefix="$2"
	local mk="$objdir/${prefix}_classes.mk"
	if [ ! -f "$mk" ]; then
		echo "error: $mk not found — verilate before calling resolve_runtime_srcs" >&2
		exit 1
	fi

	local names
	names="$(printf 'include %s\nall:\n\t@echo $(VM_GLOBAL_FAST) $(VM_GLOBAL_SLOW)\n' "$mk" \
		| make -f - --no-print-directory all)" || {
		echo "error: could not read the runtime file list out of $mk" >&2
		exit 1
	}

	RUNTIME_SRCS=()
	local n
	for n in $names; do
		if [ ! -f "$VROOT/include/$n.cpp" ]; then
			echo "error: $mk names $n, but $VROOT/include/$n.cpp does not exist" >&2
			exit 1
		fi
		RUNTIME_SRCS+=("$VROOT/include/$n.cpp")
	done

	if [ "${#RUNTIME_SRCS[@]}" -eq 0 ]; then
		echo "error: $mk listed no runtime sources" >&2
		exit 1
	fi
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
