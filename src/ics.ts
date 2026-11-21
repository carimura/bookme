import ICAL from "ical.js";

/** Epoch milliseconds, end exclusive. */
export type Interval = [start: number, end: number];

export interface FeedOptions {
  /** Zone used for all-day events and times with no usable zone. */
  tz: string;
  /** Apply the busy-calendar rules: skip free, declined, and this app's own events. */
  busyOnly?: boolean;
  /** Lowercase addresses; an event one of them declined is not busy. */
  myEmails?: string[];
  /** UID suffix of events this app created; its own database tracks those. */
  ownUidSuffix?: string;
}

const formatters = new Map<string, Intl.DateTimeFormat | null>();

function formatter(tz: string): Intl.DateTimeFormat | null {
  if (!formatters.has(tz)) {
    let f: Intl.DateTimeFormat | null = null;
    try {
      f = new Intl.DateTimeFormat("en-US", {
        timeZone: tz, hourCycle: "h23",
        year: "numeric", month: "numeric", day: "numeric",
        hour: "numeric", minute: "numeric", second: "numeric",
      });
    } catch {} // not an IANA zone name
    formatters.set(tz, f);
  }
  return formatters.get(tz)!;
}

function offsetMs(utcMs: number, f: Intl.DateTimeFormat): number {
  const p: Record<string, number> = {};
  for (const { type, value } of f.formatToParts(utcMs)) p[type] = +value;
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - utcMs;
}

/** Wall-clock time in an IANA zone as epoch ms. */
export function zonedMs(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): number {
  const f = formatter(tz);
  if (!f) throw new RangeError(`Unknown time zone: ${tz}`);
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  // The second pass corrects times that fall just after a DST change.
  return wall - offsetMs(wall - offsetMs(wall, f), f);
}

function toMs(t: ICAL.Time, tzid: string | undefined, fallbackTz: string): number {
  // UTC times and zones defined in the feed are resolved by ical.js.
  if (t.zone !== ICAL.Timezone.localTimezone) return t.toUnixTime() * 1000;
  const tz = tzid && formatter(tzid) ? tzid : fallbackTz;
  return zonedMs(t.year, t.month, t.day, t.hour, t.minute, t.second, tz);
}

function counts(v: ICAL.Component, o: FeedOptions): boolean {
  if (v.getFirstPropertyValue("status") === "CANCELLED") return false;
  if (!o.busyOnly) return true;
  if (v.getFirstPropertyValue("transp") === "TRANSPARENT") return false;
  if (o.ownUidSuffix && String(v.getFirstPropertyValue("uid")).endsWith(o.ownUidSuffix)) return false;
  return !v.getAllProperties("attendee").some((a) =>
    a.getParameter("partstat") === "DECLINED" &&
    o.myEmails?.includes(String(a.getFirstValue()).toLowerCase().replace(/^mailto:/, "")));
}

export function merge(intervals: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const [s, e] of intervals.sort((a, b) => a[0] - b[0])) {
    const last = out.at(-1);
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/** Every event occurrence in an ICS feed that overlaps [from, to), clipped and merged. */
export function feedIntervals(ics: string, from: number, to: number, opts: FeedOptions): Interval[] {
  const cal = new ICAL.Component(ICAL.parse(ics));
  const masters: ICAL.Component[] = [];
  const exceptions = new Map<string, ICAL.Component[]>();
  for (const v of cal.getAllSubcomponents("vevent")) {
    if (!v.hasProperty("recurrence-id")) {
      masters.push(v);
      continue;
    }
    const uid = String(v.getFirstPropertyValue("uid"));
    if (!exceptions.has(uid)) exceptions.set(uid, []);
    exceptions.get(uid)!.push(v);
  }

  const out: Interval[] = [];
  const add = (v: ICAL.Component, start: ICAL.Time, end: ICAL.Time) => {
    if (!counts(v, opts)) return;
    const tzid = v.getFirstProperty("dtstart")?.getParameter("tzid") as string | undefined;
    const s = Math.max(toMs(start, tzid, opts.tz), from);
    const e = Math.min(toMs(end, tzid, opts.tz), to);
    if (s < e) out.push([s, e]);
  };

  for (const v of masters) {
    // Passing the exceptions stops ical.js scanning the whole feed for them per event.
    const ev = new ICAL.Event(v, { exceptions: exceptions.get(String(v.getFirstPropertyValue("uid"))) ?? [] });
    if (!ev.isRecurring()) {
      add(v, ev.startDate, ev.endDate);
      continue;
    }
    const tzid = v.getFirstProperty("dtstart")?.getParameter("tzid") as string | undefined;
    const it = ev.iterator();
    for (let t = it.next(); t; t = it.next()) {
      if (toMs(t, tzid, opts.tz) >= to) break;
      const d = ev.getOccurrenceDetails(t);
      // A changed occurrence is its own VEVENT and is added in the loop below.
      if (d.item !== ev && !d.item.modifiesFuture()) continue;
      add(d.item.component, d.startDate, d.endDate);
    }
  }

  for (const list of exceptions.values()) {
    for (const v of list) {
      const ev = new ICAL.Event(v);
      add(v, ev.startDate, ev.endDate);
    }
  }
  return merge(out);
}
