/**
 * The cursor drivers every scan in the wikitext parser is built from
 * (#174): a scan is written as one step over the source, and a driver here
 * repeats it. They are the parser's only loops.
 *
 * A scan advances a mutable index through the source and stops early, at a
 * delimiter or the region end. `Arr` combinators express neither the early
 * exit nor the non-local jumps (a scan steps over a whole nested construct
 * at a time) without allocating per character, and a recursive scan would
 * overflow the stack on dump-scale articles. So each scan hands its step to
 * a driver, as a trampoline: the step does one move and says where the scan
 * goes next, or that it has ended, and the driver runs it in constant stack.
 *
 * @copyright Thomas Foster
 * @module wikitext/cursor
 */

/**
 * The first index in `[from, to)` at which `found` holds, moving on from
 * `from` with `next`; `to` when there is none, including when `next` jumps
 * past it. `from` itself is tested first.
 *
 * `found` and `next` take the scan's `context` rather than closing over it,
 * so a scan run once per table line or bracket run can pass module-level
 * functions and allocate nothing.
 */
export function seek<C>(
  context: C,
  from: number,
  to: number,
  found: (context: C, index: number) => boolean,
  next: (context: C, index: number) => number,
): number {
  let index = from;
  while (index < to) {
    if (found(context, index)) return index;
    index = next(context, index);
  }
  return to;
}

/**
 * Runs `step` until it returns `false`: a scan whose position lives
 * elsewhere (a parse cursor's `pos`), and whose step decides for itself
 * whether the scan goes on. `step` runs at least once.
 */
export function repeatWhile(step: () => boolean): void {
  let more = step();
  while (more) more = step();
}
