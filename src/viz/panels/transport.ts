/**
 * transport.ts — the controls: program menu, step / run / reset, speed.
 *
 * Emits intents through callbacks and owns no simulator state, so the app can
 * decide what "run" means (and so this file stays testable-by-inspection).
 */

import { h } from './dom.js';

export type TransportAction =
	| { kind: 'stepCycle' }
	| { kind: 'stepInstruction' }
	| { kind: 'run' }
	| { kind: 'pause' }
	| { kind: 'reset' }
	| { kind: 'load'; id: string }
	| { kind: 'speed'; cyclesPerSecond: number };

export interface ProgramChoice {
	id: string;
	name: string;
	blurb: string;
}

/** Speeds worth offering: watchable, brisk, and "just get there". */
const SPEEDS: Array<{ label: string; cps: number }> = [
	{ label: '1 Hz', cps: 1 },
	{ label: '4 Hz', cps: 4 },
	{ label: '20 Hz', cps: 20 },
	{ label: 'fast', cps: 2000 },
];

export class TransportPanel {
	readonly root: HTMLElement;
	private readonly runBtn: HTMLButtonElement;
	private readonly select: HTMLSelectElement;
	private readonly blurb: HTMLElement;
	private running = false;

	constructor(
		programs: ProgramChoice[],
		private readonly emit: (a: TransportAction) => void,
	) {
		this.select = h('select', { class: 'program-select', 'aria-label': 'example program' },
			...programs.map((p) => h('option', { value: p.id }, p.name))) as HTMLSelectElement;
		this.blurb = h('p', { class: 'program-blurb' }, programs[0]?.blurb ?? '');

		this.select.addEventListener('change', () => {
			const chosen = programs.find((p) => p.id === this.select.value);
			this.blurb.textContent = chosen?.blurb ?? '';
			this.emit({ kind: 'load', id: this.select.value });
		});

		const button = (label: string, action: TransportAction, extra: Record<string, string> = {}) => {
			const b = h('button', { class: 'btn', type: 'button', ...extra }, label);
			b.addEventListener('click', () => this.emit(action));
			return b as HTMLButtonElement;
		};

		// Run is a toggle rather than a plain action; the app calls setRunning()
		// back to confirm, so the label always reflects what is really happening.
		this.runBtn = h('button', { class: 'btn btn-primary', type: 'button' }, 'Run') as HTMLButtonElement;
		this.runBtn.addEventListener('click', () =>
			this.emit(this.running ? { kind: 'pause' } : { kind: 'run' }));

		const speed = h('select', { class: 'speed-select', 'aria-label': 'run speed' },
			...SPEEDS.map((s) => h('option', { value: s.cps, selected: s.cps === 4 }, s.label))
		) as HTMLSelectElement;
		speed.value = '4';
		speed.addEventListener('change', () =>
			this.emit({ kind: 'speed', cyclesPerSecond: Number(speed.value) }));

		this.root = h('section', { class: 'panel panel-transport' },
			h('div', { class: 'transport-row' },
				this.select,
				button('Reset', { kind: 'reset' }),
			),
			this.blurb,
			h('div', { class: 'transport-row' },
				button('Step cycle', { kind: 'stepCycle' }, { title: 'advance one clock edge' }),
				button('Step instr', { kind: 'stepInstruction' }, { title: 'run until one more instruction retires' }),
				this.runBtn,
				speed,
			),
		);
	}

	setRunning(running: boolean): void {
		this.running = running;
		this.runBtn.textContent = running ? 'Pause' : 'Run';
		this.runBtn.setAttribute('data-running', String(running));
	}

	get selected(): string { return this.select.value; }

	select_(id: string): void {
		this.select.value = id;
	}
}
