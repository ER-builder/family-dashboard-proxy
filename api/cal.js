import ical from "node-ical";

const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "*";
const DAYS_AHEAD = 14;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOW_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
  if (req.method === "OPTIONS") return res.status(204).end();

  const url = process.env.ICAL_URL;
  if (!url) return res.status(500).json({ error: "ICAL_URL not configured" });

  try {
    const data = await ical.async.fromURL(url);
    const now = new Date();
    const horizon = new Date(now.getTime() + DAYS_AHEAD * 24 * 60 * 60 * 1000);
    const events = [];

    for (const k of Object.keys(data)) {
      const ev = data[k];
      if (ev.type !== "VEVENT") continue;

      // Recurring events: expand occurrences within window.
      if (ev.rrule) {
        const occurrences = ev.rrule.between(now, horizon, true);
        const durationMs = (ev.end?.getTime?.() || ev.start.getTime()) - ev.start.getTime();
        for (const occ of occurrences) {
          // Skip exceptions
          const exKey = occ.toISOString().slice(0, 10);
          if (ev.exdate && Object.values(ev.exdate).some(d => d.toISOString().slice(0, 10) === exKey)) continue;
          const start = new Date(occ);
          const end = new Date(occ.getTime() + durationMs);
          events.push(toJson(ev, start, end));
        }
      } else {
        if (!ev.start) continue;
        const start = new Date(ev.start);
        const end = ev.end ? new Date(ev.end) : start;
        if (end < now || start > horizon) continue;
        events.push(toJson(ev, start, end));
      }
    }

    events.sort((a, b) => new Date(a.start) - new Date(b.start));
    return res.status(200).json({ events: events.slice(0, 50), generatedAt: now.toISOString() });
  } catch (err) {
    return res.status(502).json({ error: "Fetch failed", detail: String(err.message || err) });
  }
}

function toJson(ev, start, end) {
  const allDay = ev.datetype === "date" || (
    start.getUTCHours() === 0 && start.getUTCMinutes() === 0 &&
    end.getUTCHours() === 0 && end.getUTCMinutes() === 0
  );
  return {
    title: ev.summary || "(no title)",
    location: ev.location || null,
    start: start.toISOString(),
    end: end.toISOString(),
    allDay
  };
}
