# SFX

Every sound is an `@fgp/synth` patch code. The names, and the code that plays each, are in
[`packages/client/src/audio/sfxBank.ts`](packages/client/src/audio/sfxBank.ts). **To change a sound, paste
the new code in both that file and this one** (a test fails if they differ). Try codes in the synth
demo: `npm run synth`.

Fire a sound with `audio.play("name", { gain, pitch, variance })` (`audio/gameAudio.ts`). `pitch` and
`variance` are semitones; `chord` is a list of semitone offsets played together. `?audio=0` in the URL mutes everything.

**Status:** HOOKED = fired by the game now. SPARE = code exists, nothing in the game can trigger it yet
(waiting on a feature). **New** = code designed for this game by Claude, not tuned by ear: expect to
adjust.

`main.ts` = `packages/client/src/main.ts`.

## Movement and player

| Name | Code | Status | Fired from | Notes |
|---|---|---|---|---|
| footstep | 1G01-P07S-03Z7-Y9KZ | HOOKED | `main.ts` stride block after the substep loop | One per 1.3 m walked on the ground (`StrideTracker`), pitch alternates +-1 per foot, +-1.5 random. Not while skating or ragballing |
| jump | 0400-0000-2KZ4-TDWJ | HOOKED | `main.ts` substep loop | **New.** Soft sine "hup". Walking, off the ground with upward speed, not on a board and not a trampoline bounce |
| landHard | 0003-T000-AQV7-YBWY | HOOKED | `main.ts` substep loop | Landing faster than 9 m/s, full volume at 24 (`landingGain`). Skipped when the landing caused a skate bail |
| spawn | 0E6G-0000-B3WH-0BYG | HOOKED | `main.ts` `spawned = true`; `Player.respawns` counter | Plays on first spawn and after falling out of the world. Other players: no multiplayer yet |
| ragball | 00F0-0NG0-43Z7-Y93B | HOOKED | `main.ts` R key | **New.** Squashy boing; pitch up when unrolling |

## Menus and map

| Name | Code | Status | Fired from | Notes |
|---|---|---|---|---|
| menuAccept | NR00-1480-1MT7-YR73 | HOOKED | `ui/characterCreate.ts` swatch click and Play | The only menu in the game |
| menuBack | NR00-1480-0CT3-PR18 | HOOKED | `main.ts` Escape while the map is open | Only "back" that exists. Separate from mapClose |
| mapClose | ER05-M800-0FQ7-YM6G | HOOKED | `main.ts` M key closing the map | Map open has no sound; map ping has no code yet |
| inventoryOpen | SBHX-B3G0-03Z8-6ERD | HOOKED | `main.ts` `openInventory` (I key, or right mouse on a container) | |
| inventoryClose | SBHX-B3G0-1KZ8-6CYX | HOOKED | `main.ts` `closeInventory` (I or Esc) | |
| craftError | 8VSR-W000-2KGQ-YBSX | HOOKED | `main.ts` | "Can't do that": inventory full on E or on a reeled-in catch, trampoline can't be placed, rope end too far/near; in the inventory screen, a click that moves nothing and a craft that can't happen (no recipe, cursor holding something else, full stack) |
| cannotOpen | BWC0-0000-57W3-Y9N7 | SPARE | n/a | No doors or containers (presents have no open action yet) |

## Items

