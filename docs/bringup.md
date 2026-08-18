# Bring-up: Hazard3 under Node via Verilator → WASM

This is the first implementation milestone (design M0 + M2): the **real Hazard3
core runs in the browser's engine**. A tiny program is loaded, executed by the
Verilated RTL compiled to WebAssembly, and its output printed under Node — with
output **bit-identical to a native g++ build** (same message, same exit code,
same cycle count), which is the correctness check for the WASM port.

```
$ node build/wasm/hz3_sim.cjs --bin programs/hello/build/hello.bin
Hello, world from Hazard3 running in WebAssembly!

[sim] CPU requested exit, code=123, after 476 cycles
```

## Toolchain

Everything installs from stock Ubuntu 24.04 apt + emsdk; no hand-built tools.

| Tool | Version | Source |
|---|---|---|
| Verilator | 5.020, and 5.050 built from source | `apt install verilator` |
| RISC-V GCC | 13.2.0 (`riscv64-unknown-elf-`) | `apt install gcc-riscv64-unknown-elf` |
| Emscripten | 6.0.7 | emsdk (`/opt/emsdk` by default — see below) |
| g++ | 13 | `build-essential` |
| Node | 22.x | preinstalled |
| TypeScript | 5.9 | `npm install` |

The versions above are the ones this was last built and tested against, end to
end, on Ubuntu 24.04. Verilator is the one where the version genuinely matters:
see **Verilator versions** below. Nothing is pinned tighter than "recent enough": the
Emscripten row read 6.0.6 when this was first written and 6.0.7 builds
identically, so track `emsdk install latest` rather than chasing an exact
number.

Hazard3 itself is a **pinned submodule** (`third_party/hazard3`, commit
`8af99293`) and is never edited — all coupling to it lives in files we own.

### Pointing the build at your emsdk

The two WASM scripts do not hard-code a path. `scripts/toolchain.sh` resolves
`em++` and takes the **first** of these that exists:

| | How | When you'd use it |
|---|---|---|
| 1 | `EMXX=/path/to/em++` | You have one `em++` and know exactly where it is |
| 2 | `EMSDK=/path/to/emsdk` | An emsdk checkout somewhere other than `/opt/emsdk` |
| 3 | `em++` on `PATH` | You ran `source /path/to/emsdk/emsdk_env.sh` |
| 4 | `/opt/emsdk` | The default, and what the install steps below produce |

So an emsdk in your home directory needs no edits to any script:

```bash
EMSDK=~/emsdk ./scripts/build-wasm.sh
EMSDK=~/emsdk ./scripts/build-wasm-lib.sh

# or, for a whole shell:
export EMSDK=~/emsdk
./scripts/test.sh --build
```

`emsdk_env.sh` exports `EMSDK` itself and puts `em++` on `PATH`, so sourcing it
satisfies rules 2 and 3 at once and nothing further is needed.

If none of the four match, the build stops **before** verilating and prints
every path it tried plus how to override — rather than failing several minutes
later inside a compile. Verilator is resolved the same way, from `PATH`, with
its include directory taken from `verilator --getenv VERILATOR_ROOT` rather
than guessed, so a hand-built Verilator works unchanged.

### Verilator versions

Ubuntu 24.04's `apt` ships **5.020**, which is what the quick start installs
and what CI uses. The build also works on **5.050**, the latest release at the
time of writing, and both produce a simulation that agrees cycle for cycle —
the same 476 cycles for `hello`, and the native/WASM differential passes on
each.

