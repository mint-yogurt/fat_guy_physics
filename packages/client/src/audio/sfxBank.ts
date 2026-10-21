/**
 * Every sound effect, by name, as an @fgp/synth patch code. This is the one
 * place to change what something sounds like: paste a new code over the old
 * one. The repo-root sfx.md documents what each is for and where it is fired
 * (a test keeps the two in step).
 *
 * Codes marked "new" were designed for this game; the rest came from the
 * original sound list.
 */
export const SFX = {
  // --- movement
  footstep: "1G01-P07S-03Z7-Y9KZ",
  jump: "0400-0000-2KZ4-TDWJ", // new: soft sine "hup"
  landHard: "0003-T000-AQV7-YBWY",
  spawn: "0E6G-0000-B3WH-0BYG",

  // --- menus and map
  menuAccept: "NR00-1480-1MT7-YR73",
  menuBack: "NR00-1480-0CT3-PR18",
  mapClose: "ER05-M800-0FQ7-YM6G",
  inventoryOpen: "SBHX-B3G0-03Z8-6ERD",
  inventoryClose: "SBHX-B3G0-1KZ8-6CYX",
  craftError: "8VSR-W000-2KGQ-YBSX",
  cannotOpen: "BWC0-0000-57W3-Y9N7",

  // --- items
  pickup: "0037-P07V-03Z5-CFTB",
  pickupAlt: "01QQ-P07V-03Z5-CPA7",
  itemDrop: "0004-4000-2BZ7-YBFP", // new: small thud
  throwStick: "0002-SH80-4ZR7-YR0C",
  stickTick: "0000-M000-1KZ7-YG7Y", // new: woodblock tick, a thrown stick hitting something
  outOfAmmo: "JC00-006K-03S7-YBT4",
  eatGoo: "02Z2-FDR0-5FD2-G9MB",
  trampolineBounce: "2R0C-9BG0-AVY5-PBXB",
  trampolineSet: "0000-0NG0-53Z7-YC3J", // new: elastic boing as a mat is put down
  ropeTie: "0000-1AR0-4BZ7-YGTD", // new: wire pluck
  xmasTension: "0000-1180-GQDQ-YBYJ",
  plugIn: "000A-0000-M3KD-EBPZ",

  // --- trees, logs, snow
  chopHit: "0002-G008-2KZ7-YA1Q", // new: wood thock
  treeBreak: "0000-1YQW-5BNQ-YR18",
  logImpact: "0068-TT9X-4FED-J8FN",
  whiff: "0000-001Q-3VPQ-YF7N", // new: air swish, a throw that is let go
  leafPuff: "0000-1W0Y-5QPQ-YP3X", // new: rustle (rain-on-tin pluck)
  lightsShake: "01DE-C000-7KZ7-YQ57", // new: glassy tinkle
  snowPoof: "0004-C00A-33Z7-Y97X", // new: soft thud, snow popping out of a ball
  snowCrunch: "0000-004C-2BZ7-YCJP", // new: bit-crushed crunch

  // --- skateboard
  ollie: "SG00-0000-4KHK-JK7D", // new: rising square blip, Mario jump
  kickflip: "6G00-0000-1VCH-PN3J", // new: quick triangle chirp
  orchestraHit: "N8F0-000S-7BZ7-YC51", // new: saw + soft FM stab, played as a chord on a clean kickflip
  skatePush: "0000-Y01D-7VVQ-YAKA", // new: shoe scrape on grit with a thud
  ragball: "00F0-0NG0-43Z7-Y93B", // new: squashy boing

  // --- hits (reused for scoops, snow bursts and bails until there is combat)
  hit1: "57CG-0000-3BS7-YBS4",
  hit2: "ZC00-1600-4VGA-YBRG",
  hit3: "KFBZ-1RKM-3KCF-JBXZ",
  hit4: "03R0-0000-1KCH-4BYM",
  hit5: "0005-DQ80-7KJQ-YBYW",
  alienHit: "RVHG-1Y80-N3F0-89GQ",

  // --- ambience and status
  halloweenAmbient: "0Z5A-404Y-BKXQ-Y9KM",
  heartbeat: "0002-6000-BSF7-Y9P7",
  psychic: "03TB-A000-JKK7-YPEK",
  nyow: "YF77-T000-GQDT-2BRM",
  mysteriousNoise: "0000-1D00-BZRF-PR58",
  mysteriousThing: "02KG-0000-H7RQ-Y9G8",
  coolNoise: "0002-9HG0-GKPZ-2R0B",
} as const;

export type SfxName = keyof typeof SFX;
