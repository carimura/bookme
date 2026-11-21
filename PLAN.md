# bookme: design notes

A small booking page where people, or their agents, book time with one person up to 60 days
ahead. Nothing runs on the owner's own machine.

## Decisions

- **Hosting:** one Cloudflare Worker, D1, and a cron trigger.
- **Calendar reads:** secret read-only iCal feed addresses, fetched by the Worker. No OAuth.
- **Open times:** a calendar kept for the purpose. Every event on it is an open window, and
  recurring events are the standing weekly hours. There is no admin page; the owner edits
  availability in their calendar app.
- **Busy times:** every event on the other feeds that is marked busy.
- **Bookings reach the owner's calendar** as an emailed calendar invite.
- **Email:** the Cloudflare Email Service `send_email` binding.
- **Personal settings are secrets**, not `vars`, so the repository holds nothing about any
  one owner. See `.dev.vars.example`.

## How availability is computed

Availability is derived on every read, never stored as slots:

```
bookable = open windows − busy intervals − active bookings
           clipped to [now + MIN_NOTICE, now + HORIZON]
```

So cancelling something on a real calendar reopens the time, and blocking time is just
creating an event.

Rules for reading the feeds:

- Recurring events (RRULE, EXDATE, RECURRENCE-ID overrides, time zones) are expanded with
  ical.js, not hand-written code.
- An event is busy only if `TRANSP` is not `TRANSPARENT`. Google all-day events default to
  free, so they block nothing unless marked busy.
- `STATUS:CANCELLED` events are skipped, and so are events one of the owner's addresses
  declined (`PARTSTAT=DECLINED`).
- Feed events whose UID ends in `.<FROM_EMAIL>` are skipped. Those are this app's own
  bookings, and D1 is the source of truth for them.

## Sync

- Cron every 15 minutes: fetch all feeds, expand the next 62 days, and store only
  `{start, end}` intervals (no titles) as one JSON blob in D1 with the sync time.
- On `POST /api/bookings`: re-fetch the feeds before accepting, so a slot taken minutes ago
  is caught. If that fetch fails, fall back to the cached intervals.
- If the cache is older than 2 hours, the slots endpoint offers no slots rather than stale ones.

## Booking flow

1. The visitor picks a slot, chooses one slot or two in a row, and gives a name, an email,
   and an optional note.
2. One atomic `INSERT ... WHERE NOT EXISTS (overlapping active booking)` in D1 prevents
   double-booking. The booking starts as `pending` and holds the time.
3. The owner gets an email with the details and a link to an approve/decline page. The buttons
   on that page POST, so mail scanners that prefetch links cannot approve anything.
4. On approve the status becomes `confirmed` and both sides get a calendar invite
   (`METHOD:REQUEST`, organizer `FROM_EMAIL`).
5. Every email carries a manage link. Cancelling sends `METHOD:CANCEL` to both and frees the
   time. A pending request not approved within 48 hours expires.

`AUTO_CONFIRM=true` skips step 3 and goes straight to step 4.

The booker's link and the owner's approve link each carry a random, unguessable id. Holding
the link is the permission.

## Abuse limits

The form can cause email to be sent, so:

- Approval-first means no email reaches a booker's address until the owner approves.
- Caps counted in D1: upcoming bookings per email address, and new requests per day in total.
- No CAPTCHA, because it would block agents.

## Still to verify on a live deployment

- Gmail adds the invite to the calendar when the `.ics` arrives as an attachment. If not, send
  raw MIME with a `text/calendar; method=REQUEST` body part, which the binding also accepts.
- Gmail removes the event when the `METHOD:CANCEL` email arrives.
- The owner's Gmail setting "Add invitations to my calendar" allows the sender.
- How quickly a change on a Google or Proton calendar shows up in its feed. Google builds the
  feed per request; an event saved 9 minutes before a fetch was present. Proton's feed
  advertises a 4-hour refresh interval.
- Whether a Proton limited-view link includes recurring events.

## Later, if wanted

- Write bookings through the Google Calendar API, so the owner owns the event and each
  booking can have its own video link. Needs a one-time OAuth setup.
- An MCP endpoint for agents.
- More than one meeting type.
