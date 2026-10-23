/**
 * Who this browser is, to a server.
 *
 * A random 128-bit secret, made once and kept in localStorage. It is the whole of a
 * player's identity: whoever holds it is that player. Hence the rules:
 *
 *  - it is never put in a URL, a log or the page, and is only ever sent over wss://;
 *  - a server stores only a hash of it, so a leaked database is not a pile of logins;
 *  - it is not an IP address (shared and changing) and not a cookie (sent on every
 *    request for no benefit; a game server on another domain could not read it).
 *
 * Singleplayer saves do not use it -- the browser is its own server -- so today this
 * exists only so every browser already has an identity the day the multiplayer server
 * does. Clearing site data makes a new player; that is the known limit of this scheme
 * and the reason an account / recovery code is the planned next step.
 */

const TOKEN_KEY = "fgp.token";
const TOKEN_PATTERN = /^[0-9a-f]{32}$/;

function makeToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** This browser's player token, made on first use. Falls back to a one-visit token if storage is blocked. */
export function playerToken(): string {
  try {
    const existing = localStorage.getItem(TOKEN_KEY);
    if (existing !== null && TOKEN_PATTERN.test(existing)) return existing;
    const fresh = makeToken();
    localStorage.setItem(TOKEN_KEY, fresh);
    return fresh;
  } catch {
    return makeToken();
  }
}
