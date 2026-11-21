import { feedIntervals, merge, type Interval } from "./ics.ts";
import { slotStarts } from "./slots.ts";
import { bothZones, invite, minutes, send, uidSuffix, when, type Booking } from "./email.ts";
import { approvePage, llmsText, managePage, messagePage } from "./pages.ts";

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const STEP = 30 * MIN;
/** Calendar data older than this is not trusted, and no slots are offered. */
const STALE_AFTER = 2 * HOUR;
/** An unanswered request frees its slot after this long. */
const PENDING_TTL = 48 * HOUR;
/** Limits on what the open form can do: new requests per day overall, upcoming bookings per address. */
const MAX_NEW_PER_DAY = 10;
const MAX_ACTIVE_PER_EMAIL = 2;
/** New requests per day from one network, so a single caller cannot use up the day's total. */
const MAX_NEW_PER_NETWORK = 3;

interface Feeds {
  open: Interval[];
  busy: Interval[];
  syncedAt: number;
}

const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
const json = (data: unknown, status = 200) => Response.json(data, { status });
const fail = (status: number, error: string) => json({ error }, status);
const iso = (ms: number) => new Date(ms).toISOString();
const token = () => crypto.randomUUID().replaceAll("-", "");

/** The caller's address, cut to its /64 network for IPv6, where one device has many addresses. */
function network(request: Request): string {
  const ip = request.headers.get("cf-connecting-ip") ?? "";
  return ip.includes(":") ? ip.split(":").slice(0, 4).join(":") : ip;
}

/** Reads every calendar feed and stores the open and busy intervals. Throws if any feed fails. */
async function sync(env: Env): Promise<Feeds> {
  const now = Date.now();
  const to = now + (env.HORIZON_DAYS + 2) * DAY;
  const myEmails = list(env.MY_EMAILS.toLowerCase());
  const load = async (names: string, busyOnly: boolean) => {
    const perFeed = await Promise.all(list(names).map(async (name) => {
      const url = (env as unknown as Record<string, string | undefined>)[name];
      if (!url) throw new Error(`Feed secret ${name} is not set`);
      const res = await fetch(url);
      const text = await res.text();
      // Errors name the feed, never its URL: the URL is the secret.
      if (!res.ok || !text.startsWith("BEGIN:VCALENDAR")) throw new Error(`Feed ${name} failed with HTTP ${res.status}`);
      return feedIntervals(text, now, to, { tz: env.TZ, busyOnly, myEmails, ownUidSuffix: uidSuffix(env) });
    }));
    return merge(perFeed.flat());
  };
  const feeds: Feeds = { open: await load(env.OPEN_FEEDS, false), busy: await load(env.BUSY_FEEDS, true), syncedAt: now };
  await env.DB.prepare("INSERT INTO cache (key, value) VALUES ('feeds', ?1) ON CONFLICT (key) DO UPDATE SET value = ?1")
    .bind(JSON.stringify(feeds)).run();
  return feeds;
}

async function cached(env: Env): Promise<Feeds | null> {
  const row = await env.DB.prepare("SELECT value FROM cache WHERE key = 'feeds'").first<{ value: string }>();
  const feeds = row && (JSON.parse(row.value) as Feeds);
  return feeds && Date.now() - feeds.syncedAt < STALE_AFTER ? feeds : null;
}

const logged = (e: unknown) => (console.error(e), null);

async function openSlots(env: Env, feeds: Feeds, duration = env.DURATION_MINUTES * MIN): Promise<number[]> {
  const now = Date.now();
  const { results } = await env.DB
    .prepare("SELECT start, end FROM bookings WHERE status IN ('pending', 'confirmed') AND end > ?")
    .bind(now).all<{ start: number; end: number }>();
  return slotStarts(feeds.open, [...feeds.busy, ...results.map((b): Interval => [b.start, b.end])], {
    duration,
    step: STEP,
    buffer: env.BUFFER_MINUTES * MIN,
    earliest: now + env.MIN_NOTICE_HOURS * HOUR,
    latest: now + env.HORIZON_DAYS * DAY,
  });
}

