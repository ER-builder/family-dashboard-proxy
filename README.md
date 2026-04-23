# Family Dashboard — Calendar Proxy

Tiny Vercel serverless function. Fetches the secret iCal feed for the family
Google Calendar, parses it (RRULE-aware via `node-ical`), returns clean JSON
with CORS enabled so `family-dashboard` (GitHub Pages) can call it.

## Env vars

- `ICAL_URL` (sensitive) — secret iCal URL from Google Calendar settings
- `ALLOW_ORIGIN` (optional) — defaults to `*`. Set to `https://er-builder.github.io` to lock it to the dashboard origin.

## Endpoint

`GET /api/cal` → `{ events: [{title, location, start, end, allDay}, …], generatedAt }`

Cached at the edge for 5 min (s-maxage=300).
