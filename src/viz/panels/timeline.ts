/**
 * timeline.ts — the reservation table.
 *
 * Instructions down the page, cycles across it. The single clearest way to see
 * a stall push everything behind it: the bubble is a visible hole, and every
 * row below shifts right by exactly as much.
 *
 * The reconstruction itself is in core/timeline.ts and is shared with the CLI,
 * so what is drawn here is the same data the ASCII renderer prints — and is
 * checked by the same tests.
 */

import { disasm, hex32 } from '../../core/decode.js';
import type { Snapshot } from '../../core/snapshot.js';
import { buildTimeline, type Occupancy } from '../../core/timeline.js';
import { h } from './dom.js';

/** How many cycles of history to keep. Beyond this the oldest are dropped. */
const HISTORY = 220;
/** How many cycles are on screen at once. */
const WINDOW = 60;

const CELL_TITLE: Record<Occupancy, string> = {
	X: 'issued from execute',
	x: 'stalled in execute',
	M: 'memory / writeback',
	m: 'stalled in memory',
};

export class TimelinePanel {
	readonly root: HTMLElement;
	private readonly grid = h('div', { class: 'timeline-grid' });
	private history: Snapshot[] = [];

	constructor() {
		this.root = h('section', { class: 'panel panel-timeline' },
			h('header', { class: 'panel-head' },
				h('h2', {}, 'Reservation table'),
				h('span', { class: 'legend' },
					h('span', { class: 'legend-item', 'data-cell': 'X' }, 'X'), ' issue ',
					h('span', { class: 'legend-item', 'data-cell': 'x' }, 'x'), ' stalled ',
					h('span', { class: 'legend-item', 'data-cell': 'M' }, 'M'), ' writeback ',
				),
			),
			this.grid,
		);
	}

	push(s: Snapshot): void {
		this.history.push(s);
		if (this.history.length > HISTORY) this.history.splice(0, this.history.length - HISTORY);
	}

	clear(): void {
		this.history = [];
		this.grid.replaceChildren();
	}

	render(): void {
		const window = this.history.slice(-WINDOW);
		if (!window.length) { this.grid.replaceChildren(); return; }

		const { rows, cycles, warnings } = buildTimeline(window);
		const shown = rows.slice(-14);

		const table = h('table', { class: 'timeline-table' });
		const head = h('tr', {},
			h('th', { class: 'tl-label' }, 'instruction'),
			...cycles.map((c) => h('th', { class: 'tl-cycle' }, c % 10 === 0 ? String(c) : '')));
		table.appendChild(head);

		for (const r of shown) {
			const tr = h('tr', {},
				h('th', { class: 'tl-label', title: hex32(r.pc) },
					h('span', { class: 'tl-pc' }, hex32(r.pc).slice(-4)),
					h('span', { class: 'tl-instr' }, disasm(r.instr, r.pc))));
			for (const c of cycles) {
				const cell = r.cells.get(c);
				tr.appendChild(h('td', {
					class: 'tl-cell',
					'data-cell': cell ?? '',
					title: cell ? `cycle ${c}: ${CELL_TITLE[cell]}` : '',
				}, cell ?? ''));
			}
			table.appendChild(tr);
		}

		this.grid.replaceChildren(table);

		// The reconstruction cross-checks itself against the model's own X|M
		// shadow. If it ever complains, the diagram is out of step with the core
		// and saying so is far better than drawing something plausible.
		if (warnings.length) {
			this.grid.appendChild(h('div', { class: 'timeline-warning' },
				`timeline disagreed with the model: ${warnings[0]}`));
		}
	}
}