| Name | Code | Status | Fired from | Notes |
|---|---|---|---|---|
| pickup | 0037-P07V-03Z5-CFTB | HOOKED | `main.ts` E pickup | Sticks, leaves, logs, snowballs. Leaves at 60% volume (they repeat every 0.12 s) |
| pickupAlt | 01QQ-P07V-03Z5-CPA7 | HOOKED | `main.ts` E pickup, mat pickup, loose board hop-on, fishing rod catch reeled in | Everything else (trampoline, skateboard, xmas lights) |
| itemDrop | 0004-4000-2BZ7-YBFP | HOOKED | `main.ts` a thrown can or ball of goo that did not burst (`vessels.landings`); the fishing hook landing | **New.** Small thud. Not hooked for `dropItem` in general: it also spawns harvest drops and stick splashes (too noisy) |
| throwStick | 0002-SH80-4ZR7-YR0C | HOOKED | `main.ts` `if (threw)` | Spear throw. Thrown logs use it 12 semitones down at 80% |
| stickTick | 0000-M000-1KZ7-YG7Y | HOOKED | `ThrownSticks.onHit`; `harvestPropAt` | **New.** Woodblock tick. A stick hitting a log, mat (+5), prop, or ground (-7), and a swing landing on a prop; the rattle of a can or goo being shaken (+14 to +20, every 0.16 s) |
| outOfAmmo | JC00-006K-03S7-YBT4 | SPARE | n/a | No ammo concept |
| eatGoo | 02Z2-FDR0-5FD2-G9MB | SPARE | n/a | No goo, eating or health |
| trampolineBounce | 2R0C-9BG0-AVY5-PBXB | HOOKED | `main.ts` substep loop, from `TrampolineField.afterPlayerStep` return value | Volume scales with impact speed, then halved (it was too loud). Also the spring shoes' bounds (`SpringStride.afterPlayerStep` return value): quieter and 7 semitones up |
| trampolineSet | 0000-0NG0-53Z7-YC3J | HOOKED | `main.ts` placing a mat or a building piece (ladder pitched up, the rest down) | **New.** Elastic boing, 3 semitones down |
| ropeTie | 0000-1AR0-4BZ7-YGTD | HOOKED | `main.ts` xmas lights; fishing hook snagging an item (+7 semitones) | **New.** Wire pluck. First end, then the second end 5 semitones up |
| xmasTension | 0000-1180-GQDQ-YBYJ | HOOKED | `main.ts` after substeps, from `Rope.tension` | Once when a string is pulled past 50% of `maxForce`, again after it eases below 25%. Fades with distance (40 m) |
| plugIn | 000A-0000-M3KD-EBPZ | SPARE | n/a | No electricity |

## Trees, logs, snow, scooping

| Name | Code | Status | Fired from | Notes |
|---|---|---|---|---|
| chopHit | 0002-G008-2KZ7-YA1Q | HOOKED | `main.ts` `chop.landed`; chup on a felled piece | **New.** Wood thock |
| treeBreak | 0000-1YQW-5BNQ-YR18 | HOOKED | `main.ts` `chop.felled`; `hurtHouse` when a gingerbread house explodes | Only on the hit that fells the tree. Move it to every hit if that was meant |
| logImpact | 0068-TT9X-4FED-J8FN | HOOKED | `LogSystem.onImpact` (`physics/logSystem.ts`) | Any felled piece or thrown log that loses 2.5 m/s in one update (Jolt has no contact events, so a speed drop stands in). Fades with distance (40 m) |
| whiff | 0000-001Q-3VPQ-YF7N | HOOKED | `main.ts` chup swing hits nothing; snowball put; fishing rod cast | **New.** Air swish. Plays every chup tick while swinging at nothing |
| leafPuff | 0000-1W0Y-5QPQ-YP3X | HOOKED | `main.ts` foliage scooped off a tree | **New.** Rustle (rain-on-tin pluck) |
| lightsShake | 01DE-C000-7KZ7-YQ57 | HOOKED | `main.ts` scoop knocks xmas lights off a tree | **New.** Glassy tinkle |
| snowPoof | 0004-C00A-33Z7-Y97X | HOOKED | `main.ts` `popSnow` | **New.** Soft thud. Snow coming out of a rolled snowball or a snowbank; `burstVessel` (+12 for a burst can, -9 for a goo splat) |
| snowCrunch | 0000-004C-2BZ7-YCJP | HOOKED | `main.ts` rolling a snowball along the ground | **New.** Bit-crushed crunch, played at 60% volume |

## Hits (borrowed until there is combat)

