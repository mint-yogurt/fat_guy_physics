/**
 * Debug switch, shown on the HUD as "DEBUG: ON" while set. Changes how the
 * game starts so something can be tested without playing up to it; none of it
 * happens with the flag off. Flip the constant, or override per load with
 * `?debug=0` / `?debug=1`.
 *
 * With it on: the player starts with building pieces (ladders, plywood, logs, 2x4s, wheels) on the hotbar, and a trampoline, a skateboard, a stack of snowballs, ten xmas lights and more in their inventory.
 */
const DEBUG_DEFAULT = true;

function resolve(): boolean {
  const raw = new URLSearchParams(window.location.search).get("debug");
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  return DEBUG_DEFAULT;
}

export const DEBUG = resolve();
