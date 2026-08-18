/**
 * app.ts — the page.
 *
 * Wires the pieces together and owns the run loop. Everything it composes is
 * built and tested elsewhere:
 *
 *   core/sim         drives the real Hazard3, compiled to WASM
 *   model/datapath   what the diagram consists of
 *   layout/          where it goes
 *   render/scene     those two, turned into SVG primitives (pure)
 *   render/dom       primitives → elements, and per-frame attribute writes
 *   model/bindings   Snapshot → what each part is doing (pure)
 *   core/blink       Snapshot → what to flash (pure)
 *   panels/          registers, pipeline status, reservation table, transport
 *
 * The only thing that has to happen here is deciding *when* to paint.
 */

import { BlinkTracker } from '../core/blink.js';
import { createSim, type Hz3Sim } from '../core/sim.js';
import type { Snapshot } from '../core/snapshot.js';
import { computeDisplay } from './model/bindings.js';
import { datapath } from './model/datapath.js';
import { validateDatapath } from './model/types.js';
import { datapathLayout } from './layout/datapath-layout.js';
import { validateLayout } from './layout/types.js';
import { applyDisplay, mount, type SceneHandles } from './render/dom.js';
import { buildScene } from './render/scene.js';
import { h, must } from './panels/dom.js';
import { RegisterPanel } from './panels/registers.js';
import { StatusPanel } from './panels/status.js';
import { TimelinePanel } from './panels/timeline.js';
import { TransportPanel, type TransportAction } from './panels/transport.js';
import { examples, fetchedPrograms, findExample } from './programs.js';

/** Cycle budget for a single run tick at high speed. */
const MAX_CYCLES_PER_TICK = 20000;

class App {
	private sim: Hz3Sim | null = null;
	private handles: SceneHandles | null = null;
	private readonly blink = new BlinkTracker();

	private readonly registers = new RegisterPanel();
	private readonly status = new StatusPanel();
	private readonly timeline = new TimelinePanel();
	private transport!: TransportPanel;

	private running = false;
	private cyclesPerSecond = 4;
	private lastTick = 0;
	private rafId = 0;
	private currentId = examples[0]!.id;

	private readonly watchNote = h('p', { class: 'watch-note' }, '');

	async start(): Promise<void> {
		this.buildDiagram();
		this.buildChrome();

		try {
			this.sim = await createSim();
		} catch (err) {
			this.fail('Could not load the simulator.',
				'Build it with ./scripts/build-wasm-lib.sh, then reload.',
				err);
			return;
		}

		await this.load(this.currentId);
		this.installKeyboard();
	}

	// ---- construction ------------------------------------------------------

	private buildDiagram(): void {
		// The model and the layout are hand-written and reference each other by
		// string id, so check them before drawing. In development a mistake here
		// should be a console error naming the culprit, not a wire that silently
		// stopped moving.
		const modelProblems = validateDatapath(datapath);
		const layoutProblems = validateLayout(datapath, datapathLayout);
		for (const e of [...modelProblems.errors, ...layoutProblems.errors])
			console.error('[datapath]', e);
		for (const w of [...modelProblems.warnings, ...layoutProblems.warnings])
			console.warn('[datapath]', w);

		const scene = buildScene(datapath, datapathLayout);
		const host = must('#datapath');
		this.handles = mount(scene, host).handles;

		const missing = this.handles.missing(scene.ids);
		if (missing.length) console.error('[datapath] ids not mounted:', missing);
	}

	private buildChrome(): void {
		const choices = [
			...examples.map((e) => ({ id: e.id, name: e.name, blurb: e.blurb })),
			...fetchedPrograms.map((p) => ({ id: p.id, name: p.name, blurb: p.blurb })),
		];
		this.transport = new TransportPanel(choices, (a) => void this.onAction(a));

		must('#controls').replaceChildren(this.transport.root, this.watchNote);
		must('#side').replaceChildren(this.status.root, this.registers.root);
		must('#below').replaceChildren(this.timeline.root);
	}

	private installKeyboard(): void {
		document.addEventListener('keydown', (ev) => {
			if (ev.target instanceof HTMLSelectElement) return;
			switch (ev.key) {
			case ' ': ev.preventDefault(); void this.onAction({ kind: this.running ? 'pause' : 'run' }); break;
			case 'ArrowRight': ev.preventDefault(); void this.onAction({ kind: 'stepCycle' }); break;
			case 'Enter': ev.preventDefault(); void this.onAction({ kind: 'stepInstruction' }); break;
			case 'r': void this.onAction({ kind: 'reset' }); break;
			default: break;
			}
		});
	}

	// ---- programs ----------------------------------------------------------

