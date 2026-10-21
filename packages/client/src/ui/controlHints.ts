import { ItemType } from "@fgp/shared/items/inventory";

/**
 * The controls that matter right now, bottom right: a keycap per input with
 * what it does under it, for whatever is in the hand. Everything else (WASD,
 * E, the camera keys) is the full legend, which lives in `#controls` in
 * index.html, hidden until the menu has a Controls page to put it on.
 */

export interface ControlHint {
  readonly key: string;
  readonly action: string;
  /** The button is held, not tapped: it charges, or the action lasts as long as it is down. */
  readonly hold?: boolean;
}

/** Where a string of xmas lights has got to, which changes what its buttons do. */
export interface LightsState {
  /** The first end is tied and the other is being aimed. */
  readonly placing: boolean;
  /** Another string is to hand to add to the one being run out. */
  readonly canExtend: boolean;
}

const NOT_PLACING: LightsState = { placing: false, canExtend: false };

/** Key: an item, or `undefined` for bare hands. */
export function controlHintsFor(
  type: ItemType | undefined,
  lights: LightsState = NOT_PLACING,
): readonly ControlHint[] {
  switch (type) {
    case undefined:
      return [
        { key: "LMB", action: "scoop" },
        { key: "RMB", action: "chup" },
      ];
    case ItemType.Stick:
      return [
        { key: "LMB", action: "swing" },
        { key: "RMB", action: "throw", hold: true },
      ];
    case ItemType.Log:
      return [
        { key: "LMB", action: "bowl", hold: true },
        { key: "RMB", action: "lob", hold: true },
      ];
    case ItemType.Snowball:
    case ItemType.Rock:
    case ItemType.Eggnog:
      return [
        { key: "LMB", action: "roll", hold: true },
        { key: "RMB", action: "throw", hold: true },
      ];
    case ItemType.MountainLightning:
    case ItemType.Goo:
      return [
        { key: "LMB", action: "shake", hold: true },
        { key: "RMB", action: "throw", hold: true },
      ];
    case ItemType.Trampoline:
    case ItemType.PresentSmall:
    case ItemType.PresentBig:
    case ItemType.CandyBucket:
      return [{ key: "LMB", action: "place" }];
    case ItemType.Skateboard:
      return [
        { key: "LMB", action: "ollie" },
        { key: "RMB", action: "trick", hold: true },
      ];
    case ItemType.XmasLights: {
      const hints: ControlHint[] = [
        { key: "LMB", action: lights.placing ? "tie end" : "tie first end" },
      ];
      if (lights.placing && lights.canExtend) hints.push({ key: "RMB", action: "extend" });
      if (lights.placing) hints.push({ key: "E", action: "cancel" });
      return hints;
    }
    default:
      return [];
  }
}

export class ControlHints {
  private last = "";

  constructor(private readonly host: HTMLElement) {}

  set(type: ItemType | undefined, lights?: LightsState): void {
    const hints = controlHintsFor(type, lights);
    const signature = hints.map((h) => `${h.key}:${h.action}:${h.hold === true}`).join("|");
    if (signature === this.last) return;
    this.last = signature;

    this.host.replaceChildren();
    for (const hint of hints) {
      const card = document.createElement("div");
      card.className = "hint";
      const key = document.createElement("span");
      key.className = "keycap";
      key.textContent = hint.key;
      const action = document.createElement("span");
      action.className = "hint-action";
      if (hint.hold === true) {
        const tag = document.createElement("span");
        tag.className = "hint-hold";
        tag.textContent = "hold ";
        action.append(tag);
      }
      action.append(hint.action);
      card.append(key, action);
      this.host.append(card);
    }
  }
}
