/**
 * GET /api/spotify-now
 *
 * Returns what is currently playing on the Spotify account whose refresh
 * token is stored in the SPOTIFY_REFRESH_TOKEN environment variable.
 *
 * Response (200):
 *   { isPlaying: false }
 *   — or —
 *   {
 *     isPlaying: true,
 *     track:     "Song Title",
 *     artist:    "Artist Name",
 *     album:     "Album Name",
 *     albumArt:  "https://i.scdn.co/image/...",   // 300×300 JPEG URL
 *     progress:  42000,   // ms into track
 *     duration:  210000,  // total track duration ms
 *     spotifyUrl: "https://open.spotify.com/track/..."
 *   }
 *
 * Required Vercel env vars:
 *   SPOTIFY_CLIENT_ID
 *   SPOTIFY_CLIENT_SECRET
 *   SPOTIFY_REFRESH_TOKEN
 */

const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "*";

// Module-level token cache — survives across warm invocations on the same
// serverless instance (Vercel keeps functions warm for ~5 min).
let _cachedToken = null;
let _tokenExpiresAt = 0;

async function getAccessToken() {
  const now = Date.now();
  // Reuse cached token if it has more than 60 s left.
  if (_cachedToken && now < _tokenExpiresAt - 60_000) {
    return _cachedToken;
  }

  const clientId     = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  const refreshToken = process.env.SPOTIFY_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Missing SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET / SPOTIFY_REFRESH_TOKEN env vars.");
  }

  const body = new URLSearchParams({
    grant_type:    "refresh_token",
    refresh_token: refreshToken,
  });

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method:  "POST",
    headers: {
      "Content-Type":  "application/x-www-form-urlencoded",
      "Authorization": "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Spotify token refresh failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  _cachedToken    = data.access_token;
  // expires_in is in seconds; default to 3600 if missing.
  _tokenExpiresAt = now + (data.expires_in ?? 3600) * 1000;
  return _cachedToken;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  ALLOW_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  // Short cache: 8 s so the dashboard's 10 s poll always gets fresh data.
  // (Spotify rate-limits ~180 req/min; we're well under at ~7-8/min.)
  res.setHeader("Cache-Control", "public, s-maxage=8, stale-while-revalidate=15");

  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const token = await getAccessToken();

    const spotifyRes = await fetch(
      "https://api.spotify.com/v1/me/player/currently-playing",
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    // 204 = nothing playing / no active device
    if (spotifyRes.status === 204 || spotifyRes.status === 202) {
      return res.status(200).json({ isPlaying: false });
    }

    if (!spotifyRes.ok) {
      throw new Error(`Spotify API error: ${spotifyRes.status}`);
    }

    const data = await spotifyRes.json();

    // Guard: item can be null if a private session is active.
    if (!data || !data.item) {
      return res.status(200).json({ isPlaying: false });
    }

    const item = data.item;
    const isPlaying = data.is_playing === true;

    // Pick the 300×300 album art (index 1 in the images array, which Spotify
    // always provides at that size; fall back to index 0 if only one size).
    const images = item.album?.images ?? [];
    const albumArt = (images[1] ?? images[0])?.url ?? null;

    return res.status(200).json({
      isPlaying,
      track:      item.name ?? "",
      artist:     (item.artists ?? []).map(a => a.name).join(", "),
      album:      item.album?.name ?? "",
      albumArt,
      progress:   data.progress_ms  ?? 0,
      duration:   item.duration_ms  ?? 0,
      spotifyUrl: item.external_urls?.spotify ?? null,
    });

  } catch (err) {
    // Surface the error in the response so you can debug from the dashboard
    // console without needing to check Vercel logs.
    console.error("[spotify-now]", err);
    return res.status(500).json({ error: String(err.message ?? err) });
  }
}
