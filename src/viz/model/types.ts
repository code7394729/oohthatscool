/**
 * types.ts — the vocabulary for describing a datapath.
 *
 * This is the *semantic* half of the diagram: what the parts are, what signals
 * they have, and what is wired to what. There are no coordinates in this file
 * and none in anything that imports it. Geometry lives in ../layout, and the
 * mapping from simulator state onto these parts lives in ./bindings.ts.
 *
 * The point of the split is that the three change for different reasons and by
 * different people. Adding a forwarding path is a change to the model. Moving
 * the ALU down forty pixels because a wire crossed is a change to the layout.
 * Deciding that a stalled stage should look amber is a change to the CSS. None
 * of those should require touching the other two, and none of them should
 * require editing an SVG file by hand.
 *
 *   model (this file, datapath.ts)   what exists, and what connects to what
 *   layout/                          where it sits and what shape it is
 *   bindings.ts                      what a Snapshot means for each part
 *   render/                          scene primitives, then DOM
 */

/** Which pipeline stage a part belongs to. Hazard3 is F / X / M. */
export type StageId = 'F' | 'X' | 'M' | 'global';

export type PortDirection = 'in' | 'out';

/**
 * What a signal carries. Drives how the wire is drawn, and lets the UI dim
 * whole classes of signal (e.g. "show only data flow").
 */
export type SignalKind =
	| 'data'         // 32-bit values
	| 'address'      // addresses
	| 'instruction'  // instruction words
	| 'control';     // selects, enables, valids

/**
 * Roles a port can play beyond plain data, so a renderer can treat them
 * specially without special-casing component ids.
 */
export type PortRole = 'select' | 'enable' | 'address' | 'writedata' | 'readdata';

export type ComponentType =
	| 'block'     // generic labelled box: decode, branch logic, ...
	| 'mux'       // trapezoid, one output, N data inputs and a select
	| 'alu'       // the notched arrow
	| 'register'  // pipeline register / latch
	| 'regfile'   // the architectural register file
	| 'memory'    // a bus port (fetch, load/store)
	| 'source';   // something that originates a value with no drawn input

export interface Port {
	readonly id: string;
	readonly dir: PortDirection;
	readonly kind: SignalKind;
	/** Shown next to the port and in its tooltip. */
	readonly label?: string;
	readonly role?: PortRole;
}

export interface Component {
	readonly id: string;
	readonly type: ComponentType;
	readonly label: string;
	readonly sublabel?: string;
	readonly stage: StageId;
	readonly ports: readonly Port[];
	/** RTL signal or module this stands for — the audit trail back to Hazard3. */
	readonly rtl?: string;
	/** One sentence for the hover glossary. */
	readonly note?: string;
	/**
	 * For a mux: what each data input means, in port order. Lets the UI say
	 * "selected: forwarded from M" instead of "selected: in1".
	 */
	readonly inputNames?: readonly string[];
}

export interface Endpoint {
	readonly component: string;
	readonly port: string;
}

export interface Net {
	readonly id: string;
	readonly from: Endpoint;
	readonly to: readonly Endpoint[];
	readonly kind: SignalKind;
	readonly label?: string;
	readonly rtl?: string;
	readonly note?: string;
}

export interface Datapath {
	readonly components: readonly Component[];
	readonly nets: readonly Net[];
}

// ---------------------------------------------------------------------------
// Builders
//
// Thin, but they make the description file read like a description rather than
// like a pile of object literals, and they put the port conventions for each
// component type in exactly one place.

export interface BlockOptions {
	stage: StageId;
	label: string;
	sublabel?: string;
	rtl?: string;
	note?: string;
	inputs?: readonly (string | Port)[];
	outputs?: readonly (string | Port)[];
	type?: ComponentType;
}

const toPort = (dir: PortDirection, kind: SignalKind) => (p: string | Port): Port =>
	typeof p === 'string' ? { id: p, dir, kind } : { ...p, dir };

export function block(id: string, opts: BlockOptions): Component {
	return {
		id,
		type: opts.type ?? 'block',
		label: opts.label,
		...(opts.sublabel !== undefined ? { sublabel: opts.sublabel } : {}),
		stage: opts.stage,
		...(opts.rtl !== undefined ? { rtl: opts.rtl } : {}),
		...(opts.note !== undefined ? { note: opts.note } : {}),
		ports: [
			...(opts.inputs ?? []).map(toPort('in', 'data')),
			...(opts.outputs ?? []).map(toPort('out', 'data')),
		],
	};
}

export interface MuxOptions {
	stage: StageId;
	label: string;
	/** One entry per data input, in order; becomes in0, in1, ... */
	inputs: readonly string[];
	rtl?: string;
	note?: string;
	kind?: SignalKind;
}

/**
 * A multiplexer: N data inputs named in0..inN-1, a `sel` control input, and one
 * `out`. `inputs` carries the human-readable meaning of each, which is what the
 * UI shows when it reports which source won.
 */
export function mux(id: string, opts: MuxOptions): Component {
	const kind = opts.kind ?? 'data';
	const ports: Port[] = opts.inputs.map((name, i) => ({
		id: `in${i}`, dir: 'in' as const, kind, label: name,
	}));
	ports.push({ id: 'sel', dir: 'in', kind: 'control', role: 'select', label: 'select' });
	ports.push({ id: 'out', dir: 'out', kind });
	return {
		id, type: 'mux', label: opts.label, stage: opts.stage, ports,
		inputNames: opts.inputs,
		...(opts.rtl !== undefined ? { rtl: opts.rtl } : {}),
		...(opts.note !== undefined ? { note: opts.note } : {}),
	};
}

