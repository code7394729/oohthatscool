/**
 * registers.ts — the register file panel.
 *
 * Where the update indication from src/core/blink.ts actually lands. Each cell
 * carries three independent pieces of state:
 *
 *   data-level   0..3, a quantised decay bucket driving opacity — a write stays
 *                visible for a few cycles instead of for one frame
 *   data-blink   the write parity, flipped on every write. The stylesheet
 *                attaches a different (identical) keyframe animation to 0 and
 *                to 1, so toggling it *restarts* the flash. Re-setting one
 *                animation would not: an animation already running does not
 *                restart when the same class is set again, which is exactly the
 *                bug that makes a register written every cycle look static.
 *   data-read    outlined while execute is consuming it
 *
 * None of that depends on the value having changed, which is the point.
 */

import type { RegBlink } from '../../core/blink.js';
import { ABI_NAMES, asSigned, hex32 } from '../../core/decode.js';
import type { Snapshot } from '../../core/snapshot.js';
import { h } from './dom.js';

export type NumberFormat = 'hex' | 'signed' | 'unsigned';

interface Cell {
	root: HTMLElement;
	value: HTMLElement;
	writes: HTMLElement;
}

export class RegisterPanel {
	readonly root: HTMLElement;
	private cells: Cell[] = [];
	private format: NumberFormat = 'hex';

	constructor() {
		const grid = h('div', { class: 'reg-grid' });

		for (let i = 0; i < 32; i++) {
			const value = h('span', { class: 'reg-value' }, '00000000');
			const writes = h('span', { class: 'reg-writes', title: 'architectural writes so far' }, '');
			const root = h('div',
				{ class: 'reg-cell', 'data-index': i, 'data-level': 0 },
				h('span', { class: 'reg-name' }, ABI_NAMES[i]!),
				value,
				writes,
			);
			this.cells.push({ root, value, writes });
			grid.appendChild(root);
		}

		this.root = h('section', { class: 'panel panel-registers' },
			h('header', { class: 'panel-head' },
				h('h2', {}, 'Registers'),
				h('div', { class: 'seg', role: 'group', 'aria-label': 'number format' },
					...(['hex', 'signed', 'unsigned'] as NumberFormat[]).map((f) =>
						h('button', {
							class: 'seg-btn', type: 'button', 'data-format': f,
							'aria-pressed': f === 'hex',
						}, f))),
			),
			grid,
		);

		this.root.addEventListener('click', (ev) => {
			const btn = (ev.target as Element).closest<HTMLElement>('[data-format]');
			if (!btn) return;
			this.format = btn.dataset['format'] as NumberFormat;
			for (const b of this.root.querySelectorAll<HTMLElement>('[data-format]'))
				b.setAttribute('aria-pressed', String(b === btn));
		});
	}

	private render(v: number): string {
		switch (this.format) {
		case 'signed': return String(asSigned(v));
		case 'unsigned': return String(v >>> 0);
		case 'hex':
		default: return hex32(v);
		}
	}

	update(snapshot: Snapshot, blinks: RegBlink[]): void {
		for (let i = 0; i < 32; i++) {
			const cell = this.cells[i]!;
			const reg = snapshot.regs[i]!;
			const b = blinks[i]!;

			const text = this.render(reg.value);
			if (cell.value.textContent !== text) cell.value.textContent = text;

			const w = reg.writes ? `×${reg.writes}` : '';
			if (cell.writes.textContent !== w) cell.writes.textContent = w;

			// Quantised so the attribute only changes a few times per write
			// rather than every frame, which keeps the CSS transition smooth.
			const level = b.level <= 0 ? 0 : b.level > 0.66 ? 3 : b.level > 0.33 ? 2 : 1;
			setAttr(cell.root, 'data-level', String(level));
			setAttr(cell.root, 'data-read', b.read ? 'true' : 'false');

			// The restart trick. Only the parity of the *write count* is used, so
			// it changes on every write and never otherwise.
			if (b.level > 0) setAttr(cell.root, 'data-blink', String(b.parity));
			else if (cell.root.hasAttribute('data-blink')) cell.root.removeAttribute('data-blink');
		}
	}
}

function setAttr(el: Element, name: string, value: string): void {
	if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}
