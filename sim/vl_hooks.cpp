/*
 * vl_hooks.cpp — replace Verilator's default $finish / $stop / $fatal handlers.
 *
 * Verilator's stock handlers call exit() or abort(). Under Emscripten that
 * tears down the whole WASM instance, so a single assertion inside the core
 * would take the page with it and leave the user staring at a dead diagram with
 * no explanation. Here they instead record what happened and let the caller ask
 * (docs/design.md §8, "tame $finish/$fatal").
 *
 * Built into the native binaries too, so the two builds behave identically and
 * the native tests exercise the same path the browser does.
 */
#include "vl_hooks.h"

#include "verilated.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

namespace hz3 {

static SimFault g_fault;

const SimFault &fault() { return g_fault; }
void clear_fault() { g_fault = SimFault{}; }

static void record(SimFault::Kind kind, const char *filename, int linenum,
                   const char *hier, const char *msg) {
	if (g_fault.kind != SimFault::None)
		return; // keep the first one; later ones are usually consequences
	g_fault.kind = kind;
	g_fault.file = filename ? filename : "";
	g_fault.line = linenum;
	g_fault.hier = hier ? hier : "";
	g_fault.message = msg ? msg : "";
}

} // namespace hz3

void vl_finish(const char *filename, int linenum, const char *hier) VL_MT_UNSAFE {
	hz3::record(hz3::SimFault::Finish, filename, linenum, hier, "$finish");
	Verilated::runFlushCallbacks();
}

void vl_stop(const char *filename, int linenum, const char *hier) VL_MT_UNSAFE {
	hz3::record(hz3::SimFault::Stop, filename, linenum, hier, "$stop");
	Verilated::runFlushCallbacks();
}

void vl_fatal(const char *filename, int linenum, const char *hier,
              const char *msg) VL_MT_UNSAFE {
	hz3::record(hz3::SimFault::Fatal, filename, linenum, hier, msg);
	Verilated::runFlushCallbacks();
	// A fatal means the model's own invariants are broken, so continuing to
	// clock it would produce nonsense. Callers check hz3::fault() after
	// stepping; the simulation loop stops there rather than here, so a hosted
	// front end can still show the state that led to it.
}
