# Hazard3 Visualizer

An interactive teaching tool for undergraduate ECE: run the **real
[Hazard3](https://github.com/Wren6991/Hazard3) RISC-V core** — the 3-stage
in-order machine shipping in the RP2350 / Raspberry Pi Pico 2 — in the browser
via WebAssembly, and watch its live microarchitectural state animate onto an
interactive SVG datapath.

> **Status: design phase.** No implementation yet. The proposal is in
> [`docs/design.md`](docs/design.md) and is under review.

## The idea

Hazard3 RTL → Verilator → C++ → Emscripten/WASM, driving a TypeScript + SVG
front end. Students single-step a real program and *see* forwarding paths light
up, load-use bubbles appear, and taken branches flush the front end — cycle for
cycle, because it's the actual core, not a toy model.

## Read the design

Start with **[`docs/design.md`](docs/design.md)**. It covers the three-layer
architecture, the Hazard3 pipeline (`F / X / M`) and the signals we visualize,
how internal state is extracted from the Verilated model, the WASM bridge and
snapshot contract, the visualization, the build pipeline and its known
workarounds, and a phased milestone plan (M0–M5).

Six open decisions are listed at the end of the design for the maintainer to
confirm before implementation begins.
