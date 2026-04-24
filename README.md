# Family Dashboard — Calendar Proxy

Tiny Vercel serverless function. Fetches one or more **secret iCal feeds** from
Google Calendar (or any iCal source), parses them (RRULE-aware via `node-ical`),
merges + dedupes, and returns clean JSON with CORS enabled so the
`family-dashboard` (GitHub Pages) can call it.

## Env vars

- `ICAL_URLS` (sensitive, preferred) — comma-separated list of secret iCal URLs.
  Each calendar stays private; only this server reads them.
- `ICAL_LABELS` (optional) — comma-separated list of friendly labels, parallel to
  `ICAL_URLS`. e.g. `Family,Elul,School`. Used as the `source` field per event so
  the dashboard can color-code in future. Defaults to `cal-1`, `cal-2`, …
- `ICAL_URL` (legacy, sensitive) — single URL. Used only if `ICAL_URLS` is unset.
- `ALLOW_ORIGIN` (optional) — defaults to `*`. Set to `https://er-builder.github.io`
  to lock CORS to the dashboard origin.

## Endpoint

```
GET /api/cal
  → { events: [{ uid, title, location, start, end, allDay, source }, …],
      generatedAt }

GET /api/cal?debug=1
  → adds { diagnostics: { sources: [...], totalAfterDedupe, nowIso, horizonIso } }
```

- Events are filtered to the next 14 days, sorted ascending, capped at 50.
- Recurring events are expanded (RRULE) within the window.
- Events are deduped across sources by `uid|start` (so the same event imported
  into multiple calendars only appears once).
- Cached at Vercel edge for 5 min (`s-maxage=300`, `stale-while-revalidate=600`).
- If a source fetch fails, others still succeed; full failure returns 502.

## Updating the source list

Via Vercel dashboard: Project → Settings → Environment Variables → edit
`ICAL_URLS` (mark **Sensitive**). Redeploy.

Via Vercel CLI:
```bash
vercel env rm ICAL_URLS production -y
printf '%s' "https://...ical1.../basic.ics,https://...ical2.../basic.ics" \
  | vercel env add ICAL_URLS production --sensitive
vercel --prod
```
