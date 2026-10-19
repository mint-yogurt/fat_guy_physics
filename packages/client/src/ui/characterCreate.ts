import { DEFAULT_APPEARANCE, type Appearance } from "../render/playerModel.ts";

/**
 * Name, face, skin and shirt, asked once and remembered. The same values
 * are what multiplayer will send to other clients at M14, so this is the
 * shape of a player's identity, not just a cosmetic menu.
 */

const STORAGE_KEY = "fgp.appearance";

const SKINS = ["#f2d0b0", "#d9a06a", "#9c6b43", "#5f4027"];
const SHIRTS = ["#2f6fb0", "#b03a3a", "#36a05a", "#d8c34a", "#6b4bb0", "#2b2f36"];

export function loadAppearance(): Appearance | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return undefined;
    return { ...DEFAULT_APPEARANCE, ...(JSON.parse(raw) as Partial<Appearance>) };
  } catch {
    return undefined;
  }
}

/** Resolves once the player presses Play. */
export function askAppearance(root: HTMLElement): Promise<Appearance> {
  const chosen: Appearance = { ...(loadAppearance() ?? DEFAULT_APPEARANCE) };

  root.innerHTML = `
    <div class="panel">
      <h1>fat guy physics</h1>
      <label>name <input id="cc-name" maxlength="16" value="${chosen.name}" /></label>
      <div class="row"><span>face</span><div id="cc-face" class="swatches"></div></div>
      <div class="row"><span>skin</span><div id="cc-skin" class="swatches"></div></div>
      <div class="row"><span>shirt</span><div id="cc-shirt" class="swatches"></div></div>
      <button id="cc-play">play</button>
    </div>`;
  root.hidden = false;

  const build = (
    id: string,
    values: string[],
    selected: number,
    onPick: (index: number) => void,
  ): void => {
    const host = root.querySelector(`#${id}`);
    if (host === null) return;
    values.forEach((value, index) => {
      const button = document.createElement("button");
      button.className = "swatch";
      if (value.startsWith("#")) button.style.background = value;
      else button.textContent = value;
      button.classList.toggle("on", index === selected);
      button.addEventListener("click", () => {
        for (const sibling of host.children) sibling.classList.remove("on");
        button.classList.add("on");
        onPick(index);
      });
      host.append(button);
    });
  };

  build("cc-face", [":)", ":|", ":O"], chosen.face, (i) => (chosen.face = i));
  build("cc-skin", SKINS, Math.max(0, SKINS.indexOf(chosen.skin)), (i) => {
    chosen.skin = SKINS[i] ?? DEFAULT_APPEARANCE.skin;
  });
  build("cc-shirt", SHIRTS, Math.max(0, SHIRTS.indexOf(chosen.shirt)), (i) => {
    chosen.shirt = SHIRTS[i] ?? DEFAULT_APPEARANCE.shirt;
  });

  return new Promise<Appearance>((resolve) => {
    const play = (): void => {
      const input = root.querySelector<HTMLInputElement>("#cc-name");
      chosen.name = (input?.value ?? "").trim() || DEFAULT_APPEARANCE.name;
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(chosen));
      } catch {
        // Private browsing; the choice simply does not persist.
      }
      root.hidden = true;
      root.innerHTML = "";
      resolve(chosen);
    };
    root.querySelector("#cc-play")?.addEventListener("click", play);
  });
}
