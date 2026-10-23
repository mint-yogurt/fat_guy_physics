import { Material, NearestFilter, Texture, type Node, type Object3D } from "three/webgpu";
import { abs, fract, sign, step, texture, vec2 } from "three/tsl";

/**
 * N64 texture handling. The console had no mipmaps to speak of and filtered with its own
 * 3-point scheme, so textures here are Nearest with no mips and anisotropy 1, and the ones
 * worth the cost (the ground) are sampled with `n64Sample`.
 *
 * Colour space is left alone on purpose: each loader already picked the one its look was tuned in.
 */

/** Nearest filtering, no mipmaps, no anisotropy. Returns the texture for chaining. */
export function nearestify<T extends Texture>(map: T): T {
  map.magFilter = NearestFilter;
  map.minFilter = NearestFilter;
  map.generateMipmaps = false;
  map.anisotropy = 1;
  map.needsUpdate = true;
  return map;
}

/** Every texture on every material under `root` (a loaded GLB, say) made Nearest. */
export function nearestifyScene<T extends Object3D>(root: T): T {
  root.traverse((object) => {
    const material: unknown = (object as Object3D & { material?: unknown }).material;
    const materials = Array.isArray(material) ? material : [material];
    for (const m of materials) {
      if (!(m instanceof Material)) continue;
      for (const value of Object.values(m)) if (value instanceof Texture) nearestify(value);
    }
  });
  return root;
}

/**
 * The N64's 3-point texture filter: instead of blending 4 texels it blends the nearest texel
 * with its two neighbours towards the sample point, which leaves the console's diagonal smear.
 * (GLideN64's formula.) `map` must be Nearest with no mips; wrapping still works because
 * the shifted uvs go through the sampler. `size` is the texture's width and height in texels.
 */
export function n64Sample(map: Texture, uv: Node<"vec2">, size: number): Node<"vec4"> {
  const tex = texture(map);
  const texels = vec2(size, size);
  const frac = fract(uv.mul(texels).sub(0.5));
  // Which half of the texel quad the point is in decides which two neighbours are used.
  const off = frac.sub(step(1.0, frac.x.add(frac.y)));
  const c0 = tex.sample(uv.sub(off.div(texels)));
  const c1 = tex.sample(uv.sub(vec2(off.x.sub(sign(off.x)), off.y).div(texels)));
  const c2 = tex.sample(uv.sub(vec2(off.x, off.y.sub(sign(off.y))).div(texels)));
  return c0.add(c1.sub(c0).mul(abs(off.x))).add(c2.sub(c0).mul(abs(off.y)));
}
