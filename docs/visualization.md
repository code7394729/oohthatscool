# The in-browser visualization

Milestone M3–M4: the datapath on screen, the panels around it, and the
TypeScript toolchain underneath.

The diagram is **not a hand-authored SVG file**. There is no `.svg` in this
repository. The picture is generated in the browser at load time from three
separate descriptions, and the separation between them is the main design
decision here.

---

## 1. Why not just draw it

A hand-drawn SVG for a datapath this size is a few thousand lines of paths and
transforms in which every fact appears twice: the ALU's position is in the
`<polygon>` and again in each wire that ends at it; a signal's identity is in an
`id` attribute and again in whatever code animates it. Moving a block means
editing a dozen unrelated coordinates, and the file gives you no way to ask
"is every component connected to something?" — a wire that quietly stopped being
wired looks exactly like one that is.

So the picture is described three times over, and each description answers a
different question:

| File | Question it answers | What it must not contain |
|---|---|---|
| `src/viz/model/datapath.ts` | What parts exist, what ports they have, what connects to what | coordinates, colours, simulator state |
| `src/viz/layout/datapath-layout.ts` | Where each part sits, which face a port leaves from, how wires route | what anything *means* |
| `src/viz/model/bindings.ts` | What a `Snapshot` means for each part | coordinates, DOM |

Each changes for its own reason and by its own kind of edit. Adding a forwarding
path is a model change. Nudging the ALU down forty pixels because a wire crossed
is a layout change. Deciding a stalled stage should look amber is a change to
`web/style.css` — not to any of the three.

The pipeline is:

```
model + layout ──(pure)──► Scene ──(DOM)──► <svg>            once, at load
snapshot ──(pure)──► DatapathDisplay ──(attrs)──► data-*     every frame
```

---

## 2. The model

A netlist, in the shape you would describe it out loud. Components have typed
ports; nets connect one output to one or more inputs:

```ts
mux('bypassA', {
  stage: 'X',
  label: 'fwd A',
  inputs: ['register file', 'from M', 'from W'],   // becomes in0, in1, in2, sel, out
  rtl: 'x_rs1_bypass',
  note: 'Picks the newest value of rs1: the register file, or a result still in flight …',
}),

net('fwd_m', 'xm.q_result', ['bypassA.in1', 'bypassB.in1'], {
  label: 'forward from M',
  rtl: 'xm_result',
}),
```

Every component and net carries the **RTL name it stands for**, so the model
doubles as the map between the picture and `third_party/hazard3/hdl`, and the
generated SVG puts it in a `<title>` — hover anything and it tells you what it is
and where it comes from, with no JavaScript involved.

### Validation, because string references rot

`validateDatapath()` checks what the compiler cannot: that every endpoint
resolves, that a net's source is an output and its destinations are inputs, that
ids are unique, and that **every input port has exactly one driver**.

That last rule is the useful one. It is what stops the model from quietly
fudging: an early draft had `decode.rd` driving three unrelated mux selects,
which "worked" and was a lie about the hardware. The single-driver rule made it
fail, and the fix was to model the control sources — the `decode` control outputs
and a `hazard` unit — that were really there.

`validateLayout()` does the same across the seam: a component added to the model
and forgotten in the layout would silently vanish from the diagram, and a layout
entry left behind after a rename would silently do nothing. Both are errors, both
run in the test suite, and both run again in the browser at startup so a mistake
appears in the console naming the culprit.

---

## 3. The layout

Pure geometry: boxes, port anchors, and wire waypoints.

Port anchors have defaults — inputs on the west face, outputs on the east,
selects and enables on the north and south — so the layout only names the
handful that route badly. Wires are orthogonal, and the router is deliberately
dumb: a short stub straight out of each port, then one dog-leg. Anything that
needs to go somewhere specific says so:

```ts
// The redirect goes over the top of everything, which is what makes the branch
// penalty legible: it is visibly a long way back.
branch_pc: { via: [{ x: 776, y: 30 }, { x: 126, y: 30 }] },
```

A waypoint is a corner — "go to this x, then this y" — and the axis order is
fixed by which face the wire left from. Predictable beats clever here: an
auto-router that re-evaluates its heuristics makes the picture change shape when
you touch something unrelated, which is exactly what you do not want in a
diagram people are learning to read.

---

## 4. Scene, then DOM

`buildScene(model, layout)` is a **pure function** returning a tree of
`{tag, attrs, text, children}` — no `document`, no elements. `mount()` walks it
once with `createElementNS` and keeps a `Map<id, Element>`.

This is not a virtual DOM and there is no diffing. After mount, a frame is a few
hundred attribute writes onto elements the renderer already has handles for.
Nothing is removed and re-added, so CSS transitions run uninterrupted, and the
cost is nothing next to a layout pass.

The split matters for testing more than for performance: because the scene is
pure, the test suite asserts that the generated diagram contains a shape and a
value slot for every component and a path for every branch of every net —
under `node`, with no browser. `sceneToSvg()` serialises the same scene to text,
which is also how the diagram can be rendered offline.

The id scheme is the contract between the scene builder, the DOM layer and the
stylesheet:

```
c/<id>  c/<id>/shape  c/<id>/value        components
n/<id>  n/<id>/b<k>   n/<id>/value        nets, one path per fan-out branch
```