function sendInvite(env: Env, b: Booking, origin: string, method: "REQUEST" | "CANCEL" = "REQUEST") {
  const manage = `${origin}/b/${b.id}`;
  const cancelled = method === "CANCEL";
  return send(env, {
    to: [b.email, env.OWNER_EMAIL],
    replyTo: env.OWNER_EMAIL,
    subject: `${cancelled ? "Cancelled" : "Confirmed"}: ${b.name} / ${env.OWNER_NAME}, ${when(b.start, b.timezone)}`,
    text: cancelled
      ? `The meeting between ${b.name} and ${env.OWNER_NAME} on ${bothZones(b, env)} was cancelled.\n\nBook another time: ${origin}`
      : `${b.name} and ${env.OWNER_NAME} are meeting for ${minutes(b)} minutes.\n\n` +
        `When: ${bothZones(b, env)}\nWhere: ${env.LOCATION}\n\nCancel or check status: ${manage}`,
    ics: { method, body: invite(b, env, method, manage) },
  });
}

const notifyOwner = (env: Env, b: Booking, origin: string) =>
  send(env, {
    to: env.OWNER_EMAIL,
    replyTo: b.email,
    subject: `Booking request: ${b.name}, ${when(b.start, env.TZ)}`,
    text: [
      `${b.name} <${b.email}> asked for ${minutes(b)} minutes on ${when(b.start, env.TZ)}.`,
      b.note && `Their note:\n${b.note}`,
      `Approve or decline: ${origin}/approve/${b.owner_token}`,
      `The time is held until you answer. A request left unanswered for ${PENDING_TTL / HOUR} hours expires.`,
    ].filter(Boolean).join("\n\n"),
  });

