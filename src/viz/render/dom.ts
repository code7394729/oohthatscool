/**
 * dom.ts — the only file in the datapath renderer that touches a document.
 *
 * Two jobs, and nothing else:
 *   mount()        walk a Scene once and create the SVG elements
 *   applyDisplay() write attributes onto elements looked up by id
 *
 * There is no diffing and no re-rendering. The scene is created once; every
 * frame afterwards writes `data-*` attributes and text onto a few dozen nodes
 * it already has handles for. For a picture with a fixed set of parts that is
 * both simpler and visually steadier than rebuilding a tree — nothing is ever
 * removed and re-added, so CSS transitions run uninterrupted.
 *
 * Appearance lives entirely in the stylesheet. This file writes semantic state
 * (`data-state="stalled"`, `data-emphasis="highlight"`); web/style.css decides
 * what that looks like.
 */

import type { DatapathDisplay } from '../model/bindings.js';
import { CID, NID, sceneDefs, type Scene, type SceneNode } from './scene.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

export class SceneHandles {
	private readonly byId = new Map<string, SVGElement>();

	set(id: string, el: SVGElement): void { this.byId.set(id, el); }
	get(id: string): SVGElement | undefined { return this.byId.get(id); }
	get size(): number { return this.byId.size; }

	/** Ids the scene declared but the DOM does not have — always a bug. */
	missing(expected: string[]): string[] {
		return expected.filter((id) => !this.byId.has(id));
	}
}

function createNode(node: SceneNode, handles: SceneHandles): SVGElement {
	const el = document.createElementNS(SVG_NS, node.tag) as SVGElement;
	for (const [k, v] of Object.entries(node.attrs ?? {})) el.setAttribute(k, String(v));
	if (node.text !== undefined) el.textContent = node.text;
	for (const child of node.children ?? []) el.appendChild(createNode(child, handles));

	const id = node.attrs?.['id'];
	if (typeof id === 'string') handles.set(id, el);
	return el;
}

export interface MountedScene {
	svg: SVGSVGElement;
	handles: SceneHandles;
}

/** Build the SVG element for a scene and put it inside `host`. */
export function mount(scene: Scene, host: Element): MountedScene {
	const handles = new SceneHandles();

	const svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
	svg.setAttribute('viewBox', `0 0 ${scene.width} ${scene.height}`);
	svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
	svg.setAttribute('class', 'datapath');
	svg.setAttribute('role', 'img');
	svg.setAttribute('aria-label', 'Hazard3 datapath');

	svg.appendChild(createNode(sceneDefs(), handles));
	for (const node of scene.nodes) svg.appendChild(createNode(node, handles));

	host.replaceChildren(svg);
	return { svg, handles };
}

/**
 * Write one frame of state onto the mounted scene.
 *
 * Every write is idempotent and to a fixed element, so this can be called as
 * often as the caller likes; the cost is a few hundred attribute writes, which
 * is nothing next to a layout pass.
 */
export function applyDisplay(handles: SceneHandles, display: DatapathDisplay): void {
	for (const [id, d] of Object.entries(display.components)) {
		const group = handles.get(CID(id));
		if (group) {
			setAttr(group, 'data-state', d.state);
			setAttr(group, 'data-selected', d.selected === undefined ? '' : String(d.selected));
		}
		const value = handles.get(CID(id, 'value'));
		if (value) setText(value, d.value ?? '');
	}

	for (const [id, d] of Object.entries(display.nets)) {
		const group = handles.get(NID(id));
		if (group) {
			setAttr(group, 'data-active', d.active ? 'true' : 'false');
			setAttr(group, 'data-emphasis', d.emphasis);
		}
		const value = handles.get(NID(id, 'value'));
		if (value) setText(value, d.value ?? '');
	}
}

/**
 * Flash a component to mark a discrete event.
 *
 * The mechanism is the one described in core/blink.ts: `parity` alternates on
 * every event, and the stylesheet attaches a different (but identical) keyframe
 * animation to each value. Toggling the attribute therefore restarts the
 * animation, which a single animation name would not do — a CSS animation
 * already running is not restarted by setting the same class again. That is
 * what makes a register written on consecutive cycles blink each time instead
 * of glowing steadily.
 */
export function setBlink(el: Element, parity: 0 | 1, active: boolean): void {
	if (!active) {
		if (el.hasAttribute('data-blink')) el.removeAttribute('data-blink');
		return;
	}
	setAttr(el, 'data-blink', String(parity));
}

// Guarded writes: setting an attribute to the value it already has still
// invalidates style in some engines, and re-setting textContent re-creates the
// text node. Both are cheap to avoid and worth avoiding at 60 Hz.
function setAttr(el: Element, name: string, value: string): void {
	if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

function setText(el: Element, value: string): void {
	if (el.textContent !== value) el.textContent = value;
}
