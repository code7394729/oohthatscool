/*
 * test_main.cpp — hz3_test, the native test wrapper for the probe and snapshot.
 *
 * An independently executable CLI: it takes no fixtures, needs no RISC-V
 * toolchain and no Node, builds every program it runs in memory (rv32_asm.h),
 * and exits nonzero if anything fails.
 *
 *   ./hz3_test                 run everything
 *   ./hz3_test --list          show test names
 *   ./hz3_test --filter blink  run tests whose name contains "blink"
 *   ./hz3_test -v              print each assertion group as it passes
 *
 * These tests are the argument that the visualizer is not lying. They check the
 * probe against the core's own accounting wherever the core keeps a second copy
 * of the same fact (minstret vs our retire count, the register file contents vs
 * the write strobe), and they check that each microarchitectural phenomenon the
 * UI claims to show is actually observable in the snapshot.
 */
#include "soc.h"
#include "rv32_asm.h"

#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <functional>
#include <stdexcept>
#include <string>
#include <vector>

using namespace rv;
using namespace hz3;

// ---------------------------------------------------------------------------
// A very small test framework

namespace {

struct TestCase {
	const char *name;
	std::function<void()> fn;
};

std::vector<TestCase> &registry() {
	static std::vector<TestCase> r;
	return r;
}

bool verbose = false;

struct Registrar {
	Registrar(const char *name, std::function<void()> fn) {
		registry().push_back({name, std::move(fn)});
	}
};

#define TEST(name)                                                   \
	static void name();                                              \
	static Registrar registrar_##name(#name, name);                  \
	static void name()

[[noreturn]] void fail(const std::string &msg, const char *file, int line) {
	throw std::runtime_error(std::string(file) + ":" + std::to_string(line) + ": " + msg);
}

#define CHECK(cond)                                                            \
	do { if (!(cond)) fail("CHECK failed: " #cond, __FILE__, __LINE__); } while (0)

#define CHECK_MSG(cond, msg)                                                   \
	do { if (!(cond)) fail(std::string("CHECK failed: " #cond " — ") + (msg),   \
	                       __FILE__, __LINE__); } while (0)

#define CHECK_EQ(a, b)                                                         \
	do {                                                                       \
		auto va_ = (a); auto vb_ = (b);                                        \
		if (!(va_ == (decltype(va_))vb_))                                      \
			fail("CHECK_EQ failed: " #a " == " #b " (" +                       \
			     std::to_string((long long)va_) + " vs " +                     \
			     std::to_string((long long)vb_) + ")", __FILE__, __LINE__);    \
	} while (0)

// Notes are buffered and printed after the test's pass/fail line, so a verbose
// run stays column-aligned.
std::vector<std::string> notes;

void note(const char *fmt, ...) {
	if (!verbose) return;
	char buf[512];
	va_list ap;
	va_start(ap, fmt);
	vsnprintf(buf, sizeof buf, fmt, ap);
	va_end(ap);
	notes.emplace_back(buf);
}

// Always shown, verbose or not — used when a test declines to run.
void report(const std::string &msg) { notes.push_back(msg); }

void flush_notes() {
	for (const std::string &n : notes)
		printf("      %s\n", n.c_str());
	notes.clear();
}

// ---------------------------------------------------------------------------
// Helpers

// Build a SoC with `a` loaded at the reset vector, quiet and freshly reset.
void load(Soc &soc, const Asm &a) {
	std::vector<uint8_t> image = a.bytes();
	soc.set_echo(false);
	soc.load_bin(image.data(), image.size());
	soc.hard_reset();
}

// Step `n` cycles, calling `f(snapshot)` after each. Stops early if the program
// exits.
template <class F>
void each_cycle(Soc &soc, uint64_t n, F &&f) {
	for (uint64_t i = 0; i < n && !soc.exited; ++i) {
		soc.step();
		f(soc.snapshot());
	}
}

// Step until `pred` accepts a snapshot; returns that cycle, or 0 if the budget
// ran out. Leaves the model parked on the matching cycle so the caller can
// inspect it.
template <class Pred>
uint64_t find_cycle(Soc &soc, uint64_t budget, Pred &&pred) {
	for (uint64_t i = 0; i < budget && !soc.exited; ++i) {
		soc.step();
		if (pred(soc.snapshot())) return soc.cycles;
	}
	return 0;
}

const char *bypassName(uint8_t b) {
	switch (b) {
	case BYPASS_NONE:    return "none";
	case BYPASS_REGFILE: return "regfile";
	case BYPASS_M:       return "M";
	case BYPASS_W:       return "W";
	default:             return "?";
	}
}

} // namespace

// ===========================================================================
// Reset and basic invariants
// ===========================================================================

TEST(reset_state_is_clean) {
	Asm a;
	a << nop() << nop();
	a.park();

	Soc soc;
	load(soc, a);

	Snapshot s = soc.snapshot();
	CHECK_EQ(s.cycle, 0u);
	CHECK_EQ(s.retired, 0u);
	CHECK(!s.exited);
	for (int i = 0; i < 32; ++i) {
		CHECK_MSG(s.regs[i].value == 0, "register not zeroed out of reset");
		CHECK_EQ(s.regs[i].writes, 0u);
		CHECK_EQ(s.regs[i].lastWriteCycle, NEVER);
		CHECK_EQ(s.regs[i].lastReadCycle, NEVER);
	}
}

TEST(x0_is_never_written) {
	// Instructions targeting x0 are legal and execute; the hardware simply
	// suppresses the register write. Showing x0 blinking would be a lie.
	Asm a;
	a << addi(x0, x0, 1)
	  << addi(x0, x0, 2)
	  << add(x0, x0, x0);
	a.park();

	Soc soc;
	load(soc, a);

	each_cycle(soc, 100, [](const Snapshot &s) {
		CHECK_EQ(s.regs[0].value, 0u);
		CHECK_EQ(s.regs[0].writes, 0u);
	});
}

TEST(cycle_counter_advances_one_per_step) {
	Asm a;
	a.park();

	Soc soc;
	load(soc, a);

	for (uint64_t i = 1; i <= 50; ++i) {
		soc.step();
		CHECK_EQ(soc.snapshot().cycle, i);
	}
}

// ===========================================================================
// Register update indication ("blinking")
// ===========================================================================

TEST(blink_survives_rewriting_the_same_value) {
	// The point of the whole write-strobe design. Four writes of 7 into a
	// register that already holds 7, and four writes of 0 into a register that
	// has held 0 since reset. Value-diffing sees nothing at all here; the UI
	// must still show eight register writes.
	Asm a;
	a << addi(t0, x0, 7)     // t0 = 7   (a real change)
	  << addi(t0, x0, 7)     // t0 = 7   (no change in value)
	  << addi(t0, x0, 7)
	  << addi(t0, x0, 7)
	  << add(t1, x0, x0)     // t1 = 0, and t1 was already 0
	  << add(t1, x0, x0)
	  << add(t1, x0, x0)
	  << add(t1, x0, x0);
	a.park();

	Soc soc;
	load(soc, a);

	uint64_t t0_writes = 0, t1_writes = 0;
	int64_t  last_t0_cycle = NEVER, last_t1_cycle = NEVER;

	each_cycle(soc, 200, [&](const Snapshot &s) {
		const RegView &r0 = s.regs[t0];
		const RegView &r1 = s.regs[t1];

		// Values only ever take the one expected value...
		CHECK(r0.value == 0 || r0.value == 7);
		CHECK_EQ(r1.value, 0u);

		// ...but writes keep arriving, and each one is a distinct cycle.
		if (r0.writes != t0_writes) {
			CHECK_MSG(r0.writes == t0_writes + 1, "writes must advance one at a time");
			CHECK_MSG(r0.lastWriteCycle > last_t0_cycle, "lastWriteCycle must advance");
			CHECK_EQ(r0.lastWriteCycle, (int64_t)s.cycle);
			t0_writes = r0.writes;
			last_t0_cycle = r0.lastWriteCycle;
		}
		if (r1.writes != t1_writes) {
			CHECK_EQ(r1.writes, t1_writes + 1);
			CHECK_MSG(r1.lastWriteCycle > last_t1_cycle, "lastWriteCycle must advance");
			t1_writes = r1.writes;
			last_t1_cycle = r1.lastWriteCycle;
		}
	});

	note("t0 writes=%llu t1 writes=%llu", (unsigned long long)t0_writes,
	     (unsigned long long)t1_writes);
	CHECK_MSG(t0_writes == 4, "four writes of 7 must all be observable");
	CHECK_MSG(t1_writes == 4, "four writes of 0 into an already-zero register must all be observable");
}

TEST(write_strobe_agrees_with_the_register_file) {
	// The write indication and the register panel come from different places:
	// the strobe from m_reg_wen, the values straight out of the core's storage
	// array. If they ever disagreed the UI would flash the wrong register, so
	// pin them together: on the cycle a write is reported, the register file
	// must already show the value the write port carried.
	Asm a;
	a << lui(sp, 0x81000)
	  << addi(t0, x0, 100)
	  << addi(t1, t0, 5)          // forwarded operand
	  << sw(t1, sp, 0)
	  << lw(t2, sp, 0)
	  << add(a0, t2, t1)
	  << mul(a1, t0, t1)
	  << sub(t2, a1, a0);
	a.park();

	Soc soc;
	load(soc, a);

	int checked = 0;
	each_cycle(soc, 400, [&](const Snapshot &s) {
		for (unsigned i = 1; i < 32; ++i) {
			if (s.regs[i].lastWriteCycle != (int64_t)s.cycle) continue;
			CHECK_EQ(s.regs[i].value, soc.tracker()[i].lastWriteValue);
			++checked;
		}
	});
	note("checked %d write/readback pairs", checked);
	CHECK_MSG(checked >= 6, "expected several register writes in this program");
}

TEST(reads_are_attributed_to_the_consuming_cycle) {
	Asm a;
	a << addi(t0, x0, 3)
	  << addi(t1, x0, 4)
	  << nop() << nop() << nop()
	  << add(t2, t0, t1);       // reads t0 and t1
	a.park();

	Soc soc;
	load(soc, a);

	uint64_t read_cycle = find_cycle(soc, 200, [&](const Snapshot &s) {
		return s.x.valid && s.x.pc == a.addr_of(5);
	});
	CHECK_MSG(read_cycle != 0, "never saw the add reach X");

	Snapshot s = soc.snapshot();
	CHECK_EQ(s.x.rs1, (unsigned)t0);
	CHECK_EQ(s.x.rs2, (unsigned)t1);
	CHECK_EQ(s.regs[t0].lastReadCycle, (int64_t)read_cycle);
	CHECK_EQ(s.regs[t1].lastReadCycle, (int64_t)read_cycle);
	CHECK_MSG(s.regs[a0].lastReadCycle != (int64_t)read_cycle,
	          "a register this instruction does not read must not be marked read");
}

// ===========================================================================
// The phenomena the visualizer exists to show
// ===========================================================================

TEST(dependent_add_takes_its_operand_from_the_bypass_network) {
	// Back-to-back dependent adds. When the second is in X the first is in M,
	// so the operand must come from the X|M result, not the register file.
	Asm a;
	a << addi(t0, x0, 41)
	  << addi(t1, t0, 1);      // rs1 = t0, produced by the instruction ahead
	a.park();

	Soc soc;
	load(soc, a);

	uint64_t c = find_cycle(soc, 200, [&](const Snapshot &s) {
		return s.x.valid && s.x.pc == a.addr_of(1);
	});
	CHECK_MSG(c != 0, "second add never reached X");

	Snapshot s = soc.snapshot();
	note("bypassA=%s rs1Bypass=%u opA=%u", bypassName(s.x.bypassA), s.x.rs1Bypass, s.x.opA);
	CHECK_EQ(s.x.bypassA, (uint8_t)BYPASS_M);
	CHECK_MSG(s.x.rs1Bypass == 41, "forwarded value must be the one still in flight");
	CHECK_MSG(s.x.opA == 41, "the ALU must see the forwarded value");
	CHECK_MSG(s.regs[t0].value != 41, "the register file has not been updated yet — that is the point");
}

TEST(load_use_raises_the_interlock) {
	// The one hazard a full bypass network cannot paper over: the load result
	// does not exist yet when the consumer needs it.
	Asm a;
	a << lui(sp, 0x81000)
	  << lw(t0, sp, 0)
	  << add(t1, t0, t0);      // needs the load result immediately
	a.park();

	Soc soc;
	load(soc, a);

	bool saw_raw = false;
	uint64_t raw_cycle = 0;
	each_cycle(soc, 300, [&](const Snapshot &s) {
		if (s.x.stallCause & STALL_RAW) {
			saw_raw = true;
			if (!raw_cycle) raw_cycle = s.cycle;
			CHECK_MSG(s.x.stall, "a stall cause implies x_stall");
			CHECK_MSG(std::string(stallReasonName(s.x.stallCause)) == "load-use",
			          "load-use must win the reason ranking");
		}
	});
	note("first load-use stall at cycle %llu", (unsigned long long)raw_cycle);
	CHECK_MSG(saw_raw, "no load-use interlock observed");
}

TEST(sequential_muldiv_parks_the_execute_stage) {
	// MULDIV_UNROLL = 1, so the sequential unit takes many cycles and X sits
	// still while it works — the stall students can actually watch.
	Asm a;
	a << addi(t0, x0, 1000)
	  << addi(t1, x0, 7)
	  << nop() << nop()
	  << mul(t2, t0, t1);
	a.park();

	Soc soc;
	load(soc, a);

	int run = 0, longest = 0;
	each_cycle(soc, 300, [&](const Snapshot &s) {
		if (s.x.stallCause & STALL_MULDIV) {
			++run;
			if (run > longest) longest = run;
		} else {
			run = 0;
		}
	});
	note("longest mul/div stall run: %d cycles", longest);
	CHECK_MSG(longest >= 8, "a 32-bit sequential multiply should hold X for many cycles");

	CHECK_EQ(soc.snapshot().regs[t2].value, 7000u);
}

TEST(taken_branch_redirects_the_front_end) {
	Asm a;
	a << addi(t0, x0, 1)
	  << beq(x0, x0, 12)       // always taken, over the next two instructions
	  << addi(t1, x0, 0xbad)   // must never execute
	  << addi(t1, x0, 0xbad)
	  << addi(t2, x0, 9);      // branch target
	a.park();

	Soc soc;
	load(soc, a);

	bool saw_jump = false, saw_starve_after_jump = false;
	uint64_t jump_cycle = 0;
	each_cycle(soc, 300, [&](const Snapshot &s) {
		if (s.x.jumpReq && !saw_jump) {
			saw_jump = true;
			jump_cycle = s.cycle;
			CHECK_MSG(s.f.jumpReq, "the front end must see the redirect request");
		}
		// The flush shows up as the front end running dry behind the branch.
		if (saw_jump && s.cycle > jump_cycle && s.x.starved)
			saw_starve_after_jump = true;
	});

	note("jump requested at cycle %llu", (unsigned long long)jump_cycle);
	CHECK_MSG(saw_jump, "branch never requested a redirect");
	CHECK_MSG(saw_starve_after_jump, "no front-end bubble after the taken branch");

	Snapshot s = soc.snapshot();
	CHECK_MSG(s.regs[t1].writes == 0, "instructions behind a taken branch must not commit");
	CHECK_EQ(s.regs[t2].value, 9u);
}

// ===========================================================================
// Pipeline bookkeeping the probe adds itself
// ===========================================================================

TEST(m_stage_shadow_tracks_the_instruction_leaving_x) {
	// Hazard3 keeps no PC in M and no "this slot holds a real instruction" bit,
	// so hz3_probe.vh shadows both. If the shadow drifted, the datapath would
	// label M with the wrong instruction — check it against what X issued.
	Asm a;
	a << addi(t0, x0, 1)
	  << addi(t1, x0, 2)
	  << addi(t2, x0, 3)
	  << add(a0, t0, t1)
	  << add(a1, a0, t2);
	a.park();

	Soc soc;
	load(soc, a);

	bool prev_issue = false;
	uint32_t prev_pc = 0, prev_instr = 0;
	bool prev_m_stall = false;
	int matched = 0;

	each_cycle(soc, 300, [&](const Snapshot &s) {
		if (!prev_m_stall) {
			CHECK_EQ(s.m.valid, prev_issue);
			if (prev_issue) {
				CHECK_MSG(s.m.pc == prev_pc, "M shows a different PC than X issued");
				CHECK_MSG(s.m.instr == prev_instr, "M shows a different instruction than X issued");
				++matched;
			}
		}
		prev_issue   = s.x.issue;
		prev_pc      = s.x.pc;
		prev_instr   = s.x.instr;
		prev_m_stall = s.m.stall;
	});
	note("matched %d X->M handoffs", matched);
	CHECK_MSG(matched >= 5, "expected at least one handoff per instruction");
}

TEST(retire_count_matches_the_cores_own_minstret) {
	// Our instruction count is derived from x_instr_ret; the core derives
	// minstret from the same signal but keeps it in a CSR we read separately.
	// They must move together. (Hazard3 resets mcountinhibit to "inhibited",
	// so the program has to start the counters first.)
	Asm a;
	a << csrrwi(x0, CSR_MCOUNTINHIBIT, 0)
	  << addi(t0, x0, 1)
	  << addi(t1, x0, 2)
	  << add(t2, t0, t1)
	  << mul(a0, t2, t2)
	  << addi(a1, a0, -1);
	a.park();

	Soc soc;
	load(soc, a);

	bool counting = false;
	uint64_t base_retired = 0;
	int checks = 0;

	each_cycle(soc, 400, [&](const Snapshot &s) {
		if (!counting) {
			if (s.csr.minstret == 0) { base_retired = s.retired; return; }
			counting = true; // first counted instruction; calibrate the offset
		}
		CHECK_MSG(s.csr.minstret == s.retired - base_retired,
		          "our retire count drifted from minstret");
		++checks;
	});
	note("cross-checked minstret on %d cycles (offset %llu)", checks,
	     (unsigned long long)base_retired);
	CHECK_MSG(checks > 20, "counters never started");
	CHECK_MSG(soc.snapshot().csr.mcycle > 0, "mcycle should be running too");
}

TEST(step_instruction_advances_exactly_one_instruction) {
	Asm a;
	a << addi(t0, x0, 1)
	  << lui(sp, 0x81000)
	  << lw(t1, sp, 0)
	  << add(t2, t1, t1)       // stalls; step_instruction must still land on one
	  << mul(a0, t0, t0);      // multi-cycle; likewise
	a.park();

	Soc soc;
	load(soc, a);

	for (int i = 0; i < 6; ++i) {
		uint64_t before = soc.retired;
		Soc::RunResult r = soc.step_instruction();
		CHECK_MSG(r.reason == Soc::StopReason::Retired, "step_instruction did not retire anything");
		CHECK_EQ(soc.retired, before + 1);
		CHECK_MSG(r.cycles >= 1, "an instruction takes at least a cycle");
	}
}

TEST(breakpoints_stop_on_the_requested_pc) {
	Asm a;
	a << addi(t0, x0, 1)
	  << addi(t1, x0, 2)
	  << addi(t2, x0, 3)
	  << addi(a0, x0, 4);
	a.park();

	Soc soc;
	load(soc, a);

	Soc::RunResult r = soc.run(500, a.addr_of(2));
	CHECK_MSG(r.reason == Soc::StopReason::Breakpoint, "breakpoint never hit");

	Snapshot s = soc.snapshot();
	CHECK_EQ(s.x.pc, a.addr_of(2));
	CHECK_MSG(s.regs[t2].writes == 0, "stopped too late: the breakpointed instruction already committed");
}

// ===========================================================================
// The seam itself
// ===========================================================================

TEST(snapshot_json_is_well_formed_and_complete) {
	Asm a;
	a << addi(t0, x0, 5) << addi(t1, t0, 5);
	a.park();

	Soc soc;
	load(soc, a);
	soc.run(60);

	std::string j = soc.snapshot_json();
	CHECK_MSG(!j.empty() && j.front() == '{' && j.back() == '}', "not a JSON object");

	int depth = 0, brackets = 0;
	bool in_string = false;
	for (size_t i = 0; i < j.size(); ++i) {
		char c = j[i];
		if (in_string) { if (c == '"') in_string = false; continue; }
		if      (c == '"') in_string = true;
		else if (c == '{') ++depth;
		else if (c == '}') --depth;
		else if (c == '[') ++brackets;
		else if (c == ']') --brackets;
		CHECK_MSG(depth >= 0 && brackets >= 0, "unbalanced JSON");
	}
	CHECK_EQ(depth, 0);
	CHECK_EQ(brackets, 0);
	CHECK_MSG(!in_string, "unterminated JSON string");

	for (const char *k : {"\"cycle\":", "\"retired\":", "\"f\":", "\"x\":", "\"m\":",
	                      "\"regs\":", "\"csr\":", "\"bus\":", "\"stallReason\":",
	                      "\"writes\":", "\"lastWriteCycle\":"})
		CHECK_MSG(j.find(k) != std::string::npos, k);

	// Exactly 32 register entries.
	int count = 0;
	for (size_t p = j.find("\"value\":"); p != std::string::npos;
	     p = j.find("\"value\":", p + 1))
		++count;
	CHECK_EQ(count, 32);
	note("snapshot is %zu bytes of JSON", j.size());
}

TEST(stall_causes_always_have_a_name) {
	// The UI leans on stallReason; make sure no reachable bitmap falls through
	// to "unknown".
	Asm a;
	a << lui(sp, 0x81000)
	  << addi(t0, x0, 21)
	  << lw(t1, sp, 0)
	  << add(t2, t1, t1)
	  << mul(a0, t0, t0)
	  << sw(a0, sp, 4)
	  << beq(x0, x0, 4)
	  << addi(a1, x0, 1);
	a.park();

	Soc soc;
	load(soc, a);

	int distinct = 0;
	bool seen[256] = {false};
	each_cycle(soc, 500, [&](const Snapshot &s) {
		if (seen[s.x.stallCause]) return;
		seen[s.x.stallCause] = true;
		++distinct;
		CHECK_MSG(std::string(stallReasonName(s.x.stallCause)) != "unknown",
		          "no name for this stall cause bitmap");
		CHECK_MSG(s.x.stall == (s.x.stallCause != 0) ||
		          // starvation is reported as a cause but is not itself x_stall
		          (s.x.stallCause == STALL_STARVED),
		          "stall flag and stall cause disagree");
	});
	note("saw %d distinct stall-cause bitmaps", distinct);
	CHECK(distinct >= 3);
}

TEST(hello_program_still_runs_end_to_end) {
	// The one test that uses a toolchain-built image, and only if it is there:
	// keeps hz3_test runnable on a machine with no RISC-V GCC.
	Soc soc;
	soc.set_echo(false);
	if (!soc.load_file("programs/hello/build/hello.bin")) {
		report("(skipped: programs/hello/build/hello.bin not built)");
		return;
	}
	soc.hard_reset();
	soc.run(200000);

	CHECK_MSG(soc.exited, "program did not reach the exit register");
	CHECK_EQ(soc.exit_code, 123u);
	CHECK_MSG(soc.take_output().find("Hello, world") != std::string::npos,
	          "program output missing");
	note("%llu cycles, %llu instructions", (unsigned long long)soc.cycles,
	     (unsigned long long)soc.retired);
}

// ===========================================================================

int main(int argc, char **argv) {
	Verilated::commandArgs(argc, argv);

	std::string filter;
	bool list = false;
	for (int i = 1; i < argc; ++i) {
		std::string a = argv[i];
		if      (a == "--list")                    list = true;
		else if (a == "-v" || a == "--verbose")    verbose = true;
		else if (a == "--filter" && i + 1 < argc)  filter = argv[++i];
		else if (a == "--help") {
			printf("usage: %s [--list] [--filter SUBSTR] [-v]\n", argv[0]);
			return 0;
		}
	}

	if (list) {
		for (const TestCase &t : registry())
			printf("%s\n", t.name);
		return 0;
	}

	int passed = 0, failed = 0, skipped = 0;
	for (const TestCase &t : registry()) {
		if (!filter.empty() && std::string(t.name).find(filter) == std::string::npos) {
			++skipped;
			continue;
		}
		printf("  %-52s ", t.name);
		fflush(stdout);
		try {
			t.fn();
			printf("ok\n");
			++passed;
		} catch (const std::exception &e) {
			printf("FAILED\n      %s\n", e.what());
			++failed;
		}
		flush_notes();
	}

	printf("\n%d passed, %d failed", passed, failed);
	if (skipped) printf(", %d filtered out", skipped);
	printf("\n");
	return failed ? 1 : 0;
}