| Name | Code | Status | Fired from | Notes |
|---|---|---|---|---|
| hit1 | 57CG-0000-3BS7-YBS4 | SPARE | n/a | |
| hit2 | ZC00-1600-4VGA-YBRG | HOOKED | `main.ts` `flyingSnow.bursts` | Thrown snowball bursts; `burstVessel` (+7 for a can, -6 at half volume for goo). Fades with distance (40 m) |
| hit3 | KFBZ-1RKM-3KCF-JBXZ | HOOKED | `main.ts` `player.skate.bails` counter | Skateboard bail |
| hit4 | 03R0-0000-1KCH-4BYM | HOOKED | `hurtHouse` on every blow on a gingerbread house (+3 semitones) | Shortest of the five, as it repeats every blow |
| hit5 | 0005-DQ80-7KJQ-YBYW | SPARE | n/a | |
| alienHit | RVHG-1Y80-N3F0-89GQ | SPARE | n/a | No aliens |

## Skateboard

| Name | Code | Status | Fired from | Notes |
|---|---|---|---|---|
| ollie | SG00-0000-4KHK-JK7D | HOOKED | `main.ts` `player.skate.ollies` counter | **New.** Square wave sweeping up, Mario jump |
| kickflip | 6G00-0000-1VCH-PN3J | HOOKED | `main.ts` `player.skate.flips` counter | **New.** Quick triangle chirp, when the flip starts |
| orchestraHit | N8F0-000S-7BZ7-YC51 | HOOKED | `main.ts` `player.skate.flipsLanded` counter | **New.** Saw + soft FM stab, played as a five-note chord (`chord` option: -12, 0, +7, +12, +16 semitones) when a kickflip is landed without bailing. `skateboard_sick.png` pops up mid-screen with it (`ui/trickBanner.ts`) |
| skatePush | 0000-Y01D-7VVQ-YAKA | HOOKED | `main.ts` `player.skate.pushes` counter | **New.** Shoe scrape on grit with a low thud: longer and softer than footstep. One per leg stroke while pushing on the board (1.3-2.4 a second as the push ramps up; none once at top speed), 35% volume, pitch +-1 |

## Ambience and status

| Name | Code | Status | Fired from | Notes |
|---|---|---|---|---|
| halloweenAmbient | 0Z5A-404Y-BKXQ-Y9KM | HOOKED | `main.ts` biome block, `AmbienceScheduler` | Every 25-70 s while more than half Halloween, at 45% volume, pitch +-3 |
| heartbeat | 0002-6000-BSF7-Y9P7 | SPARE | n/a | No health |
| psychic | 03TB-A000-JKK7-YPEK | SPARE | n/a | No damage types |
| nyow | YF77-T000-GQDT-2BRM | SPARE | n/a | Event to be chosen (candidates: falling out of the world, `Player.respawns`; skate bail) |
| mysteriousNoise | 0000-1D00-BZRF-PR58 | SPARE | n/a | Event to be chosen |
| mysteriousThing | 02KG-0000-H7RQ-Y9G8 | SPARE | n/a | Event to be chosen |
| coolNoise | 0002-9HG0-GKPZ-2R0B | SPARE | n/a | Event to be chosen |

## Not in the list yet

- **Map ping** has no code. There is no ping action on the map either.
- **Item drop**, **inventory open/close**, **plug in**: see SPARE above.

## Where the hooks live

- Player and skate events come out of the sim as counters (`Player.respawns`, `SkateState.bails/ollies/flips/flipsLanded/pushes`) and
  `TrampolineField.afterPlayerStep`'s return value; `main.ts` watches them. Add a counter the same way for
  new sim events, so the server can run the sim without audio.
- Continuous things become events in `audio/triggers.ts` (`StrideTracker`, `landingGain`, `RisingEdge`,
  `AmbienceScheduler`), with tests in `audio/triggers.test.ts`.
- Sounds that happen away from the player use `hearing(x, y, z)` in `main.ts` for volume. It is not
  positional audio: no panning, just a fade to silence at 40 m.
