import assert from "node:assert/strict";
import { test } from "node:test";
import { feedIntervals, merge } from "../src/ics.ts";

const LA = `BEGIN:VTIMEZONE
TZID:America/Los_Angeles
BEGIN:DAYLIGHT
TZOFFSETFROM:-0800
TZOFFSETTO:-0700
DTSTART:19700308T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:-0700
TZOFFSETTO:-0800
DTSTART:19701101T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
END:STANDARD
END:VTIMEZONE`;

const cal = (...parts: string[]) =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", ...parts, "END:VCALENDAR"].join("\n").replace(/\n/g, "\r\n");
const event = (...lines: string[]) => ["BEGIN:VEVENT", ...lines, "END:VEVENT"].join("\n");

const ms = (iso: string) => Date.parse(iso);
const from = ms("2026-10-19T00:00:00-07:00");
const to = ms("2026-11-16T00:00:00-08:00");
const opts = { tz: "America/Los_Angeles" };
const busy = { ...opts, busyOnly: true, myEmails: ["me@example.com"], ownUidSuffix: ".bookings@example.com" };
const iso = (xs: [number, number][]) => xs.map(([s, e]) => [new Date(s).toISOString(), new Date(e).toISOString()]);

// Mondays 9–10 Pacific, crossing the Nov 1 2026 change from PDT to PST.
const weekly = [
  "UID:weekly",
  "DTSTART;TZID=America/Los_Angeles:20261019T090000",
  "DTEND;TZID=America/Los_Angeles:20261019T100000",
  "RRULE:FREQ=WEEKLY;BYDAY=MO",
];

test("weekly event keeps its local time across a DST change", () => {
  for (const feed of [cal(LA, event(...weekly)), cal(event(...weekly))]) { // zone defined in the feed, and not
    assert.deepEqual(iso(feedIntervals(feed, from, to, opts)), [
      ["2026-10-19T16:00:00.000Z", "2026-10-19T17:00:00.000Z"],
      ["2026-10-26T16:00:00.000Z", "2026-10-26T17:00:00.000Z"],
      ["2026-11-02T17:00:00.000Z", "2026-11-02T18:00:00.000Z"],
      ["2026-11-09T17:00:00.000Z", "2026-11-09T18:00:00.000Z"],
    ]);
  }
});

test("deleted, moved, and cancelled occurrences", () => {
  const feed = cal(
    LA,
    event(...weekly, "EXDATE;TZID=America/Los_Angeles:20261026T090000"),
    event( // Nov 2 moved to 2–3 PM
      "UID:weekly",
      "RECURRENCE-ID;TZID=America/Los_Angeles:20261102T090000",
      "DTSTART;TZID=America/Los_Angeles:20261102T140000",
      "DTEND;TZID=America/Los_Angeles:20261102T150000",
    ),
    event( // Nov 9 cancelled
      "UID:weekly",
      "RECURRENCE-ID;TZID=America/Los_Angeles:20261109T090000",
      "DTSTART;TZID=America/Los_Angeles:20261109T090000",
      "DTEND;TZID=America/Los_Angeles:20261109T100000",
      "STATUS:CANCELLED",
    ),
  );
  assert.deepEqual(iso(feedIntervals(feed, from, to, opts)), [
    ["2026-10-19T16:00:00.000Z", "2026-10-19T17:00:00.000Z"],
    ["2026-11-02T22:00:00.000Z", "2026-11-02T23:00:00.000Z"],
  ]);
});

test("busy rules skip free, declined, and own events", () => {
  const at = (uid: string, day: string, ...extra: string[]) =>
    event(`UID:${uid}`, `DTSTART:202610${day}T170000Z`, `DTEND:202610${day}T180000Z`, ...extra);
  const feed = cal(
    at("opaque", "20"),
    at("free", "21", "TRANSP:TRANSPARENT"),
    at("declined", "22", "ATTENDEE;PARTSTAT=DECLINED:mailto:Me@Example.com"),
    at("accepted", "23", "ATTENDEE;PARTSTAT=ACCEPTED:mailto:me@example.com", "ATTENDEE;PARTSTAT=DECLINED:mailto:other@example.com"),
    at("abc.bookings@example.com", "24"),
  );
  assert.equal(feedIntervals(feed, from, to, opts).length, 5);
  assert.deepEqual(iso(feedIntervals(feed, from, to, busy)).map(([s]) => s.slice(0, 10)), ["2026-10-20", "2026-10-23"]);
});

test("all-day events run midnight to midnight in the owner's zone", () => {
  const feed = cal(event("UID:allday", "DTSTART;VALUE=DATE:20261103", "DTEND;VALUE=DATE:20261105"));
  assert.deepEqual(iso(feedIntervals(feed, from, to, opts)), [["2026-11-03T08:00:00.000Z", "2026-11-05T08:00:00.000Z"]]);
});

test("events are clipped to the window and overlaps merge", () => {
  const feed = cal(
    event("UID:a", "DTSTART:20261018T230000Z", "DTEND:20261019T090000Z"),
    event("UID:b", "DTSTART:20261019T083000Z", "DTEND:20261019T100000Z"),
    event("UID:past", "DTSTART:20200101T000000Z", "DTEND:20200101T010000Z"),
  );
  assert.deepEqual(feedIntervals(feed, from, to, opts), [[from, ms("2026-10-19T10:00:00Z")]]);
  assert.deepEqual(merge([[5, 6], [1, 3], [2, 4]]), [[1, 4], [5, 6]]);
});