	private async load(id: string): Promise<void> {
		const sim = this.sim;
		if (!sim) return;

		this.setRunning(false);
		this.currentId = id;

		const example = findExample(id);
		const fetched = fetchedPrograms.find((p) => p.id === id);

		let bytes: Uint8Array;
		if (example) {
			bytes = example.build().bytes;
			this.watchNote.textContent = example.watch;
			this.cyclesPerSecond = this.cyclesPerSecond;
		} else if (fetched) {
			try {
				const res = await fetch(fetched.url);
				if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
				bytes = new Uint8Array(await res.arrayBuffer());
				this.watchNote.textContent = fetched.watch;
			} catch (err) {
				this.watchNote.textContent =
					`Could not load ${fetched.url} — build it with ./programs/build.sh hello. (${String(err)})`;
				return;
			}
		} else {
			return;
		}

		// A fresh image needs the memory cleared of the previous one, which reset
		// alone does not do — it deliberately preserves memory.
		sim.reset();
		sim.loadProgram(bytes);
		sim.reset();

		this.blink.reset();
		this.timeline.clear();
		this.status.clearOutput();
		this.paint(sim.snapshot(), { record: false });
	}

	// ---- transport ---------------------------------------------------------

	private async onAction(a: TransportAction): Promise<void> {
		const sim = this.sim;
		if (!sim) return;

		switch (a.kind) {
		case 'load':
			await this.load(a.id);
			break;
		case 'reset':
			await this.load(this.currentId);
			break;
		case 'stepCycle':
			this.setRunning(false);
			sim.stepCycle();
			this.paint(sim.snapshot());
			break;
		case 'stepInstruction':
			this.setRunning(false);
			this.stepInstructionRecording(sim);
			break;
		case 'run':
			this.setRunning(true);
			break;
		case 'pause':
			this.setRunning(false);
			break;
		case 'speed':
			this.cyclesPerSecond = a.cyclesPerSecond;
			break;
		}
	}

	/**
	 * Step one instruction, but record every cycle it took, so the reservation
	 * table still shows the stall cycles rather than jumping over them.
	 */
	private stepInstructionRecording(sim: Hz3Sim): void {
		const before = sim.retired;
		for (let i = 0; i < 512; i++) {
			sim.stepCycle();
			const s = sim.snapshot();
			this.timeline.push(s);
			if (sim.retired !== before || sim.exited) { this.paint(s); return; }
		}
		this.paint(sim.snapshot());
	}

	private setRunning(running: boolean): void {
		if (this.running === running) return;
		this.running = running;
		this.transport.setRunning(running);

		if (running) {
			this.lastTick = performance.now();
			this.rafId = requestAnimationFrame((t) => this.tick(t));
		} else if (this.rafId) {
			cancelAnimationFrame(this.rafId);
			this.rafId = 0;
		}
	}

	/**
	 * The run loop. Cycles are budgeted against wall time so the chosen speed
	 * means what it says, and the display is painted once per frame no matter
	 * how many cycles went by — which is exactly the case the blink tracker's
	 * write-count delta exists to handle.
	 */
	private tick(now: number): void {
		const sim = this.sim;
		if (!sim || !this.running) return;

		const elapsed = Math.min(0.25, (now - this.lastTick) / 1000);
		this.lastTick = now;

		let budget = Math.max(1, Math.min(MAX_CYCLES_PER_TICK, Math.round(elapsed * this.cyclesPerSecond)));
		// At watchable speeds every cycle is recorded for the reservation table;
		// at full speed that would be pointless and slow, so only the tail is.
		const record = this.cyclesPerSecond <= 60;

		while (budget-- > 0 && !sim.exited) {
			sim.stepCycle();
			if (record) this.timeline.push(sim.snapshot());
		}

		const snap = sim.snapshot();
		if (!record) this.timeline.push(snap);
		this.paint(snap, { record: false });

		if (sim.exited) {
			this.setRunning(false);
			this.status.appendOutput(`\n[exited with code ${sim.exitCode} after ${sim.cycles} cycles]\n`);
			return;
		}
		this.rafId = requestAnimationFrame((t) => this.tick(t));
	}

	// ---- painting ----------------------------------------------------------

	private paint(snapshot: Snapshot, opts: { record?: boolean } = {}): void {
		if (opts.record !== false) this.timeline.push(snapshot);

		if (this.handles) applyDisplay(this.handles, computeDisplay(snapshot));
		this.registers.update(snapshot, this.blink.update(snapshot));
		this.status.update(snapshot);
		this.timeline.render();

		const out = this.sim?.drainOutput();
		if (out) this.status.appendOutput(out);

		const fault = this.sim?.fault();
		if (fault) {
			this.setRunning(false);
			this.status.appendOutput(`\n[model ${fault.kind}: ${fault.message}]\n`);
		}
	}

	private fail(title: string, hint: string, err: unknown): void {
		console.error(err);
		must('#datapath').replaceChildren(h('div', { class: 'fatal' },
			h('h2', {}, title),
			h('p', {}, hint),
			h('pre', {}, String(err))));
	}
}

new App().start().catch((err: unknown) => {
	console.error(err);
});
