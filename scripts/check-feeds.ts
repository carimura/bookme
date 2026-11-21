// Fetches every feed in .dev.vars and reports size, timing, freshness, and counts.
// Prints feed names only: never URLs, event titles, or busy times.
//
//   node scripts/check-feeds.ts                 report on every feed
//   node scripts/check-feeds.ts --show NAME     also list NAME's windows for the next 14 days
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { feedIntervals, type Interval } from "../src/ics.ts";

const DAY = 864e5;

const vars = parseEnv(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"));
const TZ = vars.TZ!;
const MY_EMAILS = (vars.MY_EMAILS ?? "").toLowerCase().split(",").map((s) => s.trim());
const show = process.argv.includes("--show") ? process.argv[process.argv.indexOf("--show") + 1] : null;
const now = Date.now();

const stamp = (s: string) =>
  Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(9, 11), +s.slice(11, 13), +s.slice(13, 15));
const newest = (text: string, prop: string) => {
  const times = [...text.matchAll(new RegExp(`^${prop}:(\\d{8}T\\d{6})Z`, "gm"))].map((m) => stamp(m[1]));
  return times.length ? `${((now - Math.max(...times)) / 60000).toFixed(1)} min ago` : "none";
};
const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;
const hours = (xs: Interval[]) => (xs.reduce((n, [s, e]) => n + e - s, 0) / 36e5).toFixed(1);
const local = (ms: number) =>
  new Date(ms).toLocaleString("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

for (const [name, url] of Object.entries(vars)) {
  if (!url?.startsWith("https://")) continue;
  console.log(`\n${name}`);

  let t = performance.now();
  const res = await fetch(url);
  const text = await res.text();
  const head = ["cache-control", "expires", "last-modified", "etag"]
    .map((h) => `${h}: ${res.headers.get(h) ?? "-"}`).join(" | ");
  console.log(`  fetch     HTTP ${res.status}, ${(text.length / 1e6).toFixed(2)} MB, ${Math.round(performance.now() - t)} ms`);
  console.log(`  headers   ${head}`);
  if (!res.ok || !text.startsWith("BEGIN:VCALENDAR")) {
    console.log("  not an ICS feed, skipping");
    continue;
  }

  const tzids = new Set([...text.matchAll(/^DT(?:START|END);TZID=([^:]+):/gm)].map((m) => m[1]));
  const defined = new Set([...text.matchAll(/^TZID:(.+?)\r?$/gm)].map((m) => m[1]));
  const events = text.replace(/^BEGIN:VTIMEZONE[\s\S]*?^END:VTIMEZONE/gm, ""); // zone definitions have RRULEs too
  console.log(
    `  events    ${count(events, /^BEGIN:VEVENT/gm)} total, ${count(events, /^RRULE/gm)} recurring, ` +
    `${count(events, /^RECURRENCE-ID/gm)} changed occurrences, ${tzids.size} zones ` +
    `(${[...tzids].filter((z) => !defined.has(z)).length} not defined in the feed)`);
  console.log(`  newest    LAST-MODIFIED ${newest(text, "LAST-MODIFIED")}, DTSTAMP ${newest(text, "DTSTAMP")}`);

  t = performance.now();
  const all = feedIntervals(text, now, now + 62 * DAY, { tz: TZ });
  const ms = Math.round(performance.now() - t);
  const busy = feedIntervals(text, now, now + 62 * DAY, { tz: TZ, busyOnly: true, myEmails: MY_EMAILS });
  console.log(`  expand    ${ms} ms`);
  console.log(`  next 62d  ${all.length} merged windows / ${hours(all)} h (all events), ${busy.length} / ${hours(busy)} h (busy only)`);

  if (name === show) {
    for (const [s, e] of feedIntervals(text, now, now + 14 * DAY, { tz: TZ })) console.log(`    ${local(s)}  →  ${local(e)}`);
  }
}
