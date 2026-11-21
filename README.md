# bookme

A small booking page you host yourself. People, or their agents, pick an open time on your
calendar and request it. It is one Cloudflare Worker with a D1 database, and it reads your
calendars from their private iCal feeds, so there is no OAuth to set up and nothing runs on
your own computer.

## How it works

- **Open times** are the events on a calendar you create for the purpose, for example one
  called "Booking Availability". A weekly recurring event is a standing set of hours.
- **Busy times** are the events on every other calendar you list. Any calendar that publishes
  an iCal feed should work; Google and Proton are the two tested so far.
- The Worker reads each feed every 15 minutes, and again when someone books. Bookable time is
  open time minus busy time minus existing bookings.
- The page shows a Monday to Friday week in the visitor's time zone. A visitor picks a time,
  30 minutes by default, or an hour where two slots in a row are open.
- Every view has its own address: `?week=2026-12-07` for a week, `?time=2026-12-01T15:00Z` for
  one time. You can send someone a link straight to a time.
- A booking starts as a request. You get an email with an approve or decline link, and on
  approval both sides get a calendar invite. Set `AUTO_CONFIRM` to `true` to skip approval.
- Agents book through the same JSON API the page uses. `/llms.txt` describes it.

To change your availability, edit your calendars. There is no admin page.

## Status

Everything works locally end to end, with email simulated. Not yet checked against a live
deployment: that Gmail adds the emailed invite to the calendar on its own, and removes it
when a cancellation arrives. `PLAN.md` lists what is still unverified.

## Set up

You need Node 24 or newer, a Cloudflare account, and a domain on Cloudflare to send mail from.
Cloudflare Email Sending is in open beta and needs the Workers Paid plan.

```sh
npm install
cp .dev.vars.example .dev.vars     # then fill it in
npx wrangler d1 migrations apply bookme --local
npm run dev                        # http://localhost:8787
```

`.dev.vars` holds who you are and one line per calendar feed. To find a feed's address:

- **Google Calendar:** Settings, pick the calendar, "Secret address in iCal format".
- **Proton Calendar:** in the calendar's settings, share it with a link. A limited-view link
  (free/busy only) parses fine. Whether it carries recurring events is not confirmed, so
  compare the counts from `npm run check-feeds` with what you expect.

A feed address gives read access to the whole calendar. Keep it out of commits, logs, and chat.

Locally no mail is sent. Each message is saved under `.wrangler/tmp/email` instead, which is
where you will find the approve link for a test booking.

## Deploy

```sh
npx wrangler d1 create bookme --update-config    # writes the database id into wrangler.jsonc
npx wrangler d1 migrations apply bookme --remote
npx wrangler email sending enable example.com    # the domain of FROM_EMAIL
npm run deploy -- --domain book.example.com
npx wrangler secret bulk .dev.vars
```

Enabling Email Sending adds DNS records to the domain. If the domain already receives mail
somewhere else, read the records before accepting them.

## Configuration

Secrets, in `.dev.vars` locally and uploaded with `wrangler secret bulk`:

| Name | Meaning |
|---|---|
| `OWNER_NAME` | Your name, as shown on the page and in emails |
| `OWNER_EMAIL` | Where booking requests go; an attendee on every invite |
| `MY_EMAILS` | Every address of yours that appears on your calendars. An event one of them declined does not count as busy |
| `FROM_EMAIL` | The address all mail is sent from |
| `TZ` | Your IANA time zone, used for all-day events and for wording emails |
| `LOCATION` | Text put in every invite, such as a standing video link |
| one per calendar | Any name you like, set to that calendar's feed address |
| `OPEN_FEEDS` | Names of the feeds whose events are open windows |
| `BUSY_FEEDS` | Names of the feeds whose events are busy time |

Settings, in the `vars` of `wrangler.jsonc`:

| Name | Default | Meaning |
|---|---|---|
| `DURATION_MINUTES` | `30` | Length of one slot. A visitor can also book two in a row |
| `MIN_NOTICE_HOURS` | `24` | How soon the earliest bookable time can be |
| `BUFFER_MINUTES` | `0` | Gap kept clear on both sides of every busy event |
| `HORIZON_DAYS` | `60` | How far ahead people can book |
| `AUTO_CONFIRM` | `false` | `true` confirms bookings without asking you |

What counts as busy: an event that is not cancelled, is marked busy rather than free, and that
you have not declined. Google marks all-day events free unless you change them.

Limits on the open form are constants at the top of `src/index.ts`: 10 new requests a day in
total, 3 a day from one network, 2 upcoming bookings per email address, and a request left
unanswered for 48 hours expires. API calls are also capped at 30 a minute per network, set
under `ratelimits` in `wrangler.jsonc`. To enforce the per-network limit, each booking is
stored with the requester's IP address (the /64 network for IPv6). There is no CAPTCHA,
because it would block agents; approval is the spam filter.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/slots` | Every open slot, as UTC start times |
| POST | `/api/bookings` | `{start, name, email, note?, timezone?, duration_minutes?}` |
| GET | `/api/bookings/:id` | `{status, start, end}` |
| POST | `/api/bookings/:id/cancel` | Cancel |
| GET | `/llms.txt` | The same, written for agents and generated from your settings |

Booking and approve links carry a random id. Holding the link is the permission.

## Develop

```sh
npm test              # feed parsing and slot computation
npm run typecheck     # regenerates worker-configuration.d.ts, then runs tsc
npm run check-feeds   # fetch your real feeds: size, timing, counts, no event details
```

`npm run check-feeds -- --show NAME` also lists that feed's windows for the next 14 days.

| Path | What |
|---|---|
| `src/ics.ts` | iCal feed to merged time intervals: recurrence, exceptions, time zones, busy rules |
| `src/slots.ts` | Open minus busy, to slot start times |
| `src/index.ts` | Routes, sync, booking, approval, cancellation, cron |
| `src/email.ts` | Calendar invite and email sending |
| `src/pages.ts` | Manage and approve pages, `/llms.txt` |
| `public/` | The booking page |
| `migrations/` | D1 schema |

## License

MIT. See `LICENSE`.
