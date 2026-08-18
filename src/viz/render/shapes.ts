/**
 * shapes.ts — what each kind of component looks like.
 *
 * One function, one dispatch on ComponentType. Everything is a pure function of
 * the component and its box, so a new shape is a new case here and nothing else
 * changes: the model does not know a mux is a trapezoid, and the layout only
 * knows how much room it takes.
 *
 * The shapes are the conventional ones from datapath figures — a mux is a
 * trapezoid narrowing toward its output, an ALU is the notched arrow — because
 * students meeting this after a textbook should recognise the parts on sight.
 */

import type { Component } from '../model/types.js';
import type { Box } from '../layout/types.js';
import type { SceneNode } from './scene.js';

const r2 = (v: number) => Math.round(v * 100) / 100;
const poly = (pts: Array<[number, number]>) =>
	pts.map(([x, y]) => `${r2(x)},${r2(y)}`).join(' ');

export function componentShape(c: Component, box: Box, shapeId: string): SceneNode[] {
	const common = { id: shapeId, class: 'part-shape' };

	switch (c.type) {
	case 'mux': {
		// Trapezoid: full height on the input side, tapered toward the output,
		// which is the standard way to show which end is which.
		const taper = Math.min(12, box.h * 0.18);
		return [{
			tag: 'polygon',
			attrs: {
				...common, class: 'part-shape shape-mux',
				points: poly([
					[box.x, box.y],
					[box.x + box.w, box.y + taper],
					[box.x + box.w, box.y + box.h - taper],
					[box.x, box.y + box.h],
				]),
			},
		}];
	}

	case 'alu': {
		// The notched arrow. The notch on the left is where the two operands
		// meet; the point on the right is the result.
		const notch = box.h * 0.18;
		const inset = box.h * 0.3;
		return [{
			tag: 'polygon',
			attrs: {
				...common, class: 'part-shape shape-alu',
				points: poly([
					[box.x, box.y],
					[box.x + box.w * 0.62, box.y + inset],
					[box.x + box.w, box.y + box.h / 2],
					[box.x + box.w * 0.62, box.y + box.h - inset],
					[box.x, box.y + box.h],
					[box.x, box.y + box.h / 2 + notch / 2],
					[box.x + box.w * 0.22, box.y + box.h / 2],
					[box.x, box.y + box.h / 2 - notch / 2],
				]),
			},
		}];
	}

	case 'register': {
		// A rectangle with the clock triangle at the bottom left — the mark that
		// says "this is the thing that holds state between cycles", which is
		// exactly what a pipeline register is for.
		const t = 7;
		return [
			{
				tag: 'rect',
				attrs: {
					...common, class: 'part-shape shape-register',
					x: box.x, y: box.y, width: box.w, height: box.h, rx: 3,
				},
			},
			{
				tag: 'polygon',
				attrs: {
					class: 'clock-mark',
					points: poly([
						[box.x, box.y + box.h - t * 1.6],
						[box.x + t, box.y + box.h - t * 0.8],
						[box.x, box.y + box.h],
					]),
				},
			},
		];
	}

	case 'regfile':
		return [
			{
				tag: 'rect',
				attrs: {
					...common, class: 'part-shape shape-regfile',
					x: box.x, y: box.y, width: box.w, height: box.h, rx: 4,
				},
			},
			// A hint of the rows inside, so it reads as storage rather than logic.
			...[0.55, 0.7, 0.85].map((f) => ({
				tag: 'line',
				attrs: {
					class: 'regfile-rule',
					x1: box.x + 10, y1: r2(box.y + box.h * f),
					x2: box.x + box.w - 10, y2: r2(box.y + box.h * f),
				},
			})),
		];

	case 'memory':
		return [{
			tag: 'rect',
			attrs: {
				...common, class: 'part-shape shape-memory',
				x: box.x, y: box.y, width: box.w, height: box.h, rx: 4,
			},
		}];

	case 'source':
		return [{
			tag: 'rect',
			attrs: {
				...common, class: 'part-shape shape-source',
				x: box.x, y: box.y, width: box.w, height: box.h, rx: box.h / 2,
			},
		}];

	case 'block':
	default:
		return [{
			tag: 'rect',
			attrs: {
				...common, class: 'part-shape shape-block',
				x: box.x, y: box.y, width: box.w, height: box.h, rx: 4,
			},
		}];
	}
}
