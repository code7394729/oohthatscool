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

#ifdef __EMSCRIPTEN__
// ---------------------------------------------------------------------------
// CPU-affinity stubs for the Verilator runtime under Emscripten.
//
// Verilator's runtime asks the OS how many processors this process may run on,
// and pins its worker threads. It guards that code with
//
//     #if defined(__linux) || defined(CPU_ZERO)
//
// Emscripten does not define __linux, but its musl-derived <sched.h> *does*
// define CPU_ZERO, so the Linux arm is taken. Worse, <pthread.h> and <sched.h>
// declare sched_getcpu() and pthread_{get,set}affinity_np() without the
// sysroot implementing any of them — so this compiles cleanly and fails only
// at link, as three undefined symbols out of verilated.o and
// verilated_threads.o. Verilator 5.020 had no such call and linked fine; this
// appeared in the versions after it.
//
// Defining them here keeps the fix in a file we own, rather than patching the
// installed headers of either toolchain. The semantics are the honest ones for
// a single-threaded WASM runtime, not placeholders:
//
//   sched_getcpu()            0 — there is exactly one execution context, and
//                             its id is used only to label profiling output.
//   pthread_getaffinity_np()  ENOSYS — WASM has no affinity mask to report.
//                             Verilator documents 0 ("cannot be determined")
//                             as the result of this failing, and every call
//                             site handles it; the caller is NUMA assignment
//                             for a worker pool this build never creates.
//   pthread_setaffinity_np()  ENOSYS — nothing to pin, for the same reason.
//
// If a future Emscripten implements these for real, this stops linking with a
// duplicate-symbol error rather than silently diverging, which is the failure
// mode we want.
#include <cerrno>
#include <pthread.h>
#include <sched.h>

extern "C" {
int sched_getcpu(void) { return 0; }
int pthread_getaffinity_np(pthread_t, size_t, cpu_set_t *) { return ENOSYS; }
int pthread_setaffinity_np(pthread_t, size_t, const cpu_set_t *) { return ENOSYS; }
}
#endif // __EMSCRIPTEN__

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
