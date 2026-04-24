import ical from "node-ical";

const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "*";
const DAYS_AHEAD = 14;
const MAX_EVENTS = 50;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOW_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
  if (req.method === "OPTIONS") return res.status(204).end();

  const sources = resolveSources();
  if (!sources.length) {
    return res.status(500).json({ error: "No iCal source configured. Set ICAL_URLS or ICAL_URL." });
  }

  const now = new Date();
  const horizon = new Date(now.getTime() + DAYS_AHEAD * 24 * 60 * 60 * 1000);

  const results = await Promise.all(sources.map(s => fetchSource(s, now, horizon)));

  const allEvents = [];
  const sourceDiag = [];
  for (const r of results) {
    sourceDiag.push({ label: r.label, ok: r.ok, count: r.events?.length || 0, error: r.error || null });
    if (r.ok) allEvents.push(...r.events);
  }

  // Dedupe across sources by uid+start (handles same event imported into multiple cals).
  const seen = new Map();
  for (const ev of allEvents) {
    const key = `${ev.uid || ev.title}|${ev.start}`;
    if (!seen.has(key)) seen.set(key, ev);
  }
  const merged = [...seen.values()].sort((a, b) => new Date(a.start) - new Date(b.start));

  if (req.query.debug === "1") {
    return res.status(200).json({
      events: merged,
      diagnostics: {
        sources: sourceDiag,
        totalAfterDedupe: merged.length,
        nowIso: now.toISOString(),
        horizonIso: horizon.toISOString()
      }
    });
  }

  // If every source failed, surface a 502.
  if (results.every(r => !r.ok)) {
    return res.status(502).json({
      error: "All iCal sources failed",
      sources: sourceDiag
    });
  }

  return res.status(200).json({
    events: merged.slice(0, MAX_EVENTS),
    generatedAt: now.toISOString()
  });
}

/**
 * Build the list of sources from env. Supports:
 *   ICAL_URLS   = "url1,url2,url3"   (preferred)
 *   ICAL_LABELS = "Family,Elul,School"  (optional, parallel to ICAL_URLS)
 *   ICAL_URL    = "url"              (legacy, single)
 */
function resolveSources() {
  const urls = process.env.ICAL_URLS
    ? process.env.ICAL_URLS.split(",").map(s => s.trim()).filter(Boolean)
    : process.env.ICAL_URL ? [process.env.ICAL_URL.trim()] : [];

  const labels = process.env.ICAL_LABELS
    ? process.env.ICAL_LABELS.split(",").map(s => s.trim())
    : [];

  return urls.map((url, i) => ({ url, label: labels[i] || `cal-${i + 1}` }));
}

async function fetchSource({ url, label }, now, horizon) {
  try {
    const data = await ical.async.fromURL(url);
    const events = [];

    for (const k of Object.keys(data)) {
      const ev = data[k];
      if (ev.type !== "VEVENT") continue;

      if (ev.rrule) {
        const occurrences = ev.rrule.between(now, horizon, true);
        const durationMs = (ev.end?.getTime?.() || ev.start.getTime()) - ev.start.getTime();
        for (const occ of occurrences) {
          const exKey = occ.toISOString().slice(0, 10);
          if (ev.exdate && Object.values(ev.exdate).some(d => d.toISOString().slice(0, 10) === exKey)) continue;
          const start = new Date(occ);
          const end = new Date(occ.getTime() + durationMs);
          events.push(toJson(ev, start, end, label));
        }
      } else {
        if (!ev.start) continue;
        const start = new Date(ev.start);
        const end = ev.end ? new Date(ev.end) : start;
        if (end < now || start > horizon) continue;
        events.push(toJson(ev, start, end, label));
      }
    }
    return { ok: true, label, events };
  } catch (err) {
    return { ok: false, label, error: String(err.message || err) };
  }
}

function toJson(ev, start, end, source) {
  const allDay = ev.datetype === "date" || (
    start.getUTCHours() === 0 && start.getUTCMinutes() === 0 &&
    end.getUTCHours() === 0 && end.getUTCMinutes() === 0
  );
  return {
    uid: ev.uid || null,
    title: ev.summary || "(no title)",
    location: ev.location || null,
    start: start.toISOString(),
    end: end.toISOString(),
    allDay,
    source
  };
}
