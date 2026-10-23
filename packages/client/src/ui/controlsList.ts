/**
 * Every control, for the main screen (and later menu > controls). Whatever is in the hand
 * also gets its own buttons bottom right: that table is `controlHintsFor` in controlHints.ts.
 * A new key or button goes here too.
 */

export interface ControlRow {
  readonly key: string;
  readonly action: string;
}

export interface ControlGroup {
  readonly title: string;
  readonly rows: readonly ControlRow[];
}

export const CONTROL_GROUPS: readonly ControlGroup[] = [
  {
    title: "move",
    rows: [
      { key: "WASD", action: "walk" },
      { key: "Space", action: "jump" },
      { key: "R", action: "ragball mode (roll)" },
      { key: "V", action: "first / third person view" },
      { key: "- / =", action: "field of view" },
    ],
  },
  {
    title: "do",
    rows: [
      { key: "LMB", action: "scoop (trees, snowbanks, snowballs) / use held item" },
      { key: "RMB", action: "chup" },
      { key: "E", action: "pick up (hold to hoover a pile)" },
      { key: "1-8", action: "hotbar slot" },
      { key: "I", action: "inventory" },
      { key: "M", action: "map (WASD pans, wheel zooms)" },
    ],
  },
  {
    title: "placing",
    rows: [
      { key: "LMB", action: "place" },
      { key: "Scroll", action: "turn 45 degrees" },
      { key: "R + mouse", action: "turn freely" },
    ],
  },
  {
    title: "in hand",
    rows: [
      { key: "stick", action: "LMB swing, hold RMB to throw" },
      { key: "log", action: "tap LMB place, hold LMB bowl, hold RMB lob" },
      { key: "xmas lights", action: "LMB tie each end, RMB run on further, E cancel" },
    ],
  },
  {
    title: "other",
    rows: [
      { key: "Click", action: "capture the mouse" },
      { key: "Esc", action: "release the mouse" },
      { key: "Tab", action: "debug readout" },
    ],
  },
];
