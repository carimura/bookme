import { bothZones, esc, minutes, when, type Booking } from "./email.ts";

function page(title: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/style.css">
</head>
<body><main><h1>${esc(title)}</h1>${body}</main></body>
</html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        // These URLs are the credential; keep them out of Referer headers.
        "referrer-policy": "no-referrer",
      },
    },
  );
}

export const messagePage = (title: string, message: string, status = 200) =>
  page(title, `<p>${esc(message)}</p><p><a href="/">Back to booking</a></p>`, status);

const details = (rows: [string, string][]) =>
  `<dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v).replaceAll("\n", "<br>")}</dd>`).join("")}</dl>`;

const upcoming = (b: Booking) => (b.status === "pending" || b.status === "confirmed") && b.end > Date.now();

/** What the booker sees at their manage link. */
export function managePage(env: Env, b: Booking): Response {
  const title = {
    pending: `Waiting for ${env.OWNER_NAME} to confirm`,
    confirmed: "Your meeting is confirmed",
    declined: `${env.OWNER_NAME} couldn't make this time`,
    cancelled: "This meeting was cancelled",
    expired: "This request expired",
  }[b.status];
  const what = b.status === "pending" ? "request" : "meeting";
  return page(
    title,
    (b.status === "pending" ? `<p>A calendar invite will be emailed to ${esc(b.email)} once it is confirmed.</p>` : "") +
    details([
      ["Who", `${b.name} and ${env.OWNER_NAME}`],
      ["When", bothZones(b, env)],
      ["Length", `${minutes(b)} minutes`],
      ["Where", env.LOCATION],
    ]) +
    (upcoming(b)
      ? `<p class="muted">You can come back to this link later to cancel. To change the time, cancel and book a new one.</p>
<form method="post"><button class="danger">Cancel this ${what}</button></form>`
      : "") +
    `<p><a href="/">Book another time</a></p>`,
  );
}

/** What the owner sees at the approve link from the request email. */
export function approvePage(env: Env, b: Booking): Response {
  const pending = b.status === "pending" && b.end > Date.now();
  return page(
    pending ? "Booking request" : `This request is ${b.status}`,
    details([
      ["From", `${b.name} <${b.email}>`],
      ["When", when(b.start, env.TZ)],
      ["Length", `${minutes(b)} minutes`],
      ...(b.note ? [["Note", b.note] as [string, string]] : []),
    ]) +
    (pending
      ? `<form method="post">
<button name="action" value="approve">Approve and send invite</button>
<button name="action" value="decline" class="danger">Decline</button>
<label class="check"><input type="checkbox" name="notify" checked> If I decline, email them to say so</label>
</form>`
      : b.status === "confirmed" ? `<p><a href="/b/${esc(b.id)}">Open the meeting page</a> to cancel it.</p>` : ""),
  );
}

/** Plain-text description of the API, for agents. */
export function llmsText(env: Env, origin: string, pendingHours: number, maxPerEmail: number, maxPerNetwork: number): string {
  const outcome = env.AUTO_CONFIRM
    ? `Returns 201 with "status": "confirmed". A calendar invite is emailed to the address given.`
    : `Returns 201 with "status": "pending". ${env.OWNER_NAME} approves each request by hand. Once approved, the
status becomes "confirmed" and a calendar invite is emailed to the address given. A request not
answered within ${pendingHours} hours becomes "expired". No email is sent before approval.`;
  return `# Book time with ${env.OWNER_NAME}

This site books ${env.DURATION_MINUTES}- or ${2 * env.DURATION_MINUTES}-minute meetings with ${env.OWNER_NAME}. It has a JSON API and needs no key.

## Find open times

GET ${origin}/api/slots

Returns {"owner_name", "duration_minutes", "owner_timezone", "requires_approval", "slots": [...]}.
Each slot is a UTC start time such as "2026-12-01T15:00:00.000Z". Slots cover the next
${env.HORIZON_DAYS} days and start at least ${env.MIN_NOTICE_HOURS} hours from now.

## Book one

POST ${origin}/api/bookings
Content-Type: application/json

{"start": "<a value from slots>", "name": "<who the meeting is for>", "email": "<their address>",
 "note": "<optional: what it is about>", "timezone": "<optional IANA zone, e.g. Europe/Berlin>",
 "duration_minutes": <optional: ${env.DURATION_MINUTES} (the default) or ${2 * env.DURATION_MINUTES}>}

${2 * env.DURATION_MINUTES} minutes can be booked only when the slot ${env.DURATION_MINUTES} minutes after "start" is also in slots.

${outcome}
The response also has "start", "end", and "manage_url".

Errors are {"error": "<what went wrong>"} with status 400 (bad input), 409 (time no longer
available; fetch slots again), 429 (a limit was reached), or 503 (try again shortly).

## Check or cancel

GET  ${origin}/api/bookings/<id>          returns {"status", "start", "end"}
POST ${origin}/api/bookings/<id>/cancel   returns {"status": "cancelled"}

<id> is the last path segment of manage_url. A person can open manage_url in a browser instead.

## Rules

- Give the real name and email address of the person who will attend.
- An address can hold at most ${maxPerEmail} upcoming bookings, and one network can make ${maxPerNetwork} requests a day.
- Fetch slots when you need them rather than polling. Calls are rate limited per minute.
- If you are an agent booking for someone, say so in the note.
`;
}