async function create(request: Request, env: Env, origin: string): Promise<Response> {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const str = (k: string) => (typeof body?.[k] === "string" ? (body[k] as string).trim() : "");
  const name = str("name").replace(/\s+/g, " ");
  const email = str("email").toLowerCase();
  const note = str("note");
  const start = Date.parse(str("start"));
  if (!name || name.length > 100) return fail(400, "name is required, 100 characters at most.");
  if (email.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) return fail(400, "email must be a valid address.");
  if (note.length > 1000) return fail(400, "note can be 1000 characters at most.");
  if (Number.isNaN(start)) return fail(400, "start must be a time taken from /api/slots.");
  // One slot, or two back to back.
  const duration = ((body?.duration_minutes ?? env.DURATION_MINUTES) as number) * MIN;
  if (duration !== env.DURATION_MINUTES * MIN && duration !== 2 * env.DURATION_MINUTES * MIN) {
    return fail(400, `duration_minutes must be ${env.DURATION_MINUTES} or ${2 * env.DURATION_MINUTES}.`);
  }
  let timezone = env.TZ;
  try {
    if (str("timezone")) timezone = new Intl.DateTimeFormat("en-US", { timeZone: str("timezone") }).resolvedOptions().timeZone;
  } catch {} // unknown zone: word emails in the owner's

  const now = Date.now();
  const ip = network(request);
  const n = (await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM bookings WHERE created_at > ?1) AS recent,
            (SELECT COUNT(*) FROM bookings WHERE created_at > ?1 AND ip = ?4) AS sameNetwork,
            (SELECT COUNT(*) FROM bookings WHERE email = ?2 AND status IN ('pending', 'confirmed') AND end > ?3) AS active`,
  ).bind(now - DAY, email, now, ip).first<{ recent: number; sameNetwork: number; active: number }>())!;
  if (n.active >= MAX_ACTIVE_PER_EMAIL) return fail(429, `That address already has ${n.active} upcoming bookings.`);
  if (n.sameNetwork >= MAX_NEW_PER_NETWORK) return fail(429, "Too many booking requests from your network today. Try again tomorrow.");
  if (n.recent >= MAX_NEW_PER_DAY) return fail(429, "Too many booking requests today. Try again tomorrow.");

  // Re-read the calendars so an event added minutes ago still blocks the slot, but at most once
  // a minute, so a flood of requests cannot make this Worker flood the calendar feeds.
  const last = await cached(env);
  const feeds = last && now - last.syncedAt < MIN ? last : (await sync(env).catch(logged)) ?? last;
  if (!feeds) return fail(503, "Availability is temporarily unavailable. Try again in a few minutes.");
  if (!(await openSlots(env, feeds, duration)).includes(start)) return fail(409, "That time is no longer available. Fetch /api/slots again.");

  const end = start + duration;
  const buffer = env.BUFFER_MINUTES * MIN;
  const b: Booking = {
    id: token(), owner_token: token(), start, end, name, email, note, timezone,
    status: env.AUTO_CONFIRM ? "confirmed" : "pending", sequence: 0, created_at: now,
  };
  // One statement, so two people cannot take the same time.
  const inserted = await env.DB.prepare(
    `INSERT INTO bookings (id, owner_token, start, end, name, email, note, timezone, status, created_at, ip)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?13
     WHERE NOT EXISTS (SELECT 1 FROM bookings WHERE status IN ('pending', 'confirmed') AND start < ?11 AND end > ?12)`,
  ).bind(b.id, b.owner_token, start, end, name, email, note, timezone, b.status, now, end + buffer, start - buffer, ip).run();
  if (!inserted.meta.changes) return fail(409, "That time was just taken. Fetch /api/slots again.");

  try {
    await (b.status === "confirmed" ? sendInvite(env, b, origin) : notifyOwner(env, b, origin));
  } catch (e) {
    console.error(e);
    await env.DB.prepare("DELETE FROM bookings WHERE id = ?").bind(b.id).run();
    return fail(502, "The booking could not be sent. Try again.");
  }
  return json({
    status: b.status,
    start: iso(start),
    end: iso(end),
    manage_url: `${origin}/b/${b.id}`,
    message: b.status === "confirmed"
      ? `Booked. A calendar invite was sent to ${email}.`
      : `Request sent. ${env.OWNER_NAME} approves each one; a calendar invite goes to ${email} once it is confirmed.`,
  }, 201);
}

/** Cancels an upcoming pending or confirmed booking and tells whoever needs to know. */
async function cancel(env: Env, b: Booking, origin: string): Promise<boolean> {
  if ((b.status !== "pending" && b.status !== "confirmed") || b.end < Date.now()) return false;
  const done = await env.DB
    .prepare("UPDATE bookings SET status = 'cancelled', sequence = sequence + 1 WHERE id = ?1 AND status = ?2")
    .bind(b.id, b.status).run();
  if (!done.meta.changes) return false;
  const mail = b.status === "confirmed"
    ? sendInvite(env, { ...b, sequence: b.sequence + 1 }, origin, "CANCEL")
    : send(env, {
        to: env.OWNER_EMAIL,
        replyTo: b.email,
        subject: `Request withdrawn: ${b.name}, ${when(b.start, env.TZ)}`,
        text: `${b.name} <${b.email}> withdrew their request for ${when(b.start, env.TZ)}. Nothing to do.`,
      });
  await mail.catch(logged); // the cancellation stands even if the email fails
  return true;
}

/** The owner's answer to a pending request. Returns false if it was already answered. */
async function decide(env: Env, b: Booking, approve: boolean, notify: boolean, origin: string): Promise<boolean> {
  const claimed = await env.DB
    .prepare("UPDATE bookings SET status = ?1 WHERE id = ?2 AND status = 'pending'")
    .bind(approve ? "confirmed" : "declined", b.id).run();
  if (!claimed.meta.changes) return false;
  if (approve) {
    try {
      await sendInvite(env, b, origin);
    } catch (e) {
      await env.DB.prepare("UPDATE bookings SET status = 'pending' WHERE id = ?").bind(b.id).run();
      throw e;
    }
  } else if (notify) {
    await send(env, {
      to: b.email,
      replyTo: env.OWNER_EMAIL,
      subject: `${env.OWNER_NAME} can't make ${when(b.start, b.timezone)}`,
      text: `${env.OWNER_NAME} can't meet on ${bothZones(b, env)}.\n\nPick another time: ${origin}`,
    }).catch(logged);
  }
  return true;
}