export interface RegisterOptions extends Omit<BlockOptions, 'inputs' | 'outputs' | 'type'> {
	/**
	 * The fields this register latches. Ports are named `d_<field>` / `q_<field>`
	 * — register vocabulary, and it keeps input and output sides of the same
	 * field from colliding. Omit for a single unnamed field (`d` / `q`).
	 */
	fields?: readonly string[];
	/** Add a `hold` input, for a register a stall can freeze. */
	hold?: boolean;
}

/** A pipeline register. Clocked; `d` in, `q` out. */
export function register(id: string, opts: RegisterOptions): Component {
	const inputs: Port[] = [];
	const outputs: Port[] = [];
	if (opts.fields?.length) {
		for (const f of opts.fields) {
			inputs.push({ id: `d_${f}`, dir: 'in', kind: 'data', label: f });
			outputs.push({ id: `q_${f}`, dir: 'out', kind: 'data', label: f });
		}
	} else {
		inputs.push({ id: 'd', dir: 'in', kind: 'data' });
		outputs.push({ id: 'q', dir: 'out', kind: 'data' });
	}
	if (opts.hold) inputs.push({ id: 'hold', dir: 'in', kind: 'control', role: 'enable', label: 'hold' });

	return block(id, { ...opts, type: 'register', inputs, outputs });
}

export function alu(id: string, opts: Omit<BlockOptions, 'inputs' | 'outputs' | 'type'>): Component {
	return block(id, { ...opts, type: 'alu', inputs: ['a', 'b'], outputs: ['out'] });
}

// ---------------------------------------------------------------------------
// Wiring helpers

export function net(
	id: string,
	from: string,
	to: string | readonly string[],
	opts: { kind?: SignalKind; label?: string; rtl?: string; note?: string } = {},
): Net {
	const parse = (s: string): Endpoint => {
		const [component, port] = s.split('.');
		if (!component || !port) throw new Error(`net ${id}: bad endpoint '${s}', want 'component.port'`);
		return { component, port };
	};
	return {
		id,
		from: parse(from),
		to: (typeof to === 'string' ? [to] : to).map(parse),
		kind: opts.kind ?? 'data',
		...(opts.label !== undefined ? { label: opts.label } : {}),
		...(opts.rtl !== undefined ? { rtl: opts.rtl } : {}),
		...(opts.note !== undefined ? { note: opts.note } : {}),
	};
}

// ---------------------------------------------------------------------------
// Validation
//
// A datapath is a hand-written description with string references in it, so it
// is exactly the kind of thing that rots silently. Checking it is cheap, needs
// no DOM, and runs in the test suite — a typo becomes a failing test rather
// than a wire that quietly stopped animating.

export interface ModelProblems {
	errors: string[];
	warnings: string[];
}

export function validateDatapath(dp: Datapath): ModelProblems {
	const errors: string[] = [];
	const warnings: string[] = [];

	const byId = new Map<string, Component>();
	for (const c of dp.components) {
		if (byId.has(c.id)) errors.push(`duplicate component id '${c.id}'`);
		byId.set(c.id, c);
		const seen = new Set<string>();
		for (const p of c.ports) {
			if (seen.has(p.id)) errors.push(`${c.id}: duplicate port '${p.id}'`);
			seen.add(p.id);
		}
	}

	const resolve = (e: Endpoint, netId: string, want: PortDirection): Port | null => {
		const c = byId.get(e.component);
		if (!c) { errors.push(`net ${netId}: no component '${e.component}'`); return null; }
		const p = c.ports.find((q) => q.id === e.port);
		if (!p) { errors.push(`net ${netId}: ${e.component} has no port '${e.port}'`); return null; }
		if (p.dir !== want)
			errors.push(`net ${netId}: ${e.component}.${e.port} is an ${p.dir} port, expected ${want}`);
		return p;
	};

	const netIds = new Set<string>();
	const driven = new Map<string, string>();   // "comp.port" -> net that drives it
	const touched = new Set<string>();

	for (const n of dp.nets) {
		if (netIds.has(n.id)) errors.push(`duplicate net id '${n.id}'`);
		netIds.add(n.id);

		resolve(n.from, n.id, 'out');
		touched.add(`${n.from.component}.${n.from.port}`);
		if (n.to.length === 0) errors.push(`net ${n.id}: no destinations`);

		for (const t of n.to) {
			resolve(t, n.id, 'in');
			const key = `${t.component}.${t.port}`;
			// One driver per input. The hardware has exactly one, so a second
			// means the model is fudging a mux that should be drawn.
			const already = driven.get(key);
			if (already) errors.push(`${key} is driven by both '${already}' and '${n.id}'`);
			driven.set(key, n.id);
			touched.add(key);
		}
	}

	for (const c of dp.components) {
		for (const p of c.ports) {
			if (!touched.has(`${c.id}.${p.id}`))
				warnings.push(`${c.id}.${p.id} (${p.dir}) is not connected to any net`);
		}
	}

	return { errors, warnings };
}

/** Index for fast lookup, built once and shared by layout, bindings and render. */
export class DatapathIndex {
	readonly components: Map<string, Component>;
	readonly nets: Map<string, Net>;

	constructor(readonly datapath: Datapath) {
		this.components = new Map(datapath.components.map((c) => [c.id, c]));
		this.nets = new Map(datapath.nets.map((n) => [n.id, n]));
	}

	component(id: string): Component {
		const c = this.components.get(id);
		if (!c) throw new Error(`no component '${id}'`);
		return c;
	}

	port(componentId: string, portId: string): Port {
		const p = this.component(componentId).ports.find((q) => q.id === portId);
		if (!p) throw new Error(`no port '${componentId}.${portId}'`);
		return p;
	}
}
