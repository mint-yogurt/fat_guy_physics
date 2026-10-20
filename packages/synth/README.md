# @fgp/synth

A small custom synth for sound effects and the soundtrack. No dependencies,
and the DSP core touches no browser API, so `src/` can be copied into another
project as is. Not yet wired into the game.

```sh
npm run synth       # test page on http://localhost:5174
```

A sound is six sliders (0-255), two knobs and a note:

| Control | 0 | Then |
| --- | --- | --- |
| **OSC** | off | sine, triangle, sharktooth, saw, square, then the pulse narrowing until it is silent at 255 |
| **FM** | off | soft, bell, metal bar, clangorous (ratio and depth are mapped internally; the FM brightness follows ENV) |
| **RESO** | off | struck modal resonator: woodblock, thud, machinery, clang, glass |
| **PLUCK** | off | Karplus-Strong: pluck, elastic boing, buzzing wire, rain on tin |
| **NOISE** | off | pink, white, then bit and rate crushing; past white the crush clock follows the note's pitch |
| **ENV** | instant attack, 40ms decay | longer decays, slewed attack, a smooth sine hump at 127, then slow attack with quick decay |

The ENV knobs are bipolar attenuverters: **VOL** routes the envelope to
volume (negative inverts, 0 is a flat gate for the envelope's length) and
**OSC** routes it to the pitch of everything pitched: OSC, FM, RESO and
PLUCK (up to 4 octaves, tapered so small values are subtle). PLUCK's
excitation burst comes from the NOISE slider's character, or plain white if
NOISE is off, so with both on you also hear the continuous noise.

A struck sound (RESO, PLUCK) with VOL on and a slow-attack ENV is silent,
because the hit lands while the envelope is still at zero. Set VOL to 0 to
let it ring.

## The code

A patch is shared as a 16-character code in four groups, such as
`0400-1J00-F3Z7-YF0R`: nine bytes (six sliders, two knobs, note) plus a CRC-8
byte, in Crockford base32. Case, dashes and spaces are ignored, `I L O` read
as `1 1 0`, and a typo fails the checksum. Rendering is deterministic (fixed
noise seeds), so a code always produces the same sound. The note is in the
code but callers can override it per play, which is how a MIDI player would
use it. Changing the format later invalidates old codes.

## API

```ts
import { SynthPlayer, decodePatch, renderPatch } from "@fgp/synth";

const patch = decodePatch("0400-1J00-F3Z7-YF0R")!;   // null if invalid
const player = new SynthPlayer();                     // wraps an AudioContext
player.play(patch);                                   // or play(patch, midiNote, when)
const samples = renderPatch(patch, { note: 72 });     // Float32Array, no Web Audio needed
```

`renderPatch` and the code functions are pure, so they also run in a worker
or Node (the tests do). `SynthPlayer` renders to an AudioBuffer, caches it,
and plays one-shots through `player.bus`, the place to hook in the reverb
(not written yet). The tuning tables (FM ratios, RESO and PLUCK profiles,
envelope times) are at the top of `src/dsp.ts`.