The renderer writes only *semantic* state — `data-state="stalled"`,
`data-emphasis="highlight"`, `data-selected="1"` — and `web/style.css` decides
what any of it looks like. A high-contrast variant for a lecture-hall projector
is a stylesheet, not a code change.

---

## 5. Bindings, and what the diagram claims

`computeDisplay(snapshot)` is pure, and that is what makes the interesting
question a unit test rather than a screenshot:

```ts
test('bindings light the forwarding path when the core forwards', () => {
  s.x.bypassA = Bypass.M;
  const d = computeDisplay(s);
  assertEq(d.nets['fwd_m']!.emphasis, 'highlight');
  assertEq(d.nets['rf_rd1']!.active, false, 'the register file read is overridden');
  assertEq(d.components['bypassA']!.selected, 1);
});
```

and then again against the real core:

```ts
wasmTest('the diagram lights the forwarding path on a real dependent add', …);
wasmTest('the diagram shows a stall on a real load-use hazard', …);
```

A further test asserts that **every** component and net in the model has a
binding, so adding a part to the diagram cannot leave it permanently dark.

---

## 6. The blink, on screen

`src/core/blink.ts` (see [`probe.md`](probe.md) §3) computes *what* to flash.
The panel decides how, and one detail is worth naming because it is not obvious:

> A CSS animation does not restart when you re-apply the same animation to an
> element already running it.

So a register written on ten consecutive cycles would flash once and then glow
steadily — indistinguishable from a register nothing is happening to, which is
precisely the failure this whole mechanism exists to prevent. The fix is two
identical keyframe sets, `blink-a` and `blink-b`, with the renderer alternating
`data-blink` between `0` and `1` on every write:

```css
.reg-cell[data-blink="0"] { animation: blink-a 480ms ease-out; }
.reg-cell[data-blink="1"] { animation: blink-b 480ms ease-out; }
```

The value it alternates on is the parity of the **write count**, so it changes on
every write and never otherwise — including when the value written is identical
to the one already there. Underneath it, `data-level` carries the quantised decay
ramp, so the highlight fades over the following few cycles instead of vanishing
after one frame.

`prefers-reduced-motion` replaces both with a static outline.

---

## 7. Toolchain

TypeScript, and nothing else. No bundler, no framework.

```
tsconfig.core.json    src/core   no DOM, no node types — portability enforced by the compiler
tsconfig.web.json     src/viz    DOM, no node
tsconfig.node.json    src/cli, src/test, src/server
```

Three projects with references, built by `tsc -b`. The split is not decoration:
`src/core` compiles with neither `lib.dom` nor `@types/node`, so the layer that
has to run in the browser, in Node and in the test runner *cannot* reach for
`document` or `node:fs` — the compiler stops it, rather than a convention nobody
checks. The handful of genuinely universal globals it does use (`URL`,
`import.meta.url`) are declared explicitly in `src/core/env.d.ts`, which doubles
as a reviewable list of what that layer assumes from its host.

`tsc` emits native ES modules that the browser loads directly, which is why every
relative import is written with an explicit `.js` extension. There is no build
artifact between the source and what runs: debugging a module means reading it.

### Dev server

`src/server/dev.ts` — about 200 lines of `node:http`. It serves the repository
root (so `dist/viz/app.js` importing `../../build/wasm/hz3.mjs` means the same
thing to Node and to the browser), sets `application/wasm` correctly, restricts
itself to a handful of directories, and pushes a reload over Server-Sent Events
when `dist/` or `web/` changes.

```bash
npm install
npm run dev            # tsc -b --watch + the server on :8080
```

`--watch` spawns the compiler as a child process, so one command gives you both.

---

## 8. The page

- **Datapath** — the generated SVG, with live values on active wires.
- **Pipeline** — what is in F / X / M, and *every* stall cause currently
  asserted rather than just the top one, since two hazards coinciding is usually
  the explanation for a confusing cycle.
- **Registers** — 32 cells with ABI names, the blink, a lifetime write count,
  and hex/signed/unsigned.
- **Reservation table** — instructions × cycles, reconstructed by
  `src/core/timeline.ts`, which is shared with the CLI and cross-checks itself
  against the probe's own X│M shadow. If it ever disagrees, it says so on screen
  rather than drawing something plausible.
- **CSRs and program output.**

### Examples

The teaching programs are assembled **in the browser** by `src/core/rv32.ts`, so
the page needs no RISC-V toolchain and no fetch to run any of them, and the
explanation of what to watch for lives next to the code that produces it
(`src/viz/programs.ts`). The same programs are available to the CLI and the test
suite:

```bash
node dist/cli/hz3.js example                      # list them
node dist/cli/hz3.js step --example loaduse --cycles 16
```

One of them is worth calling out. **Load–use hazard** originally failed to stall
at all: the store ahead of the load hogged the single AHB port, the prefetch
buffer ran dry, and the consumer arrived after the load had already left the
memory stage — so no interlock was needed. That is true to the hardware and a
good lesson in its own right, but it is not what the example is for, so it now
has a few `nop`s to let fetch catch up. The test suite asserts the stall actually
happens, which is how the problem was found.

---

## 9. What is not done yet

- No memory panel; the bus fields are in the snapshot but only the current
  transaction is drawn.
- No breakpoints in the UI (the bridge supports them — `run(maxCycles, breakPC)`).
- No guided tours or the 5-stage overlay from the design (open decision Q3).
- Layout polish: a few wire value labels can collide in the mux column at busy
  cycles. That is a layout change and nothing else — which is the point.
