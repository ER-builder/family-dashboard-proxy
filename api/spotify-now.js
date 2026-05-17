/**
 * GET /api/spotify-now
 *
 * Returns what is currently playing on the Spotify account whose refresh
 * token is stored in the SPOTIFY_REFRESH_TOKEN environment variable.
 *
 * Response (200):
 *   { isPlaying: false, lastPlayed: { track, artist, album, albumArt, spotifyUrl } | null }
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
 * lastPlayed requires the `user-read-recently-played` scope on the refresh
 * token. If the scope is missing the field is `null` and we degrade silently.
 *
 * Required Vercel env vars:
 *   SPOTIFY_CLIENT_ID
 *   SPOTIFY_CLIENT_SECRET
 *   SPOTIFY_REFRESH_TOKEN
 */

// 2026-05-17: migrated to Edge runtime. V8 isolate startup is ~10ms vs ~150ms
// for Node serverless; per-invocation CPU drops ~5×. Combined with the cache
// TTL bump below + 60s dashboard polling, this is part of the -80% Vercel
// Fluid CPU pass after the proxy hit 68% of all account CPU.
//
// Edge runtime quirks vs Node:
//   - No Buffer; use btoa() for base64 (basic-auth header)
//   - No process.env import-time evaluation issues (still works fine)
//   - fetch is global; URLSearchParams is global; both fine
export const config = { runtime: "edge" };

const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "*";

// Module-level token cache — survives across warm invocations on the same
// isolate. Edge isolates stay warm longer than Node functions.
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

  // Edge runtime: btoa() instead of Buffer (no Buffer global in V8 isolate).
  const basicAuth = btoa(`${clientId}:${clientSecret}`);
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method:  "POST",
    headers: {
      "Content-Type":  "application/x-www-form-urlencoded",
      "Authorization": "Basic " + basicAuth,
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

// Fetch the most-recently-played track. Returns null on any failure (missing
// scope, network error, empty history) so the dashboard's idle state still
// renders cleanly.
async function fetchLastPlayed(token) {
  try {
    const r = await fetch(
      "https://api.spotify.com/v1/me/player/recently-played?limit=1",
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!r.ok) return null;
    const data = await r.json();
    const item = data?.items?.[0]?.track;
    if (!item) return null;
    const images = item.album?.images ?? [];
    return {
      track:      item.name ?? "",
      artist:     (item.artists ?? []).map(a => a.name).join(", "),
      album:      item.album?.name ?? "",
      albumArt:   (images[1] ?? images[0])?.url ?? null,
      spotifyUrl: item.external_urls?.spotify ?? null,
    };
  } catch {
    return null;
  }
}

// Adaptive edge cache (2026-05-17 bump): 120s playing / 600s idle.
// Was 15s/20s — but paired with the 2026-05-17 dashboard poll-cadence drop
// (15s → 60s) AND the user-tap cache-bust (?t=<ms> in spCommand), the family
// gets fresh data on every tap regardless of TTL. Background polls just feed
// the UI; cache lag there is invisible. This change alone roughly halves
// Spotify origin hits during playback and cuts idle hits ~8×.
function sendPlayback(payload, isPlaying) {
  const ttl = isPlaying ? 120 : 600;
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "Content-Type":  "application/json",
      "Access-Control-Allow-Origin":  ALLOW_ORIGIN,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Cache-Control": `public, s-maxage=${ttl}, stale-while-revalidate=${ttl * 2}`,
    },
  });
}

// Edge runtime: single (req) → Response signature. No res object.
export default async function handler(req) {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin":  ALLOW_ORIGIN,
        "Access-Control-Allow-Methods": "GET, OPTIONS",
      },
    });
  }

  try {
    const token = await getAccessToken();

    const spotifyRes = await fetch(
      "https://api.spotify.com/v1/me/player/currently-playing",
      { headers: { Authorization: `Bearer ${token}` } }
    );

    // 204 = nothing playing / no active device
    if (spotifyRes.status === 204 || spotifyRes.status === 202) {
      const lastPlayed = await fetchLastPlayed(token);
      return sendPlayback({ isPlaying: false, lastPlayed }, false);
    }

    if (!spotifyRes.ok) {
      throw new Error(`Spotify API error: ${spotifyRes.status}`);
    }

    const data = await spotifyRes.json();

    if (!data || !data.item) {
      const lastPlayed = await fetchLastPlayed(token);
      return sendPlayback({ isPlaying: false, lastPlayed }, false);
    }

    const item = data.item;
    const isPlaying = data.is_playing === true;
    const images = item.album?.images ?? [];
    const albumArt = (images[1] ?? images[0])?.url ?? null;

    return sendPlayback({
      isPlaying,
      track:      item.name ?? "",
      artist:     (item.artists ?? []).map(a => a.name).join(", "),
      album:      item.album?.name ?? "",
      albumArt,
      progress:   data.progress_ms  ?? 0,
      duration:   item.duration_ms  ?? 0,
      spotifyUrl: item.external_urls?.spotify ?? null,
    }, isPlaying);

  } catch (err) {
    console.error("[spotify-now]", err);
    return new Response(JSON.stringify({ error: String(err.message ?? err) }), {
      status: 500,
      headers: {
        "Content-Type":  "application/json",
        "Access-Control-Allow-Origin": ALLOW_ORIGIN,
        "Cache-Control": "no-store",
      },
    });
  }
}
