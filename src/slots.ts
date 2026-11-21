import { merge, type Interval } from "./ics.ts";

/** All values in milliseconds. */
export interface SlotRules {
  duration: number;
  /** Slots start on multiples of this, so times land on :00 and :30 rather than odd minutes. */
  step: number;
  /** Gap kept clear on both sides of every busy interval. */
  buffer: number;
  /** No slot starts before this instant, or ends after `latest`. */
  earliest: number;
  latest: number;
}

/** The parts of `open` not covered by `busy`. Both must be sorted and merged. */
export function subtract(open: Interval[], busy: Interval[]): Interval[] {
  const out: Interval[] = [];
  let i = 0;
  for (let [s, e] of open) {
    while (i < busy.length && busy[i][1] <= s) i++;
    for (let j = i; j < busy.length && busy[j][0] < e; j++) {
      if (busy[j][0] > s) out.push([s, busy[j][0]]);
      s = Math.max(s, busy[j][1]);
    }
    if (s < e) out.push([s, e]);
  }
  return out;
}

/** Start times of every bookable slot. `open` must be sorted and merged; `busy` can be in any order. */
export function slotStarts(open: Interval[], busy: Interval[], r: SlotRules): number[] {
  const padded = merge(busy.map(([s, e]): Interval => [s - r.buffer, e + r.buffer]));
  const out: number[] = [];
  for (const [s, e] of subtract(open, padded)) {
    const first = Math.ceil(Math.max(s, r.earliest) / r.step) * r.step;
    for (let t = first; t + r.duration <= Math.min(e, r.latest); t += r.step) out.push(t);
  }
  return out;
}
