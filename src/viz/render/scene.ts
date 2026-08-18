/**
 * scene.ts — (model + layout) → a tree of SVG primitives.
 *
 * Pure: it produces plain objects describing elements, and creates nothing.
 * ./dom.ts turns the result into real nodes. Keeping the two apart means the
 * whole of the diagram's construction — every shape, every wire, every id —
 * can be built and asserted under `node` with no browser, which is how the
 * test suite checks that the picture actually contains what the model says.
 *
 * This is not a virtual DOM and there is no diffing. The scene is built once at
 * load; afterwards the UI writes attributes onto elements it looked up by id
 * (see ./dom.ts). For a few hundred nodes that is both simpler and steadier
 * than re-rendering.
 *
 * ID SCHEME — the contract between this file, dom.ts and the stylesheet:
 *
 *   c/<id>            group for a component
 *   c/<id>/shape      its outline, which carries data-state
 *   c/<id>/value      a text slot for a live value
 *   n/<id>            group for a net
 *   n/<id>/b<k>       one branch's path
 *   n/<id>/value      a text slot for the value on the wire
 */

import type { Component, Datapath, Net } from '../model/types.js';
import { midpoint, polylinePath, route } from '../layout/route.js';
import type { DatapathLayout, Point } from '../layout/types.js';
import { resolveLayout } from '../layout/types.js';
import { componentShape } from './shapes.js';

export interface SceneNode {
	tag: string;
	attrs?: Record<string, string | number>;
	/** Text content, for <text> and <title>. */
	text?: string;
	children?: SceneNode[];
}

export interface Scene {
	width: number;
	height: number;
	nodes: SceneNode[];
	/** Every id the scene defines, for dom.ts to index and tests to assert on. */
	ids: string[];
}

export const CID = (id: string, part?: string) => `c/${id}${part ? `/${part}` : ''}`;
export const NID = (id: string, part?: string) => `n/${id}${part ? `/${part}` : ''}`;

export function buildScene(dp: Datapath, layout: DatapathLayout): Scene {
	const resolved = resolveLayout(dp, layout);
	const ids: string[] = [];

	const bands: SceneNode[] = [];
	for (const band of resolved.bands) {
		bands.push({
			tag: 'g',
			attrs: { class: 'band', 'data-stage': band.id },
			children: [
				{
					tag: 'rect',
					attrs: {
						class: 'band-bg', x: band.x, y: 8,
						width: band.w, height: resolved.canvas.height - 16, rx: 10,
					},
				},
				{
					tag: 'text',
					attrs: { class: 'band-label', x: band.x + 14, y: 32 },
					text: band.label,
				},
				...(band.sublabel ? [{
					tag: 'text',
					attrs: { class: 'band-sublabel', x: band.x + 34, y: 32 },
					text: band.sublabel,
				}] : []),
			],
		});
	}

	// Wires first so components paint over their endpoints.
	const wires: SceneNode[] = [];
	for (const net of dp.nets) {
		const node = buildNet(net, resolved, ids);
		if (node) wires.push(node);
	}

	const parts: SceneNode[] = [];
	for (const component of dp.components) {
		const box = resolved.boxes.get(component.id);
		if (!box) continue;
		parts.push(buildComponent(component, box, ids));
	}

	return {
		width: resolved.canvas.width,
		height: resolved.canvas.height,
		ids,
		nodes: [
			{ tag: 'g', attrs: { class: 'bands' }, children: bands },
			{ tag: 'g', attrs: { class: 'wires' }, children: wires },
			{ tag: 'g', attrs: { class: 'parts' }, children: parts },
		],
	};
}

function buildComponent(
	c: Component,
	box: { x: number; y: number; w: number; h: number },
	ids: string[],
): SceneNode {
	const children: SceneNode[] = [];

	// Native SVG tooltip: no JavaScript, works on hover, and turns the diagram
	// into a glossary that points back at the RTL.
	const tip = [c.label, c.note, c.rtl && `RTL: ${c.rtl}`].filter(Boolean).join('\n');
	if (tip) children.push({ tag: 'title', text: tip });

	children.push(...componentShape(c, box, CID(c.id, 'shape')));
	ids.push(CID(c.id, 'shape'));

	// Text placement. A narrow component (a mux) only has room for a stacked
	// label and value; a wide one puts the label at the top and the live value
	// at the bottom, with the sublabel between them when there is one. Boxes
	// without a sublabel centre the pair instead, so a 40px-tall block does not
	// end up with its label and its value written over each other.
	const compact = box.w < 60;
	const hasSub = Boolean(c.sublabel) && !compact;
	const cx = box.x + box.w / 2;

	const labelY = compact ? box.y + box.h / 2 + 4
		: hasSub ? box.y + 20
			: box.y + box.h / 2 - 2;
	const valueY = compact ? box.y + box.h - 4
		: hasSub ? box.y + box.h - 9
			: box.y + box.h / 2 + 12;

	children.push({
		tag: 'text',
		attrs: {
			class: compact ? 'part-label part-label-compact' : 'part-label',
			x: cx, y: labelY,
		},
		text: c.label,
	});

	if (hasSub) {
		children.push({
			tag: 'text',
			attrs: { class: 'part-sublabel', x: cx, y: box.y + 35 },
			text: c.sublabel!,
		});
	}

	// A slot for whatever the bindings want to show inside this component.
	children.push({
		tag: 'text',
		attrs: { class: 'part-value', id: CID(c.id, 'value'), x: cx, y: valueY },
		text: '',
	});
	ids.push(CID(c.id, 'value'));

	ids.push(CID(c.id));
	return {
		tag: 'g',
		attrs: {
			id: CID(c.id), class: 'part', 'data-type': c.type,
			'data-stage': c.stage, 'data-state': 'idle',
		},
		children,
	};
}

