# Hazard3 Visualizer

An interactive teaching tool for undergraduate ECE: run the **real
[Hazard3](https://github.com/Wren6991/Hazard3) RISC-V core** — the 3-stage
in-order machine shipping in the RP2350 / Raspberry Pi Pico 2 — in the browser
via WebAssembly, and watch its live microarchitectural state animate onto an
interactive SVG datapath.

> **Status: state extraction working (M0–M2).** The real Hazard3 core runs
> under Node.js via Verilator → WASM, and its live microarchitectural state —
> pipeline occupancy, forwarding paths, stall causes, register writes — is
> extracted from the RTL and available as a typed snapshot in C++ and
> JavaScript, with test wrappers at both levels. No SVG yet.
>
> Design proposal: [`docs/design.md`](docs/design.md) · bring-up and toolchain
> workarounds: [`docs/bringup.md`](docs/bringup.md) · how state gets out and how
> register updates are indicated: [`docs/probe.md`](docs/probe.md).

## The idea

Hazard3 RTL → Verilator → C++ → Emscripten/WASM, driving a TypeScript + SVG
front end. Students single-step a real program and *see* forwarding paths light
up, load-use bubbles appear, and taken branches flush the front end — cycle for
cycle, because it's the actual core, not a toy model.

## Quick start

```bash
sudo apt install -y verilator gcc-riscv64-unknown-elf     # toolchains
git clone https://github.com/emscripten-core/emsdk /opt/emsdk
(cd /opt/emsdk && ./emsdk install latest && ./emsdk activate latest)
git submodule update --init third_party/hazard3           # pull Hazard3

./programs/build.sh hello        # build a test program
./scripts/build-native.sh        # native: hz3_sim + hz3_test
./scripts/build-wasm-lib.sh      # WASM module for Node and the browser
./scripts/build-wasm.sh          # WASM CLI, the differential oracle

node build/wasm/hz3_sim.cjs --bin programs/hello/build/hello.bin
# -> Hello, world from Hazard3 running in WebAssembly!

./scripts/test.sh                # every suite, plus the native/WASM differential
```

Look at the machine from a terminal, no browser involved:

```bash
node js/cli/hz3.mjs step     --bin programs/hello/build/hello.bin --instructions 12
node js/cli/hz3.mjs timeline --bin programs/hello/build/hello.bin   # reservation table
node js/cli/hz3.mjs blink    --bin programs/hello/build/hello.bin   # register writes
```

See [`docs/bringup.md`](docs/bringup.md) for the toolchain and the exact
Verilator→Emscripten workarounds, and [`docs/probe.md`](docs/probe.md) for how
internal state is extracted and how register updates are indicated.

## Read the design

Start with **[`docs/design.md`](docs/design.md)**. It covers the three-layer
architecture, the Hazard3 pipeline (`F / X / M`) and the signals we visualize,
how internal state is extracted from the Verilated model, the WASM bridge and
snapshot contract, the visualization, the build pipeline and its known
workarounds, and a phased milestone plan (M0–M5).

Six open decisions are listed at the end of the design for the maintainer to
confirm before implementation begins.
