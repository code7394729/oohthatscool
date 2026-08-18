/*
 * tracker.h — per-register activity bookkeeping ("which registers just changed").
 *
 * WHY THIS EXISTS
 *
 * The obvious way to make a register flash when it updates is for the UI to
 * compare this frame's value against the last one. That is wrong on real
 * hardware, and wrong in a way that misteaches:
 *
 *   - `add x5, x0, x0` writes zero into a register that already held zero.
 *   - A loop counter reloaded with the same bound, `li x6, 10`, every pass.
 *   - `sub x7, x7, x7`, the idiomatic zeroing of an already-zero register.
 *   - Any store-to-same-value in a steady-state loop.
 *
 * Each is a genuine architectural write — the write port is active, the write
 * enable asserts, energy is spent — and a student watching the register file
 * should see it happen. Value-diffing shows nothing at all, which quietly
 * teaches that "no visible change" means "no work done".
 *
 * So the update indication is driven by the core's write *strobe*
 * (`m_reg_wen`, surfaced as p_m_reg_wen in hz3_probe.vh), sampled every cycle,
 * never by comparing values.
 *
 * WHAT WE RECORD, AND WHY EACH FIELD IS NEEDED
 *
 *   writes           Monotonic count of architectural writes. Increments on
 *                    every write, identical value or not. A UI frame that spans
 *                    many cycles (run mode) diffs this against the previous
 *                    frame's value to learn "this register was written 7 times
 *                    since you last looked", which no amount of value
 *                    inspection could tell it.
 *
 *   lastWriteCycle   The cycle the most recent write committed. Lets the UI
 *                    render a decay — full brightness at age 0, fading over the
 *                    next few cycles — so a highlight survives long enough to
 *                    be seen while single-stepping, and so several recently
 *                    touched registers can be ranked by recency.
 *
 *                    It also solves the repeated-write case: a register written
 *                    on consecutive cycles has its age reset to 0 each time,
 *                    so the highlight retriggers instead of sitting at a
 *                    constant brightness that reads as "static".
 *
 *   lastWriteValue   Only used by the tests, which assert that the value the
 *                    write strobe carried is the value that actually landed in
 *                    the register file the following cycle. That check is what
 *                    keeps the probe honest.
 *
 *   lastReadCycle    Same idea for the read ports, so the UI can outline the
 *                    registers this instruction is consuming.
 *
 * The rendering policy built on top of this — decay curve, blink parity,
 * per-frame coalescing — is deliberately *not* here. It lives in
 * js/src/blink.mjs as pure functions so it can be unit-tested and tuned
 * without a simulator, a browser, or a rebuild.
 */
#pragma once

#include "snapshot.h"

#include <cstdint>

namespace hz3 {

struct RegActivity {
	uint64_t writes = 0;
	int64_t  lastWriteCycle = NEVER;
	int64_t  lastReadCycle = NEVER;
	uint32_t lastWriteValue = 0;
};

class RegTracker {
public:
	static constexpr int N = 32;

	void reset() {
		for (int i = 0; i < N; ++i)
			act[i] = RegActivity{};
	}

	// An architectural write commits this cycle. Called once per cycle from the
	// step loop with the value the core's write port is carrying, so no write is
	// ever missed even when thousands of cycles run between UI frames.
	//
	// x0 is not tracked: Hazard3 gates its write enable on a nonzero rd, so a
	// write to x0 never reaches the register file and must not be shown as one.
	void noteWrite(unsigned rd, uint32_t value, uint64_t cycle) {
		if (rd == 0 || rd >= (unsigned)N)
			return;
		RegActivity &a = act[rd];
		++a.writes;                        // deliberately not conditional on
		a.lastWriteCycle = (int64_t)cycle; // value != a.lastWriteValue
		a.lastWriteValue = value;
	}

	void noteRead(unsigned rs, uint64_t cycle) {
		if (rs == 0 || rs >= (unsigned)N)
			return;
		act[rs].lastReadCycle = (int64_t)cycle;
	}

	const RegActivity &operator[](unsigned i) const { return act[i]; }

	// Merge the tracked activity with the values read out of the register file
	// itself, producing the register section of a snapshot.
	void fill(RegView (&out)[N], const uint32_t *values) const {
		for (int i = 0; i < N; ++i) {
			out[i].value          = values[i];
			out[i].writes         = act[i].writes;
			out[i].lastWriteCycle = act[i].lastWriteCycle;
			out[i].lastReadCycle  = act[i].lastReadCycle;
		}
	}

private:
	RegActivity act[N];
};

} // namespace hz3
