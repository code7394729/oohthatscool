# Exposing the core's internal state

Milestone M1 of the design: get Hazard3's live microarchitectural state out of
the Verilated model, across the WASM boundary, and into shape for a UI — with
as much of it as possible testable from a terminal.

```
rtl/hz3_probe.vh ──► top-level ports ──► sim/snapshot.h ──► JSON ──┬─► src/viz/  (the page)
   hierarchical         Vhz3_top            plain struct           ├─► src/cli/hz3.ts
   references           members                                    └─► *.jsonl trace file
```

---

## 1. Getting the signals out

The design weighed four options (design.md §4) and picked **C, a probe wrapper**:
one file we own reaches into the core by hierarchical reference. Hazard3 stays a
pinned, unedited submodule, and every line of coupling to its internal names sits
in two files:

| File | Contents |
|---|---|
| `rtl/hz3_probe_ports.vh` | the port declarations, `` `include ``d into `hz3_top`'s port list |
| `rtl/hz3_probe.vh` | the bodies: `assign p_x_stall = cpu.core.x_stall;` and friends |

If upstream renames a signal, elaboration fails there, by name, at build time.
Nothing silently starts showing stale data.

### Ports, not `verilator public`

The one implementation choice worth calling out. Verilator's usual route to an
internal signal is `--public-flat-rw` or a `/*verilator public*/` pragma, which
makes it reachable through `rootp` under a name Verilator mangles from the
hierarchy (`hz3_top__DOT__cpu__DOT__core__DOT__x_stall`). Those names depend on
the module hierarchy and the optimizer, and `--public-flat-rw` additionally
suppresses optimizations across the whole model.

Making each probe signal a **top-level output port** avoids all of that. Ports
are part of the model's public interface, so Verilator gives them clean, stable
members on the generated class:

```cpp
top->p_x_stall          // not top->rootp->hz3_top__DOT__cpu__DOT__core__DOT__x_stall
top->p_regs[5]          // a 1024-bit port, one 32-bit word per register
```

Cost: about a hundred lines of port declarations. Benefit: the C++ side reads
like ordinary code, no flag suppresses optimization, and adding a signal is one
line in each of two files.

### What the probe adds that the core does not have

Three signals are the probe's own registers, because the state simply does not
exist in Hazard3:

- **`p_m_valid`** — whether M holds a real instruction. A bubble in Hazard3 is
  an X|M register with `rd = x0` and `memop = NONE`, which is indistinguishable
  from a real branch. Without this the datapath would label empty slots with
  whatever instruction happened to leave residue.
- **`p_m_pc` / `p_m_instr`** — Hazard3 keeps no PC in M; it reconstructs `mepc`
  arithmetically when a trap is taken. The visualizer needs to say *which*
  instruction is in writeback.

They are clocked on exactly the condition the core's own `xm_*` registers use
(`!m_stall`) and cleared by the same bubble condition, so they cannot drift.
`m_stage_shadow_tracks_the_instruction_leaving_x` in the test suite checks every
handoff of a run against what X actually issued, and `buildTimeline` in
`src/core/timeline.ts` re-derives the same thing independently and warns if the two disagree.

### Reading the register file

`p_regs` is read straight out of the core's storage array
(`cpu.core.regs.real_dualport_reset.mem`), flattened into one 1024-bit port so
`top->p_regs[i]` is register `i`. Mirroring the writes in C++ would have been
easier and would have been wrong: a mirror can be subtly out of step and the
panel would confidently show numbers the machine does not have.

---

## 2. The snapshot

`sim/snapshot.h` defines one plain struct describing the whole machine at a
point in time, plus a JSON serializer. It includes no Verilator headers, so it
builds standalone.

### The seam is JSON text

The snapshot crosses into JavaScript as a JSON string, not a marshalled object
graph. That is a deliberate trade of a small amount of parse time (~3 KB per
snapshot, and only when a frame is painted) for a large amount of testability:

- `hz3_sim --trace out.jsonl` writes **byte-identical** state to what the WASM
  bridge produces.
- So the reservation table, the blink policy and the datapath renderer can be
  developed and regression-tested against a recorded file, with no simulator and
  no browser attached.
- And a bug becomes a file you can attach to a report, not a sequence of clicks.

### Timing convention

Getting this wrong makes a visualizer that is off by one cycle in a way nobody
notices until a student asks a good question. `Soc::step()` ends with the clock
**low and combinational logic settled**, so a snapshot always describes one
whole, consistent cycle:

- `regs` hold everything committed by the *N* posedges so far.
- The stage fields describe the instructions occupying F / X / M *right now* —
  what the machine is about to do, not what it did.
- A register write committed at posedge *N* is reported with
  `lastWriteCycle == N`, which is the same cycle its new value first appears in
  `regs[rd].value`.

That last point is what keeps a highlight and the value it explains from ever
disagreeing.

### Raw encodings, named on the UI side

The snapshot ships the core's own encodings (`aluOp`, `memOp`, `bypassA`,
`stallCause`) rather than prose, and `src/core/decode.ts` turns them into words.
The single exception is `stallReason`, which C++ also names — the native trace
has to be legible on its own, and it gives the JS table something to be checked
against. `this side names stall causes exactly as the simulator does` asserts
they agree on every cycle of a real run, so the two tables cannot drift apart.

---

## 3. Register update indication ("blinking")

The part of this milestone with the most design in it, because the obvious
implementation is wrong.

### Why value diffing fails

The natural approach is for the UI to compare each register against the previous
frame and flash the ones that changed. That misses every write whose value
happens to match what was already there:

```asm
add  x5, x0, x0     # zeroing a register that already held zero
li   x6, 10         # reloading a loop bound, every pass
sub  x7, x7, x7     # the idiomatic zeroing idiom
```

Each is a real architectural write — the write port is active, the enable
asserts, energy is spent — and a student watching the register file should see
it. Value diffing shows nothing, quietly teaching that *no visible change* means
*no work done*.

This is not a corner case. `hz3 blink --bin programs/hello/build/hello.bin`
finds one in the "Hello, world" program itself: the two `l`s of "Hello" both
load `0x6c` into `a4`, and the second write is invisible to a value diff.

So the indication is driven by the **write strobe** — Hazard3's `m_reg_wen`,
surfaced as `p_m_reg_wen` — sampled every cycle, never by comparing values.

### Three problems, three fields

`sim/tracker.h` records the write events; `src/core/blink.ts` decides what they
look like. The split matters: rendering policy can be tuned and unit-tested
without a simulator, a rebuild or a browser.

| Problem | Field | How it works |
|---|---|---|
| **A write whose value did not change** | `writes` | A monotonic counter fed from the write strobe. It increments on every write, identical value or not, and it is the only thing that answers "did a write happen". |
| **A one-cycle event, drawn at 60 Hz** | `level`, from `lastWriteCycle` | A decay ramp in *core cycles*, not wall time: full at age 0, gone by `decayCycles` (default 6). The highlight survives long enough to read, and several recently touched registers rank by recency instead of all looking equally lit. |
| **Writes faster than the display** | `key`, `parity`, `writesDelta` | A register written on consecutive cycles never leaves the top of the ramp, so a fade alone renders as a constant glow — the one case where "written constantly" looks exactly like "nothing happening". `key` and `parity` change on *every* write, giving the renderer something to restart an animation from. And in run mode, where thousands of cycles pass between frames, `writesDelta` reports how many writes occurred since the viewer last looked, which no amount of age arithmetic could recover. |

`level` takes the **maximum** of the age ramp and the unseen-writes signal: a
write that happened 4000 cycles ago but has not been shown yet is news, and gets
full brightness.

### Frame-to-frame state

`BlinkTracker` holds exactly one thing — the write counts as of the last frame
the viewer saw. That is the minimum needed to answer "what changed since you
last looked", and it handles two edge cases explicitly:

- **First frame** after a load: nothing is reported as new, so the file does not
  light up all at once.
- **Cycle count goes backwards** (the machine was reset, or a trace was
  scrubbed): history is dropped rather than producing a spurious full-file flash.

Reads get the same treatment with a shorter tail (`readDecayCycles`, default 2),
since an instruction re-reads its operands every cycle it sits stalled in X.

---

## 4. Testing without a browser

Almost everything here is a pure function of plain data, and the parts that are
not are driven from two independently executable CLIs.

```
./scripts/test.sh            everything (add --build to build first)
./build/native/hz3_test      C++: probe, snapshot, tracker
node dist/test/run.js         JS: blink policy, decoders, renderers, WASM bridge
```

### `hz3_test` — the C++ wrapper

Self-contained: no fixtures, no RISC-V toolchain, no Node. It builds every
program it runs **in memory** with a small instruction encoder
(`sim/tests/rv32_asm.h`), so each three-instruction program engineered to force
one behaviour sits next to the assertion it justifies.

```
./build/native/hz3_test --list
./build/native/hz3_test --filter blink -v
```

It leans hard on cross-checking against the core's own accounting wherever
Hazard3 keeps a second copy of the same fact:

- `retire_count_matches_the_cores_own_minstret` — our instruction count against
  the CSR, every cycle. (Hazard3 resets `mcountinhibit` to *inhibited*, so the
  test program starts the counters first — a nice detail to show a class.)
- `write_strobe_agrees_with_the_register_file` — the value the write port
  carried against what actually landed in the storage array.
- `m_stage_shadow_tracks_the_instruction_leaving_x` — the probe's shadow
  registers against what X issued.

And it checks that every phenomenon the UI claims to show is actually
observable: forwarding from M, the load-use interlock, a 33-cycle sequential
multiply, a taken branch flushing the front end.

### `src/test/run.ts` — the JS wrapper

Two tiers. The **pure** tier needs nothing built — it exercises the blink
policy, decoders and renderers on literal objects, which is where most of the
interesting UI logic actually lives. The **wasm** tier loads the real module
under Node and drives the real core, and is skipped with a notice if
`build/wasm/hz3.mjs` is absent.

```
node dist/test/run.js --pure
node dist/test/run.js --filter blink
```

The end-to-end case worth naming: `same-value writes reach JavaScript as three
distinct writes` runs three identical `addi t0, zero, 7` instructions and
asserts that all three arrive as separate writes with the register's value never
changing after the first — the write strobe, the tracker, the JSON seam and the
blink policy, checked as one path.

### `dist/cli/hz3.js` — the same code the browser will run

Drives the WASM module through the same wrapper and the same renderers the UI
will use, from a terminal:

```bash
node dist/cli/hz3.js run      --bin prog.bin
node dist/cli/hz3.js step     --bin prog.bin --instructions 12
node dist/cli/hz3.js trace    --bin prog.bin --out trace.jsonl
node dist/cli/hz3.js timeline --bin prog.bin
node dist/cli/hz3.js blink    --bin prog.bin
```

`timeline` is the reservation table in ASCII, and reads a recorded trace just as
happily as a live run — so it works with no WASM at all:

```
$ ./build/native/hz3_sim --bin hello.bin --quiet --trace t.jsonl --trace-to 40
$ node dist/cli/hz3.js timeline --trace t.jsonl
0x80000020  bgeu t0, t1, 0x80000030  ..........XM............................
0x80000030  jal ra, 0x80000040       ............XM..........................
0x80000040  lui a5, 0x80000          ..............XM........................
0x80000044  addi a5, a5, 104         ...............XM.......................
0x80000048  lui a3, 0xc0000          ................XM......................
0x8000004c  lbu a4, 0(a5)            .................XM.....................
0x80000050  bnez a4, 0x8000005c      ..................xXM...................
```

The `x` on the last row is the load-use interlock: `bnez` needs `a4` before the
`lbu` above it has produced it. Fetch is deliberately not attributed to
instructions — the prefetch FIFO runs ahead of the pipeline, so there is no
honest per-instruction answer, and inventing one would teach a fiction.

---

## 5. What is not done yet

- Traps and interrupts are probed (`p_m_trap_*`) but no test exercises them —
  IRQs are still tied off in `rtl/hz3_top.v`.
- Memory is not yet surfaced as a panel; the bus fields are in the snapshot but
  only the current transaction is drawn.

The browser side built on top of this is described in
[`visualization.md`](visualization.md); `src/core/render-text.ts` remains the
same rendering logic with the pixels removed, and is what the CLI prints.
