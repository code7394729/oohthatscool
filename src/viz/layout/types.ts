/**
 * types.ts — the vocabulary for placing a datapath on a canvas.
 *
 * The geometric half. Nothing here knows what a signal means or what the
 * simulator is doing; it knows where boxes go, which side of a box a port
 * leaves from, and how a wire should get from one to the other.
 *
 * A layout is written against component and port *ids* from the model, so the
 * compiler cannot check it — validateLayout() does, and the test suite runs it.
 */

import type { Component, Datapath, Port, StageId } from '../model/types.js';

export interface Point {
	x: number;
	y: number;
}

export interface Box {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** Which face of a component a port sits on. */
export type Side = 'n' | 's' | 'e' | 'w';

export interface PortAnchor {
	side: Side;
	/** Position along that side, 0 (top/left) to 1 (bottom/right). */
	at: number;
}

export interface ComponentLayout {
	box: Box;
	/** Overrides for the default anchor placement, by port id. */
	ports?: Record<string, PortAnchor>;
}

export interface BranchLayout {
	/** Waypoints for this branch alone, replacing the net's shared `via`. */
	via?: Point[];
}

export interface NetLayout {
	/**
	 * Corners the wire must pass through, in order, shared by every branch of a
	 * fan-out. Often one point is enough: each branch then closes with "along to
	 * my x, then across to my y", which is usually the wanted shape.
	 */
	via?: Point[];
	/** Per-destination routing, indexed by position in the net's `to` list. */
	branches?: Record<number, BranchLayout>;
	/**
	 * Which destination the label and value readout attach to, when a net fans
	 * out to several. Defaults to the first.
	 */
	labelBranch?: number;
	/** Nudge the label off the wire. */
	labelOffset?: Point;
}

/** A background band marking one pipeline stage. */
export interface StageBand {
	id: StageId;
	label: string;
	sublabel?: string;
	x: number;
	w: number;
}

export interface DatapathLayout {
	canvas: { width: number; height: number };
	bands: StageBand[];
	components: Record<string, ComponentLayout>;
	nets?: Record<string, NetLayout>;
}

// ---------------------------------------------------------------------------
// Default port placement
//
// Writing an anchor for every port of every component by hand would be tedious
// and would bury the handful that actually matter. So inputs default to the
// west face and outputs to the east, spread evenly, with control ports pushed
// to the north and south faces where datapath diagrams conventionally put them.
// The layout file then overrides only where the default routes badly.

const CONTROL_IN_SIDE: Side = 'n';
const CONTROL_OUT_SIDE: Side = 's';

/** Group ports by the face they will sit on, then spread them along it. */
export function defaultAnchors(component: Component): Record<string, PortAnchor> {
	const bySide: Record<Side, Port[]> = { n: [], s: [], e: [], w: [] };

	for (const p of component.ports) {
		const isSelect = p.role === 'select' || p.role === 'enable';
		if (isSelect) {
			bySide[p.dir === 'in' ? CONTROL_IN_SIDE : CONTROL_OUT_SIDE].push(p);
		} else {
			bySide[p.dir === 'in' ? 'w' : 'e'].push(p);
		}
	}

	const anchors: Record<string, PortAnchor> = {};
	for (const side of ['n', 's', 'e', 'w'] as Side[]) {
		const ports = bySide[side];
		ports.forEach((p, i) => {
			anchors[p.id] = { side, at: (i + 1) / (ports.length + 1) };
		});
	}
	return anchors;
}

/** Where a port sits in canvas coordinates. */
export function anchorPoint(box: Box, anchor: PortAnchor): Point {
	switch (anchor.side) {
	case 'n': return { x: box.x + box.w * anchor.at, y: box.y };
	case 's': return { x: box.x + box.w * anchor.at, y: box.y + box.h };
	case 'w': return { x: box.x, y: box.y + box.h * anchor.at };
	case 'e': return { x: box.x + box.w, y: box.y + box.h * anchor.at };
	}
}

/** Unit vector pointing away from the component, for wire stubs. */
export function outwardNormal(side: Side): Point {
	switch (side) {
	case 'n': return { x: 0, y: -1 };
	case 's': return { x: 0, y: 1 };
	case 'w': return { x: -1, y: 0 };
	case 'e': return { x: 1, y: 0 };
	}
}

// ---------------------------------------------------------------------------
// Resolution and validation

export interface ResolvedLayout {
	canvas: { width: number; height: number };
	bands: StageBand[];
	boxes: Map<string, Box>;
	/** "component.port" -> where it is and which way it faces. */
	anchors: Map<string, { point: Point; side: Side }>;
	nets: Map<string, NetLayout>;
}

/**
 * Combine the model and the layout into the flat lookup the scene builder
 * wants, filling in default anchors for every port the layout did not place.
 */
export function resolveLayout(dp: Datapath, layout: DatapathLayout): ResolvedLayout {
	const boxes = new Map<string, Box>();
	const anchors = new Map<string, { point: Point; side: Side }>();

	for (const c of dp.components) {
		const cl = layout.components[c.id];
		if (!cl) continue;
		boxes.set(c.id, cl.box);

		const defaults = defaultAnchors(c);
		for (const p of c.ports) {
			const a = cl.ports?.[p.id] ?? defaults[p.id];
			if (!a) continue;
			anchors.set(`${c.id}.${p.id}`, { point: anchorPoint(cl.box, a), side: a.side });
		}
	}

	return {
		canvas: layout.canvas,
		bands: layout.bands,
		boxes,
		anchors,
		nets: new Map(Object.entries(layout.nets ?? {})),
	};
}

export interface LayoutProblems {
	errors: string[];
	warnings: string[];
}

/**
 * Check a layout against the model it is meant to lay out. Catches the two
 * things that actually happen: a component added to the model and forgotten in
 * the layout (it silently vanishes from the diagram), and a layout entry left
 * behind after a component was renamed (it silently does nothing).
 */
export function validateLayout(dp: Datapath, layout: DatapathLayout): LayoutProblems {
	const errors: string[] = [];
	const warnings: string[] = [];

	const ids = new Set(dp.components.map((c) => c.id));
	for (const c of dp.components) {
		if (!layout.components[c.id]) errors.push(`component '${c.id}' has no layout`);
	}
	for (const id of Object.keys(layout.components)) {
		if (!ids.has(id)) errors.push(`layout has an entry for unknown component '${id}'`);
	}

	for (const [id, cl] of Object.entries(layout.components)) {
		const c = dp.components.find((k) => k.id === id);
		if (!c) continue;
		const portIds = new Set(c.ports.map((p) => p.id));
		for (const p of Object.keys(cl.ports ?? {})) {
			if (!portIds.has(p)) errors.push(`layout: ${id} has no port '${p}'`);
		}
		const { box } = cl;
		if (box.w <= 0 || box.h <= 0) errors.push(`layout: ${id} has a degenerate box`);
		if (box.x < 0 || box.y < 0 ||
			box.x + box.w > layout.canvas.width || box.y + box.h > layout.canvas.height)
			warnings.push(`layout: ${id} extends outside the canvas`);
	}

	const netIds = new Set(dp.nets.map((n) => n.id));
	for (const id of Object.keys(layout.nets ?? {})) {
		if (!netIds.has(id)) errors.push(`layout has routing for unknown net '${id}'`);
	}

	// Overlapping boxes are not wrong, but they are almost always a mistake.
	const entries = Object.entries(layout.components);
	for (let i = 0; i < entries.length; i++) {
		for (let j = i + 1; j < entries.length; j++) {
			const a = entries[i]!, b = entries[j]!;
			if (overlaps(a[1].box, b[1].box)) warnings.push(`layout: '${a[0]}' overlaps '${b[0]}'`);
		}
	}

	return { errors, warnings };
}

function overlaps(a: Box, b: Box): boolean {
	return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
