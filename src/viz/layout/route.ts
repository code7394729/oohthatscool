/**
 * route.ts — turning two port anchors into a polyline.
 *
 * Orthogonal (Manhattan) routing, because datapath diagrams are drawn that way
 * and right angles make it far easier to follow a wire across a busy picture.
 *
 * The algorithm is deliberately simple and predictable rather than clever: a
 * short stub straight out of each port, then a single dog-leg between the stub
 * ends. Anything a person would want routed differently is expressed as
 * explicit waypoints in the layout, which is easier to reason about than
 * tuning an auto-router — and it means the picture never changes shape
 * because some heuristic re-evaluated itself.
 */

import { outwardNormal, type Point, type Side } from './types.js';

/** How far a wire leaves a component before it is allowed to turn. */
export const STUB = 14;

export interface RouteEnds {
	from: Point;
	fromSide: Side;
	to: Point;
	toSide: Side;
	via?: Point[];
}

/**
 * @returns the polyline, starting at `from` and ending at `to`
 */
export function route(ends: RouteEnds): Point[] {
	const { from, fromSide, to, toSide, via } = ends;

	const fn = outwardNormal(fromSide);
	const tn = outwardNormal(toSide);
	const a = { x: from.x + fn.x * STUB, y: from.y + fn.y * STUB };
	const b = { x: to.x + tn.x * STUB, y: to.y + tn.y * STUB };

	const horizontalFirst = fromSide === 'e' || fromSide === 'w';
	const middle = via?.length
		? viaPath(a, b, via, horizontalFirst)
		: dogLeg(a, b, fromSide);

	return simplify([from, a, ...middle, b, to]);
}

/**
 * One turn between the two stub ends. Which axis moves first depends on the
 * face the wire left from: a wire leaving east travels horizontally first,
 * which is what makes the result look hand-drawn rather than diagonal.
 */
function dogLeg(a: Point, b: Point, fromSide: Side): Point[] {
	const horizontalFirst = fromSide === 'e' || fromSide === 'w';
	if (horizontalFirst) {
		const mx = (a.x + b.x) / 2;
		return [{ x: mx, y: a.y }, { x: mx, y: b.y }];
	}
	const my = (a.y + b.y) / 2;
	return [{ x: a.x, y: my }, { x: b.x, y: my }];
}

/**
 * Waypoints are corners the wire must reach, and it always reaches them the
 * same way: the axis it left the port on first, then the other. A wire leaving
 * an east or west face goes horizontally to the waypoint's x, then vertically
 * to its y; one leaving north or south does the reverse.
 *
 * Keeping the order fixed rather than alternating is what makes waypoints
 * predictable to author — "get to x = 246, then down to y = 520" is a thing you
 * can hold in your head while nudging a wire around a block.
 */
function viaPath(a: Point, b: Point, via: Point[], horizontalFirst: boolean): Point[] {
	const out: Point[] = [];
	let cur = a;

	const leg = (target: Point) => {
		if (horizontalFirst) {
			out.push({ x: target.x, y: cur.y });
			out.push({ x: target.x, y: target.y });
		} else {
			out.push({ x: cur.x, y: target.y });
			out.push({ x: target.x, y: target.y });
		}
		cur = target;
	};

	for (const v of via) leg(v);
	// Close onto the destination stub the same way; the final point is added by
	// the caller.
	out.push(horizontalFirst ? { x: b.x, y: cur.y } : { x: cur.x, y: b.y });
	return out;
}

/** Drop duplicate and collinear points, which the two passes above generate. */
export function simplify(points: Point[]): Point[] {
	const out: Point[] = [];
	for (const p of points) {
		const last = out[out.length - 1];
		if (last && last.x === p.x && last.y === p.y) continue;
		out.push(p);
	}
	for (let i = 1; i < out.length - 1; ) {
		const a = out[i - 1]!, b = out[i]!, c = out[i + 1]!;
		const collinear = (a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y);
		if (collinear) out.splice(i, 1);
		else i++;
	}
	return out;
}

/** An SVG path `d` for a polyline, with slightly rounded corners. */
export function polylinePath(points: Point[], radius = 6): string {
	if (points.length < 2) return '';
	if (points.length === 2 || radius <= 0)
		return points.map((p, i) => `${i ? 'L' : 'M'}${round(p.x)},${round(p.y)}`).join(' ');

	const parts: string[] = [`M${round(points[0]!.x)},${round(points[0]!.y)}`];
	for (let i = 1; i < points.length - 1; i++) {
		const prev = points[i - 1]!, cur = points[i]!, next = points[i + 1]!;
		const r = Math.min(radius, dist(prev, cur) / 2, dist(cur, next) / 2);
		const p1 = along(cur, prev, r);
		const p2 = along(cur, next, r);
		parts.push(`L${round(p1.x)},${round(p1.y)}`);
		parts.push(`Q${round(cur.x)},${round(cur.y)} ${round(p2.x)},${round(p2.y)}`);
	}
	const last = points[points.length - 1]!;
	parts.push(`L${round(last.x)},${round(last.y)}`);
	return parts.join(' ');
}

/** Midpoint of a polyline by arc length — where a value label wants to sit. */
export function midpoint(points: Point[]): Point {
	const total = length(points);
	let walked = 0;
	for (let i = 1; i < points.length; i++) {
		const a = points[i - 1]!, b = points[i]!;
		const seg = dist(a, b);
		if (walked + seg >= total / 2) {
			const t = seg === 0 ? 0 : (total / 2 - walked) / seg;
			return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
		}
		walked += seg;
	}
	return points[points.length - 1] ?? { x: 0, y: 0 };
}

/** Direction of the final segment, for placing an arrowhead. */
export function endDirection(points: Point[]): Point {
	const b = points[points.length - 1]!;
	const a = points[points.length - 2] ?? b;
	const d = dist(a, b);
	return d === 0 ? { x: 1, y: 0 } : { x: (b.x - a.x) / d, y: (b.y - a.y) / d };
}

export function length(points: Point[]): number {
	let total = 0;
	for (let i = 1; i < points.length; i++) total += dist(points[i - 1]!, points[i]!);
	return total;
}

const dist = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);

const along = (from: Point, toward: Point, r: number): Point => {
	const d = dist(from, toward);
	if (d === 0) return from;
	return { x: from.x + ((toward.x - from.x) / d) * r, y: from.y + ((toward.y - from.y) / d) * r };
};

const round = (v: number) => Math.round(v * 100) / 100;