function buildNet(
	net: Net,
	resolved: ReturnType<typeof resolveLayout>,
	ids: string[],
): SceneNode | null {
	const src = resolved.anchors.get(`${net.from.component}.${net.from.port}`);
	if (!src) return null;

	const netLayout = resolved.nets.get(net.id);
	const children: SceneNode[] = [];
	const tip = [net.label ?? net.id, net.note, net.rtl && `RTL: ${net.rtl}`]
		.filter(Boolean).join('\n');
	if (tip) children.push({ tag: 'title', text: tip });

	const labelBranch = netLayout?.labelBranch ?? 0;
	let labelAt: Point | null = null;

	net.to.forEach((dest, k) => {
		const dst = resolved.anchors.get(`${dest.component}.${dest.port}`);
		if (!dst) return;

		const via = netLayout?.branches?.[k]?.via ?? netLayout?.via;
		const points = route({
			from: src.point, fromSide: src.side,
			to: dst.point, toSide: dst.side,
			...(via ? { via } : {}),
		});

		children.push({
			tag: 'path',
			attrs: {
				id: NID(net.id, `b${k}`), class: 'wire',
				d: polylinePath(points), 'marker-end': 'url(#arrow)',
			},
		});
		ids.push(NID(net.id, `b${k}`));

		// A small dot where a fan-out leaves the trunk, the way a schematic
		// marks a junction.
		if (k > 0) {
			children.push({
				tag: 'circle',
				attrs: { class: 'wire-junction', cx: src.point.x, cy: src.point.y, r: 3 },
			});
		}

		if (k === labelBranch) labelAt = midpoint(points);
	});

	if (!children.some((n) => n.tag === 'path')) return null;

	const anchor: Point = labelAt ?? src.point;
	const offset = netLayout?.labelOffset ?? { x: 0, y: -6 };

	if (net.label) {
		children.push({
			tag: 'text',
			attrs: {
				class: 'wire-label', x: anchor.x + offset.x, y: anchor.y + offset.y - 8,
			},
			text: net.label,
		});
	}
	children.push({
		tag: 'text',
		attrs: {
			class: 'wire-value', id: NID(net.id, 'value'),
			x: anchor.x + offset.x, y: anchor.y + offset.y,
		},
		text: '',
	});
	ids.push(NID(net.id, 'value'));

	ids.push(NID(net.id));
	return {
		tag: 'g',
		attrs: {
			id: NID(net.id), class: 'net', 'data-kind': net.kind,
			'data-active': 'false', 'data-emphasis': 'none',
			'data-from': `${net.from.component}.${net.from.port}`,
		},
		children,
	};
}

/**
 * The defs every scene needs: the arrowhead, and the two identical blink
 * keyframes the update indication alternates between (see ./dom.ts).
 */
export function sceneDefs(): SceneNode {
	return {
		tag: 'defs',
		children: [
			{
				tag: 'marker',
				attrs: {
					id: 'arrow', viewBox: '0 0 10 10', refX: 9, refY: 5,
					markerWidth: 5, markerHeight: 5, orient: 'auto-start-reverse',
				},
				children: [{ tag: 'path', attrs: { d: 'M 0 0 L 10 5 L 0 10 z', class: 'arrowhead' } }],
			},
		],
	};
}

/** Serialise a scene to SVG text — used by the tests and for offline rendering. */
export function sceneToSvg(scene: Scene, extraDefs = true): string {
	const esc = (s: string) => s.replace(/[&<>"]/g, (c) =>
		({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

	const emit = (n: SceneNode): string => {
		const attrs = Object.entries(n.attrs ?? {})
			.map(([k, v]) => ` ${k}="${esc(String(v))}"`).join('');
		const inner = (n.text ? esc(n.text) : '') +
			(n.children ?? []).map(emit).join('');
		return inner || n.tag === 'g' ? `<${n.tag}${attrs}>${inner}</${n.tag}>` : `<${n.tag}${attrs}/>`;
	};

	const body = (extraDefs ? [sceneDefs()] : []).concat(scene.nodes).map(emit).join('');
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${scene.width} ${scene.height}">${body}</svg>`;
}
