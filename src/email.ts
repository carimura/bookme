import ICAL from "ical.js";

/** Ends the UID of every calendar event this app creates, so the feed sync can skip them. */
export const uidSuffix = (env: Env) => `.${env.FROM_EMAIL}`;

export interface Booking {
  id: string;
  owner_token: string;
  start: number;
  end: number;
  name: string;
  email: string;
  note: string;
  timezone: string;
  status: "pending" | "confirmed" | "declined" | "cancelled" | "expired";
  sequence: number;
  created_at: number;
}

export const minutes = (b: Booking) => (b.end - b.start) / 60_000;

export const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const when = (ms: number, tz: string) =>
  new Date(ms).toLocaleString("en-US", {
    timeZone: tz, weekday: "short", month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });

/** The meeting time in the booker's zone, plus the owner's when they differ. */
export const bothZones = (b: Booking, env: Env) =>
  when(b.start, b.timezone) + (b.timezone === env.TZ ? "" : ` (${when(b.start, env.TZ)})`);

/** The booking as an iCalendar invite (REQUEST) or cancellation (CANCEL). */
export function invite(b: Booking, env: Env, method: "REQUEST" | "CANCEL", manageUrl: string): string {
  const time = (ms: number) => ICAL.Time.fromJSDate(new Date(ms), true);
  const ev = new ICAL.Component("vevent");
  ev.addPropertyWithValue("uid", b.id + uidSuffix(env));
  ev.addPropertyWithValue("sequence", b.sequence);
  ev.addPropertyWithValue("dtstamp", time(Date.now()));
  ev.addPropertyWithValue("dtstart", time(b.start));
  ev.addPropertyWithValue("dtend", time(b.end));
  ev.addPropertyWithValue("summary", `${b.name} / ${env.OWNER_NAME}`);
  ev.addPropertyWithValue("description", `${b.note ? b.note + "\n\n" : ""}Cancel or check status: ${manageUrl}`);
  ev.addPropertyWithValue("location", env.LOCATION);
  ev.addPropertyWithValue("status", method === "CANCEL" ? "CANCELLED" : "CONFIRMED");
  ev.addPropertyWithValue("organizer", `mailto:${env.FROM_EMAIL}`).setParameter("cn", `${env.OWNER_NAME} (bookings)`);
  for (const [cn, address, partstat] of [[env.OWNER_NAME, env.OWNER_EMAIL, "ACCEPTED"], [b.name, b.email, "NEEDS-ACTION"]]) {
    const a = ev.addPropertyWithValue("attendee", `mailto:${address}`);
    a.setParameter("cn", cn);
    a.setParameter("role", "REQ-PARTICIPANT");
    a.setParameter("partstat", partstat);
    a.setParameter("rsvp", partstat === "ACCEPTED" ? "FALSE" : "TRUE");
  }
  const cal = new ICAL.Component("vcalendar");
  cal.addPropertyWithValue("prodid", "-//bookme//EN");
  cal.addPropertyWithValue("version", "2.0");
  cal.addPropertyWithValue("method", method);
  cal.addSubcomponent(ev);
  return cal.toString();
}

interface Mail {
  to: string | string[];
  replyTo: string;
  subject: string;
  /** Plain text; paragraphs separated by blank lines. */
  text: string;
  ics?: { method: "REQUEST" | "CANCEL"; body: string };
}

export async function send(env: Env, m: Mail): Promise<void> {
  await env.EMAIL.send({
    to: m.to,
    from: { email: env.FROM_EMAIL, name: env.OWNER_NAME },
    replyTo: m.replyTo,
    subject: m.subject,
    text: m.text,
    html: m.text.split("\n\n").map((p) => `<p>${esc(p).replaceAll("\n", "<br>")}</p>`).join(""),
    attachments: m.ics && [{
      content: m.ics.body,
      filename: "invite.ics",
      type: `text/calendar; method=${m.ics.method}; charset=UTF-8`,
      disposition: "attachment",
    }],
  });
}