Getting there needed one real fix. Everything between those versions that
touches this build is written up under
[Workarounds](#workarounds-the-reproducible-versions); the short version is
that the newer runtime calls Linux CPU-affinity functions which Emscripten
declares but does not implement, so the WASM link fails on three undefined
symbols while the native build is unaffected. That is handled in
`sim/vl_hooks.cpp`, and the list of Verilator runtime sources to link is now
read out of Verilator's own generated makefile instead of being hard-coded, so
a version that needs different ones does not need a script edit.

Nothing here pins a Verilator version: `resolve_vroot` takes whatever is on
`PATH` and asks it for its own include directory. To build against a
source-built Verilator, put it first on `PATH`:

```bash
PATH=/opt/verilator-5.050/bin:$PATH ./scripts/build-wasm.sh
```

## What was built (clean-slate, not the upstream testbench)

Hazard3 ships a Verilator testbench, but it pulls in a JTAG debug server over
BSD sockets and a multicore harness — machinery this tool doesn't need and that
fights Emscripten. So Layer A is our own:

| File | Role |
|---|---|
| `rtl/config_viz.vh` | Trimmed core config: RV32IM, M-mode CSRs + traps + counters, full bypass, sequential mul/div, no C/A/Zb*/PMP/debug. |
| `rtl/hz3_top.v` | Single-AHB-port top wrapping `hazard3_cpu_1port`; power/fence handshakes, debug + IRQs tied off. |
| `sim/soc.h` | The SoC: Verilated core + flat 16 MiB RAM + MMIO (putchar / exit), services the AHB5 port. Backs both the native and WASM builds. |
| `sim/main.cpp` | Native/Node CLI harness: load a flat binary, run, forward UART output. |
| `programs/` | Freestanding test programs (`-nostdlib`), shared `crt0.S` + `link.ld`. |

## Build & run

The exact sequence, from `git clone` to a green `./scripts/test.sh`. Each step
is independent of the ones after it, so a failure localises.

```bash
# 0. the RTL. This is a submodule and the clone does NOT bring it:
git submodule update --init third_party/hazard3

# 1. one-time: toolchains
sudo apt install -y verilator gcc-riscv64-unknown-elf
git clone --depth 1 https://github.com/emscripten-core/emsdk /opt/emsdk
(cd /opt/emsdk && ./emsdk install latest && ./emsdk activate latest)
#   installing elsewhere is fine — see "Pointing the build at your emsdk" above,
#   then prefix the WASM steps below with EMSDK=/your/path

# 2. a test program  ->  programs/hello/build/hello.bin
./programs/build.sh hello

# 3a. native (fast correctness oracle) -> build/native/hz3_sim + hz3_test
./scripts/build-native.sh
./build/native/hz3_sim --bin programs/hello/build/hello.bin
./build/native/hz3_test

# 3b. WASM CLI, the differential oracle -> build/wasm/hz3_sim.cjs
./scripts/build-wasm.sh
node build/wasm/hz3_sim.cjs --bin programs/hello/build/hello.bin

# 3c. WASM library for Node and the browser -> build/wasm/hz3.mjs + hz3.wasm
./scripts/build-wasm-lib.sh

# 4. the TypeScript, then everything at once
npm install
./scripts/test.sh
```

Expected at the end of step 4 — `test.sh` runs the four suites and reports
each; anything not built is skipped rather than failed, so a partial checkout
still gives useful output. Add `--strict` when everything is supposed to be
built and a skip should count as a failure (this is what CI runs):

```
17 passed, 0 failed      # native C++: probe, snapshot, write tracker
45 passed, 0 failed      # TypeScript: core, viz, CLI, and the WASM bridge
== native vs wasm differential ==
  identical output, exit code and cycle count
all suites passed
```

Rough costs on a clean machine: the emsdk install downloads ~330 MB and
occupies ~1.7 GB (it brings its own Node and LLVM); each `verilator --cc` +
`em++` pass takes a couple of minutes, and the two WASM scripts verilate
separately into `obj_dir` and `obj_dir_lib`, so a from-scratch
`test.sh --build` pays that twice. The native build is much faster and is the
right thing to iterate against.

### Issues hit on a clean checkout

Each of these cost time on a fresh Ubuntu 24.04 machine and none are
self-explanatory from the error:

- **The submodule is empty until you ask for it.** `third_party/hazard3` is a
  registered submodule with nothing in it after a plain `git clone`. Skipping
  step 0 fails inside *our* RTL rather than at the obviously-missing directory:

  ```
  %Error: rtl/hz3_top.v:66:10: Cannot find include file: hazard3_config_inst.vh
  ```

  which reads like a bug in `rtl/hz3_top.v` — the include is Hazard3's, and the
  fix is `git submodule update --init third_party/hazard3`.
- **`emsdk install latest` is not quick.** It fetches a ~300 MB LLVM/wasm
  binary tarball and a private Node before it prints anything useful. `git
  clone --depth 1` on emsdk itself saves a further several hundred MB of
  history that the SDK never uses.
- **emsdk installs its own Node (24.x) and it does not become yours.** The
  build calls `em++` by absolute path and the project's own scripts keep using
  whatever `node` is on `PATH` (22.x here). The two coexist; there is nothing
  to reconcile, and `emsdk activate` does not need `--permanent`.
- **Build the test program before running the test suite.** The native/WASM
  differential needs `programs/hello/build/hello.bin`, and without it `test.sh`
  reports `differential: skipped` — which is easy to read as a pass, because
  the run still ends in `all suites passed`.
- **A missing `em++` used to surface late.** The scripts took
  `/opt/emsdk/upstream/emscripten/em++` on faith, so a machine without it
  verilated for a minute or two and then died on "No such file or directory".
  `scripts/toolchain.sh` now checks first and says what to set.
- **`rm -rf dist` does not force a TypeScript rebuild.** The projects are
  `composite`, and their `.tsbuildinfo` files live at the repository root, not
  under `dist/`. Delete `dist/` alone and the next `tsc -b` reads a build log
  saying everything is current, emits nothing, and leaves you with no `dist/`
  and no error. Use `npm run clean` (`tsc -b --clean`) or `tsc -b --force`.

## What CI runs

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) does the above on
every push to `main` and every pull request, on `ubuntu-24.04` — the same
distribution the versions in this document were measured on. Two jobs:

| Job | Does | Roughly |
|---|---|---|
| `typescript` | `npm ci`, `tsc -b --force`, the pure test tier | under a minute |
| `simulator` | submodule, apt toolchains, Emscripten, all three builds, `./scripts/test.sh --strict`, then the CLI over the WASM library | a few minutes |

