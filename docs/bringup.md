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
| Verilator | 5.020 | `apt install verilator` |
| RISC-V GCC | 13.2.0 (`riscv64-unknown-elf-`) | `apt install gcc-riscv64-unknown-elf` |
| Emscripten | 6.0.6 | emsdk (`/opt/emsdk`) |
| Node | 22.x | preinstalled |

Hazard3 itself is a **pinned submodule** (`third_party/hazard3`, commit
`8af99293`) and is never edited — all coupling to it lives in files we own.

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

```bash
# 1. one-time: toolchains
sudo apt install -y verilator gcc-riscv64-unknown-elf
git clone https://github.com/emscripten-core/emsdk /opt/emsdk
(cd /opt/emsdk && ./emsdk install latest && ./emsdk activate latest)

# 2. a test program  ->  programs/hello/build/hello.bin
./programs/build.sh hello

# 3a. native (fast correctness oracle) -> build/native/hz3_sim + hz3_test
./scripts/build-native.sh
./build/native/hz3_sim --bin programs/hello/build/hello.bin

# 3b. WASM for Node -> build/wasm/hz3_sim.{cjs,wasm}
./scripts/build-wasm.sh
node build/wasm/hz3_sim.cjs --bin programs/hello/build/hello.bin
```

## Workarounds (the reproducible versions)

These are baked into `scripts/build-wasm.sh` — **no installed headers are
patched**, so a clean checkout builds with no manual fix-ups.

1. **`VL_CPU_RELAX()` undefined for wasm32.** Verilator's `verilatedos.h`
   defines a CPU spin-relax hint per architecture and hard-`#error`s on unknown
   targets; wasm32 isn't listed. Fix: compile with **`-DVL_IGNORE_UNKNOWN_ARCH`**,
   a built-in escape hatch that defines it empty (a spin hint is a no-op in
   single-threaded WASM anyway).

2. **`VlThreadPool` undefined at link.** `verilated.cpp` references the thread
   pool even in a single-threaded model. Fix: add **`verilated_threads.cpp`** to
   the link. No `-pthread` — the model never spawns threads, so we keep the
   single-threaded runtime and avoid the SharedArrayBuffer / COOP-COEP burden a
   pthread build would impose on the eventual browser page.

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