const find = (env: Env, column: "id" | "owner_token", value: string) =>
  env.DB.prepare(`SELECT * FROM bookings WHERE ${column} = ?`).bind(value).first<Booking>();

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const [, a, b, c, d] = url.pathname.split("/");
    const post = request.method === "POST";
    const back = () => Response.redirect(url.href, 303);
    try {
      if (a === "llms.txt" && !b) return new Response(llmsText(env, url.origin, PENDING_TTL / HOUR, MAX_ACTIVE_PER_EMAIL, MAX_NEW_PER_NETWORK), { headers: { "content-type": "text/plain; charset=utf-8" } });

      // A per-minute cap on API calls from one network; the size is set in wrangler.jsonc.
      if (a === "api" && !(await env.API_LIMIT.limit({ key: `bookme:${network(request)}` })).success) {
        return fail(429, "Too many requests. Wait a minute and try again.");
      }

      if (a === "api" && b === "slots" && !c) {
        const feeds = (await cached(env)) ?? (await sync(env).catch(logged));
        if (!feeds) return fail(503, "Availability is temporarily unavailable. Try again in a few minutes.");
        return json({
          owner_name: env.OWNER_NAME,
          duration_minutes: env.DURATION_MINUTES,
          owner_timezone: env.TZ,
          requires_approval: !env.AUTO_CONFIRM,
          slots: (await openSlots(env, feeds)).map(iso),
        });
      }

      if (a === "api" && b === "bookings") {
        if (!c) return post ? create(request, env, url.origin) : fail(405, "POST a booking here.");
        const booking = await find(env, "id", c);
        if (!booking) return fail(404, "No such booking.");
        if (d === "cancel" && post) {
          if (!(await cancel(env, booking, url.origin))) return fail(409, `This booking is ${booking.status} and cannot be cancelled.`);
          return json({ status: "cancelled" });
        }
        if (!d) return json({ status: booking.status, start: iso(booking.start), end: iso(booking.end) });
      }

      if (a === "b" && b && !c) {
        const booking = await find(env, "id", b);
        if (!booking) return messagePage("Booking not found", "This link does not match a booking.", 404);
        if (!post) return managePage(env, booking);
        await cancel(env, booking, url.origin);
        return back();
      }

      if (a === "approve" && b && !c) {
        const booking = await find(env, "owner_token", b);
        if (!booking) return messagePage("Request not found", "This link does not match a booking request.", 404);
        if (!post) return approvePage(env, booking);
        const form = await request.formData();
        await decide(env, booking, form.get("action") === "approve", form.has("notify"), url.origin);
        return back();
      }
    } catch (e) {
      console.error(e);
      return a === "api" ? fail(500, "Something went wrong.") : messagePage("Something went wrong", "Nothing was changed. Try again in a minute.", 500);
    }
    return a === "api" ? fail(404, "Not found.") : messagePage("Page not found", "There is nothing at this address.", 404);
  },

  async scheduled(_controller, env, ctx) {
    const now = Date.now();
    ctx.waitUntil(Promise.all([
      sync(env),
      env.DB.prepare("UPDATE bookings SET status = 'expired' WHERE status = 'pending' AND (created_at < ?1 OR start < ?2)")
        .bind(now - PENDING_TTL, now).run(),
    ]));
  },
} satisfies ExportedHandler<Env>;
