// TEMPORARY (2026-05-18): short-lived access-token endpoint for the SDK
// audio spike + Phase C player layer. Returns the access_token derived
// from the refresh token in env. Guarded by a shared secret in ?key=.
//
// Will be replaced by a proper per-device auth flow after Phase F.
// Until then, DELETE THIS FILE if not actively in use — it exposes
// Spotify access tokens to anyone who guesses the URL + key.
export const config = { runtime: "edge" };

const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "*";
const TEST_KEY = "sdk-feasibility-2026-05-18-terry";
const REDIRECT_URI = "https://family-dashboard-proxy.vercel.app/api/spotify-callback";
const SDK_SCOPES = [
  "streaming",
  "user-read-email",
  "user-read-private",            // 2026-05-18: SDK throws "Invalid token scopes" without this
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "user-read-recently-played",
].join(" ");

let _cachedToken = null;
let _tokenExpiresAt = 0;

async function getAccessToken() {
  const now = Date.now();
  if (_cachedToken && now < _tokenExpiresAt - 60_000) {
    return { access_token: _cachedToken, expires_in: Math.floor((_tokenExpiresAt - now) / 1000) };
  }
  const clientId     = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  const refreshToken = process.env.SPOTIFY_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Missing SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET / SPOTIFY_REFRESH_TOKEN env vars.");
  }
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken });
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method:  "POST",
    headers: {
      "Content-Type":  "application/x-www-form-urlencoded",
      "Authorization": "Basic " + btoa(`${clientId}:${clientSecret}`),
    },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`Spotify token refresh failed (${res.status})`);
  const data = await res.json();
  _cachedToken = data.access_token;
  _tokenExpiresAt = now + (data.expires_in ?? 3600) * 1000;
  return { access_token: data.access_token, expires_in: data.expires_in };
}

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
  const url = new URL(req.url);
  if (url.searchParams.get("key") !== TEST_KEY) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": ALLOW_ORIGIN },
    });
  }

  // Phase A helper: build the Spotify authorize URL with the full SDK scope set,
  // using SPOTIFY_CLIENT_ID from env so it's never echoed locally. One-time use,
  // deleted in Phase F alongside the rest of this temp endpoint.
  if (url.searchParams.get("authorize") === "1") {
    const clientId = process.env.SPOTIFY_CLIENT_ID;
    if (!clientId) {
      return new Response(JSON.stringify({ error: "Missing SPOTIFY_CLIENT_ID env var." }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": ALLOW_ORIGIN },
      });
    }
    const authUrl = "https://accounts.spotify.com/authorize?" + new URLSearchParams({
      client_id:     clientId,
      response_type: "code",
      redirect_uri:  REDIRECT_URI,
      scope:         SDK_SCOPES,
    }).toString();
    return new Response(JSON.stringify({ authorize_url: authUrl, redirect_uri: REDIRECT_URI, scope: SDK_SCOPES }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": ALLOW_ORIGIN, "Cache-Control": "no-store" },
    });
  }

  // Phase A helper: exchange an authorization_code for a refresh_token using the
  // env-bound CLIENT_ID/SECRET, so the secret never leaves Vercel. Caller pastes
  // the refresh_token straight into `vercel env add SPOTIFY_REFRESH_TOKEN`.
  const code = url.searchParams.get("code");
  if (code) {
    const clientId     = process.env.SPOTIFY_CLIENT_ID;
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      return new Response(JSON.stringify({ error: "Missing SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET env vars." }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": ALLOW_ORIGIN },
      });
    }
    const body = new URLSearchParams({
      grant_type:   "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
    });
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method:  "POST",
      headers: {
        "Content-Type":  "application/x-www-form-urlencoded",
        "Authorization": "Basic " + btoa(`${clientId}:${clientSecret}`),
      },
      body: body.toString(),
    });
    const data = await res.json();
    if (!res.ok) {
      return new Response(JSON.stringify({ error: "Spotify code exchange failed", status: res.status, detail: data }), {
        status: 502,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": ALLOW_ORIGIN },
      });
    }
    return new Response(JSON.stringify({
      refresh_token: data.refresh_token,
      scope:         data.scope,
      expires_in:    data.expires_in,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": ALLOW_ORIGIN, "Cache-Control": "no-store" },
    });
  }

  try {
    const tok = await getAccessToken();
    return new Response(JSON.stringify(tok), {
      status: 200,
      headers: {
        "Content-Type":  "application/json",
        "Access-Control-Allow-Origin": ALLOW_ORIGIN,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e.message ?? e) }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": ALLOW_ORIGIN },
    });
  }
}
