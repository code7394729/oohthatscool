/**
 * dom.ts — three helpers for building HTML, so the panels can be written as
 * expressions rather than as ten lines of createElement each.
 *
 * Not a framework and not trying to be one: no reactivity, no diffing, no
 * lifecycle. The panels build their structure once and then write into
 * elements they kept a reference to, which is the same discipline the SVG
 * renderer uses.
 */

export type Attrs = Record<string, string | number | boolean | undefined>;
export type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	attrs: Attrs = {},
	...children: Child[]
): HTMLElementTagNameMap[K] {
	const el = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (v === undefined || v === false) continue;
		if (k === 'class') el.className = String(v);
		else if (k.startsWith('on') && typeof v === 'string') el.setAttribute(k, v);
		else el.setAttribute(k, v === true ? '' : String(v));
	}
	append(el, children);
	return el;
}

export function append(parent: Element, children: Child[]): void {
	for (const c of children) {
		if (c === null || c === undefined || c === false) continue;
		parent.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
	}
}

/** `document.querySelector`, but it throws instead of returning null. */
export function must<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T {
	const el = root.querySelector<T>(selector);
	if (!el) throw new Error(`missing element: ${selector}`);
	return el;
}
