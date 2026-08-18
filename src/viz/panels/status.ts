/**
 * status.ts — the readouts beside the diagram: what is in each stage, why the
 * pipeline is stalled, the CSRs, and the program's console output.
 *
 * All of it is a straight presentation of one Snapshot, so it agrees with the
 * datapath by construction rather than by coincidence.
 */

import { disasm, hex32, stallCauses } from '../../core/decode.js';
import type { Snapshot } from '../../core/snapshot.js';
import { h } from './dom.js';

export class StatusPanel {
	readonly root: HTMLElement;

	private readonly cycle = h('span', { class: 'stat-value' }, '0');
	private readonly retired = h('span', { class: 'stat-value' }, '0');
	private readonly stages = h('div', { class: 'stages' });
	private readonly why = h('div', { class: 'why' });
	private readonly csrs = h('dl', { class: 'csr-list' });
	private readonly output = h('pre', { class: 'console-output' }, '');

	private readonly stageRows = new Map<'F' | 'X' | 'M', {
		instr: HTMLElement; pc: HTMLElement; note: HTMLElement; row: HTMLElement;
	}>();
	private readonly csrValues = new Map<string, HTMLElement>();

	constructor() {
		for (const [id, name] of [['F', 'fetch'], ['X', 'decode + execute'], ['M', 'memory + writeback']] as const) {
			const pc = h('span', { class: 'stage-pc' }, '—');
			const instr = h('span', { class: 'stage-instr' }, '—');
			const note = h('span', { class: 'stage-note' }, '');
			const row = h('div', { class: 'stage-row', 'data-stage': id, 'data-state': 'idle' },
				h('span', { class: 'stage-id' }, id),
				h('span', { class: 'stage-name' }, name),
				pc, instr, note,
			);
			this.stageRows.set(id, { instr, pc, note, row });
			this.stages.appendChild(row);
		}

		for (const name of ['mcycle', 'minstret', 'mstatus', 'mtvec', 'mepc', 'mcause']) {
			const value = h('dd', { class: 'csr-value' }, '0x00000000');
			this.csrValues.set(name, value);
			this.csrs.appendChild(h('dt', { class: 'csr-name' }, name));
			this.csrs.appendChild(value);
		}

		this.root = h('div', { class: 'status-stack' },
			h('section', { class: 'panel panel-status' },
				h('header', { class: 'panel-head' },
					h('h2', {}, 'Pipeline'),
					h('div', { class: 'stats' },
						h('span', { class: 'stat' }, 'cycle ', this.cycle),
						h('span', { class: 'stat' }, 'retired ', this.retired)),
				),
				this.stages,
				this.why,
			),
			h('section', { class: 'panel panel-csr' },
				h('header', { class: 'panel-head' }, h('h2', {}, 'CSRs')),
				this.csrs,
			),
			h('section', { class: 'panel panel-console' },
				h('header', { class: 'panel-head' }, h('h2', {}, 'Program output')),
				this.output,
			),
		);
	}

	appendOutput(text: string): void {
		if (!text) return;
		this.output.textContent = (this.output.textContent ?? '') + text;
		this.output.scrollTop = this.output.scrollHeight;
	}

	clearOutput(): void {
		this.output.textContent = '';
	}

	update(s: Snapshot): void {
		this.cycle.textContent = String(s.cycle);
		this.retired.textContent = String(s.retired);

		const f = this.stageRows.get('F')!;
		f.pc.textContent = hex32(s.f.pc);
		f.instr.textContent = s.f.cirVld ? disasm(s.f.cir, s.f.pc) : '(buffer empty)';
		f.note.textContent = s.f.jumpReq ? `redirect → ${hex32(s.f.jumpTarget)}` : '';
		setState(f.row, s.f.cirVld ? 'active' : 'bubble');

		const x = this.stageRows.get('X')!;
		x.pc.textContent = s.x.valid ? hex32(s.x.pc) : '—';
		x.instr.textContent = s.x.valid ? disasm(s.x.instr, s.x.pc) : '(bubble)';
		x.note.textContent = s.x.stall ? s.x.stallReason : s.x.issue ? 'issues' : '';
		setState(x.row, !s.x.valid ? 'bubble' : s.x.stall ? 'stalled' : 'active');

		const m = this.stageRows.get('M')!;
		m.pc.textContent = s.m.valid ? hex32(s.m.pc) : '—';
		m.instr.textContent = s.m.valid ? disasm(s.m.instr, s.m.pc) : '(bubble)';
		m.note.textContent = s.m.regWen ? `writes ${hex32(s.m.result)}` : s.m.stall ? 'stalled' : '';
		setState(m.row, !s.m.valid ? 'bubble' : s.m.stall ? 'stalled' : 'active');

		// Every reason at once, not just the top one: seeing that two hazards
		// coincide is usually the explanation for a confusing cycle.
		const causes = stallCauses(s.x.stallCause);
		this.why.replaceChildren(...(causes.length
			? causes.map((c) => h('div', { class: 'why-item', title: c.blurb },
				h('strong', {}, c.label), ' ', c.blurb))
			: [h('div', { class: 'why-item why-none' }, 'No stall: an instruction issues this cycle.')]));

		this.csrValues.get('mcycle')!.textContent = String(s.csr.mcycle);
		this.csrValues.get('minstret')!.textContent = String(s.csr.minstret);
		for (const name of ['mstatus', 'mtvec', 'mepc', 'mcause'] as const)
			this.csrValues.get(name)!.textContent = hex32(s.csr[name]);
	}
}

function setState(el: Element, state: string): void {
	if (el.getAttribute('data-state') !== state) el.setAttribute('data-state', state);
}
