// Settings supplied as secrets (see .dev.vars.example), which wrangler.jsonc does not list.
// Each calendar's feed URL is a secret too, read by the names in OPEN_FEEDS and BUSY_FEEDS.
interface Env {
  OWNER_NAME: string;
  OWNER_EMAIL: string;
  MY_EMAILS: string;
  FROM_EMAIL: string;
  TZ: string;
  LOCATION: string;
  OPEN_FEEDS: string;
  BUSY_FEEDS: string;
}
