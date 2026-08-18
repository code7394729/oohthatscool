# Hazard3 Visualizer

An interactive teaching tool for undergraduate ECE: run the **real
[Hazard3](https://github.com/Wren6991/Hazard3) RISC-V core** — the 3-stage
in-order machine shipping in the RP2350 / Raspberry Pi Pico 2 — in the browser
via WebAssembly, and watch its live microarchitectural state animate onto an
interactive SVG datapath.

> **Status: the visualizer runs in the browser (M0–M4).** The real Hazard3 core
> runs in WebAssembly, its live microarchitectural state is extracted from the
> RTL, and an interactive datapath animates it cycle by cycle — with a
> reservation table, a register panel and example programs assembled in the page.
>
> [`docs/design.md`](docs/design.md) the design ·
> [`docs/bringup.md`](docs/bringup.md) toolchain and Verilator→WASM workarounds ·
> [`docs/probe.md`](docs/probe.md) how state gets out of the RTL, and how
> register updates are indicated ·
> [`docs/visualization.md`](docs/visualization.md) how the diagram is generated,
> and the TypeScript toolchain.

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

Then the page:

```bash
npm install
npm run dev                      # tsc --watch + dev server on http://localhost:8080
```

Or look at the same machine from a terminal, no browser involved:

```bash
node dist/cli/hz3.js example                                         # the demo programs
node dist/cli/hz3.js step     --example loaduse --cycles 16          # pipeline, per cycle
node dist/cli/hz3.js timeline --bin programs/hello/build/hello.bin   # reservation table
node dist/cli/hz3.js blink    --bin programs/hello/build/hello.bin   # register writes
```

See [`docs/bringup.md`](docs/bringup.md) for the toolchain and the exact
Verilator→Emscripten workarounds, and [`docs/probe.md`](docs/probe.md) for how
internal state is extracted and how register updates are indicated.

## How it fits together

```
third_party/hazard3/  pinned, never edited
rtl/                  our top + the probe that pulls state out by hierarchical reference
sim/                  the SoC, the snapshot, the Embind bridge, the native tests
src/core/             portable TypeScript: snapshot types, blink policy, decode, timeline
src/viz/              the page — model / layout / bindings / render, kept separate
src/cli/ src/test/    the CLI and the test runner, over the same code the page uses
web/                  index.html + the stylesheet, which owns all appearance
```

The datapath is generated at load time from a component model and a separate
layout description — there is no `.svg` file in this repository. See
[`docs/visualization.md`](docs/visualization.md).

## Read the design

Start with **[`docs/design.md`](docs/design.md)**. It covers the three-layer
architecture, the Hazard3 pipeline (`F / X / M`) and the signals we visualize,
how internal state is extracted from the Verilated model, the WASM bridge and
snapshot contract, the visualization, the build pipeline and its known
workarounds, and a phased milestone plan (M0–M5).

Six open decisions are listed at the end of the design for the maintainer to
confirm before implementation begins.
