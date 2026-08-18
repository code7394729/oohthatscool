/**
 * env.d.ts — the host globals src/core is permitted to assume.
 *
 * The core project compiles with neither `lib.dom` nor `@types/node`, so that
 * the compiler (not a convention) enforces its portability between the browser,
 * Node and the test runner. That leaves a small number of genuinely universal
 * globals undeclared. Rather than pulling in a whole lib and losing the
 * guarantee, they are declared here — which doubles as an explicit, reviewable
 * list of what this layer depends on from its host.
 *
 * Only the members actually used are declared, deliberately: widening these
 * would quietly widen what core may reach for.
 */

interface URL {
	readonly href: string;
	toString(): string;
}

declare const URL: {
	prototype: URL;
	new (url: string | URL, base?: string | URL): URL;
};

interface ImportMeta {
	/** Absolute URL of the current module — file:// under Node, http(s) in a page. */
	readonly url: string;
}