Two deliberate choices there:

- **Emscripten is installed outside `/opt` and reached through `EMSDK`.** The
  override documented above is therefore exercised by every CI run rather than
  being a claim nobody tests.
- **The Emscripten version is pinned** (`EMSDK_VERSION` at the top of the
  workflow) rather than tracking `latest`, so an upstream release cannot turn
  CI red on an unrelated pull request. Bumping that line is the upgrade, and
  the table at the top of this document is what it should agree with.

The heavy job runs `test.sh --strict` precisely because the friendly default
would let a build failure masquerade as a pass — see the `hello.bin` note
above.

## Workarounds (the reproducible versions)

These are baked into `scripts/build-wasm.sh` — **no installed headers are
patched**, so a clean checkout builds with no manual fix-ups.

1. **`VL_CPU_RELAX()` undefined for wasm32.** Verilator's `verilatedos.h`
   defines a CPU spin-relax hint per architecture and hard-`#error`s on unknown
   targets; wasm32 isn't listed. Fix: compile with **`-DVL_IGNORE_UNKNOWN_ARCH`**,
   a built-in escape hatch that defines it empty (a spin hint is a no-op in
   single-threaded WASM anyway).

2. **`VlThreadPool` undefined at link.** `verilated.cpp` references the thread
   pool even in a single-threaded model. Fix: link the runtime sources
   Verilator asks for. It writes that list into the makefile it generates, as
   `VM_GLOBAL_FAST` / `VM_GLOBAL_SLOW`, and `resolve_runtime_srcs` in
   `scripts/toolchain.sh` reads it back with `make` rather than hard-coding
   names — which files are needed depends on the Verilator version and on what
   the design uses. For this design both 5.020 and 5.050 answer
   `verilated verilated_threads`. No `-pthread` — the model never spawns
   threads, so we keep the single-threaded runtime and avoid the
   SharedArrayBuffer / COOP-COEP burden a pthread build would impose on the
   browser page.

3. **CPU-affinity symbols undefined at link (Verilator after 5.020).** The
   newer runtime asks the OS how many processors the process may use, and pins
   its worker threads. It guards that with

   ```c
   #if defined(__linux) || defined(CPU_ZERO)
   ```

   Emscripten does not define `__linux`, but its musl-derived `<sched.h>` *does*
   define `CPU_ZERO`, so the Linux arm is taken. Its `<pthread.h>` and
   `<sched.h>` then *declare* `sched_getcpu()` and
   `pthread_{get,set}affinity_np()` without the sysroot implementing any of
   them — so it compiles cleanly and fails only at link:

   ```
   wasm-ld: error: verilated.o: undefined symbol: pthread_getaffinity_np
   wasm-ld: error: verilated_threads.o: undefined symbol: sched_getcpu
   wasm-ld: error: verilated_threads.o: undefined symbol: pthread_setaffinity_np
   ```

   Fix: define the three in `sim/vl_hooks.cpp` under `#ifdef __EMSCRIPTEN__`,
   keeping it in a file we own rather than patching either toolchain.
   `sched_getcpu()` returns 0 — there is one execution context, and the id only
   labels profiling output. The two affinity calls return `ENOSYS`: WASM has no
   affinity mask, Verilator documents 0 ("cannot be determined") as the result
   of that failing, and its only caller is NUMA assignment for a worker pool
   this build never creates. Should a future Emscripten implement them, the
   link fails on a duplicate symbol rather than diverging quietly.

Emscripten link flags of note: `-sNODERAWFS=1` (real filesystem + argv under
Node, so the WASM build behaves like native), `-sALLOW_MEMORY_GROWTH=1` (the
16 MiB RAM plus the model), `-sEXIT_RUNTIME=1`, `-sENVIRONMENT=node`.

### Toolchain gotchas worth remembering

- Hazard3's `scripts/` is an uninitialised git submodule; its `listfiles`
  helper is what their Makefiles need. We sidestep it with an explicit RTL file
  list in the build scripts.
- Ubuntu's `gcc-riscv64-unknown-elf` ships **no libc** (`stdio.h` etc. are
  absent). Test programs are freestanding (`-nostdlib -nostartfiles
  -ffreestanding`) with our own `crt0.S` — which is what the visualizer's small
  teaching examples want anyway.
- The rv64 GCC needs **`-mabi=ilp32`** with `-march=rv32*` or it errors that the
  ABI requires the `D` extension.
- The standalone CLI is emitted as **`.cjs`**, not `.js`. Emscripten's program
  output is CommonJS, and the repo's `package.json` declares `"type": "module"`,
  under which Node reads a `.js` file as ESM and chokes on `require`. The
  importable library (`build-wasm-lib.sh`) has the opposite need and is `.mjs`.

## Next

Done since: the **probe wrapper + snapshot** and the **Embind bridge** — see
[`probe.md`](probe.md). What remains is the SVG datapath (M3) and the panels and
transport around it (M4); `src/core/render-text.ts` already computes the derived
state those need, with the pixels left off.
