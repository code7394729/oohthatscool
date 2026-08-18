/*
 * bridge.cpp — Embind bindings: the WASM face of the simulator.
 *
 * Layer B of the design (docs/design.md §5). Deliberately thin — it owns no
 * state of its own beyond a Soc, and everything crossing into JavaScript is
 * plain data. The snapshot crosses as a JSON string rather than a marshalled
 * object graph, which means the browser, the Node CLI and the native tracer all
 * consume byte-identical state, and UI code can be tested against a recorded
 * trace with no WASM in the picture at all.
 *
 * Nothing here is browser-specific: the same module loads under Node, which is
 * where its tests run (js/test/run.mjs).
 */
#include "soc.h"
#include "vl_hooks.h"

#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <string>
#include <vector>

using namespace emscripten;

namespace {

class Sim {
public:
	Sim() { soc.set_echo(false); }

	// ---- program ----------------------------------------------------------

	// bytes: a Uint8Array (or any array-like of numbers) holding a flat image.
	void loadProgram(val bytes, uint32_t addr) {
		std::vector<uint8_t> v = convertJSArrayToNumberVector<uint8_t>(bytes);
		soc.load_bin(v.data(), v.size(), addr);
	}

	void reset() { soc.hard_reset(); }

	// ---- clocking ---------------------------------------------------------

	void stepCycle() { soc.step(); }

	val stepInstruction(double maxCycles) {
		return result(soc.step_instruction((uint64_t)maxCycles));
	}

	// breakPC: pass 0xffffffff to disable.
	val run(double maxCycles, uint32_t breakPC) {
		return result(soc.run((uint64_t)maxCycles, breakPC));
	}

	// ---- state ------------------------------------------------------------

	std::string snapshotJson() const { return soc.snapshot_json(); }

	double cycles() const  { return (double)soc.cycles; }
	double retired() const { return (double)soc.retired; }
	bool   exited() const  { return soc.exited; }
	uint32_t exitCode() const { return soc.exit_code; }

	uint32_t readMem(uint32_t addr) const { return soc.read_mem(addr); }
	void writeMem(uint32_t addr, uint32_t data) { soc.write_mem(addr, data); }

	// Characters the program has written to the MMIO console since the last
	// call. Polled rather than pushed so the host decides when to touch the DOM.
	std::string drainOutput() { return soc.drain_output(); }

	// A $finish / $stop / $fatal from inside the model, if one happened. Null
	// when the model is healthy, which is the normal case.
	val fault() const {
		const hz3::SimFault &f = hz3::fault();
		if (!f.active()) return val::null();
		val o = val::object();
		o.set("kind", std::string(f.kindName()));
		o.set("file", f.file);
		o.set("line", f.line);
		o.set("hier", f.hier);
		o.set("message", f.message);
		return o;
	}

	// Constants the UI would otherwise have to hardcode.
	static val memoryMap() {
		val o = val::object();
		o.set("memBase", (double)Soc::MEM_BASE);
		o.set("memSize", (double)Soc::MEM_SIZE);
		o.set("ioBase", (double)Soc::IO_BASE);
		o.set("ioPrintChar", (double)(Soc::IO_BASE + Soc::IO_PRINT_CHAR));
		o.set("ioPrintU32", (double)(Soc::IO_BASE + Soc::IO_PRINT_U32));
		o.set("ioExit", (double)(Soc::IO_BASE + Soc::IO_EXIT));
		o.set("noBreak", (double)Soc::NO_BREAK);
		return o;
	}

private:
	static val result(const Soc::RunResult &r) {
		val o = val::object();
		o.set("reason", std::string(Soc::stopReasonName(r.reason)));
		o.set("cycles", (double)r.cycles);
		o.set("retired", (double)r.retired);
		return o;
	}

	Soc soc;
};

} // namespace

EMSCRIPTEN_BINDINGS(hz3) {
	class_<Sim>("Sim")
		.constructor<>()
		.function("loadProgram", &Sim::loadProgram)
		.function("reset", &Sim::reset)
		.function("stepCycle", &Sim::stepCycle)
		.function("stepInstruction", &Sim::stepInstruction)
		.function("run", &Sim::run)
		.function("snapshotJson", &Sim::snapshotJson)
		.function("cycles", &Sim::cycles)
		.function("retired", &Sim::retired)
		.function("exited", &Sim::exited)
		.function("exitCode", &Sim::exitCode)
		.function("readMem", &Sim::readMem)
		.function("writeMem", &Sim::writeMem)
		.function("drainOutput", &Sim::drainOutput)
		.function("fault", &Sim::fault)
		.class_function("memoryMap", &Sim::memoryMap);
}
