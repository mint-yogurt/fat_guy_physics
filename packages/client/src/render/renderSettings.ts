/**
 * How the picture is made: how many pixels the 3D scene is drawn with, and the shape of the
 * picture. The N64 look is a low internal resolution blown up to the window, so these are
 * player-facing options (a settings menu will call `set`); until it exists they come from the
 * URL (`?res=480`, `?aspect=4:3`) and are remembered in localStorage.
 *
 * Pure apart from the store's storage access, so the maths is testable.
 */

export type AspectMode = "window" | "4:3" | "16:9";

export interface RenderSettings {
  /** Scene height in pixels before it is scaled up. 240 = the console's 320x240; 480 = hi-res mode. */
  readonly internalHeight: number;
  /** The picture's shape. "window" fills the window; the others add black bars when it does not match. */
  readonly aspect: AspectMode;
}

export const DEFAULT_SETTINGS: RenderSettings = { internalHeight: 240, aspect: "window" };

/** Heights the settings menu offers. Other values from the URL are snapped to the nearest. */
export const INTERNAL_HEIGHTS: readonly number[] = [240, 480];

const STORAGE_KEY = "fgp.render";

function parseAspect(text: string | null | undefined): AspectMode | undefined {
  if (text === "4:3" || text === "43") return "4:3";
  if (text === "16:9" || text === "169") return "16:9";
  if (text === "window") return "window";
  return undefined;
}

function snapHeight(value: number): number {
  let best = INTERNAL_HEIGHTS[0] as number;
  for (const h of INTERNAL_HEIGHTS) if (Math.abs(h - value) < Math.abs(best - value)) best = h;
  return best;
}

/** URL flags win over what was stored, which wins over the defaults. */
export function resolveSettings(search: string, stored: string | null): RenderSettings {
  let height = DEFAULT_SETTINGS.internalHeight;
  let aspect = DEFAULT_SETTINGS.aspect;
  if (stored !== null) {
    try {
      const saved: unknown = JSON.parse(stored);
      if (typeof saved === "object" && saved !== null) {
        const record = saved as Record<string, unknown>;
        if (typeof record.internalHeight === "number" && Number.isFinite(record.internalHeight)) {
          height = snapHeight(record.internalHeight);
        }
        aspect = parseAspect(typeof record.aspect === "string" ? record.aspect : undefined) ?? aspect;
      }
    } catch {
      // A corrupt entry is just ignored.
    }
  }
  const params = new URLSearchParams(search);
  const res = Number(params.get("res"));
  if (params.has("res") && Number.isFinite(res) && res > 0) height = snapHeight(res);
  aspect = parseAspect(params.get("aspect")) ?? aspect;
  return { internalHeight: height, aspect };
}

/** Width over height of the picture for a window of the given shape. */
export function viewAspect(mode: AspectMode, windowAspect: number): number {
  if (mode === "4:3") return 4 / 3;
  if (mode === "16:9") return 16 / 9;
  return windowAspect;
}

/** Pixel size of the low-res scene. */
export function internalSize(internalHeight: number, aspect: number): { width: number; height: number } {
  return { width: Math.max(1, Math.round(internalHeight * aspect)), height: internalHeight };
}

/**
 * The fraction of the window the picture covers along each axis (1 = full). A picture narrower
 * than the window leaves bars at the sides; a wider one, bars above and below.
 */
export function pictureFill(viewAspectRatio: number, windowAspect: number): { x: number; y: number } {
  if (windowAspect > viewAspectRatio) return { x: viewAspectRatio / windowAspect, y: 1 };
  return { x: 1, y: windowAspect / viewAspectRatio };
}

export class RenderSettingsStore {
  private current: RenderSettings;
  private readonly listeners: Array<(settings: RenderSettings) => void> = [];

  constructor() {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(STORAGE_KEY);
    } catch {
      // Storage can be blocked; the defaults and URL still work.
    }
    this.current = resolveSettings(window.location.search, stored);
  }

  get settings(): RenderSettings {
    return this.current;
  }

  /** Changes take effect at once and are remembered. */
  set(change: Partial<RenderSettings>): void {
    this.current = {
      internalHeight: change.internalHeight === undefined ? this.current.internalHeight : snapHeight(change.internalHeight),
      aspect: change.aspect ?? this.current.aspect,
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.current));
    } catch {
      // Not remembered, still applied.
    }
    for (const listener of this.listeners) listener(this.current);
  }

  onChange(listener: (settings: RenderSettings) => void): void {
    this.listeners.push(listener);
  }
}
