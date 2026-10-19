/**
 * A monotonic millisecond clock.
 *
 * `performance.now()` exists in browsers, Web Workers, and Node 16+, but it
 * is declared by `lib.dom.d.ts` and `@types/node` -- and @fgp/shared includes
 * neither (see packages/shared/tsconfig.json: no "DOM" lib, empty "types"),
 * precisely so that nothing in the simulation can accidentally depend on a
 * browser API the server will not have. Declaring the one global that is
 * genuinely universal is the narrow exception rather than reopening the whole
 * DOM.
 */
declare const performance: { now(): number };

export function nowMs(): number {
  return performance.now();
}
