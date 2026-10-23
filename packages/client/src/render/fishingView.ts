import {
  BoxGeometry,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  RingGeometry,
  SphereGeometry,
  Vector3,
  type Scene,
} from "three/webgpu";

import type { Fishing } from "@fgp/shared/items/fishing";
import type { GroundSampler } from "@fgp/shared/items/pickupField";
import { XMAS_LIGHTS } from "@fgp/shared/items/rope";

import { ROPE_THICKNESS, RopeChain, type RopeParts } from "./ropeView.ts";

/**
 * The fishing rod's line, hook and aim line, drawn.
 *
 * The line is a string of xmas lights drawn a little thinner (`settings.lineScale`): the same
 * chain as a tied string, laid along a gentle curve from the rod's tip to the hook. It is
 * built for the longest line the rod allows and uses as many segments as the line is long.
 * The curve is only drawn, not simulated: it hangs by `fishing.sag` and is kept off the ground.
 *
 * The aim line is a row of dashes along the path the cast would take, ending in a ring where it
 * would come down.
 */

/** One dash of the aim line and the gap after it, metres. */
const DASH = 0.4;
const GAP = 0.3;
const DASH_THICKNESS = 0.04;
const DASH_COLOR = 0xffffff;
const RING_COLOR = 0xfff2a0;
const HOOK_RADIUS = 0.08;
/** The line is kept at least this far above the ground, metres. */
const LINE_CLEARANCE = 0.05;

const DOWN = new Vector3(0, -1, 0);

export class FishingView {
  private readonly chain: RopeChain;
  private readonly points: Vector3[] = [];
  private readonly hook = new Group();
  private readonly dashes: Mesh[] = [];
  private readonly ring: Mesh;
  private readonly segmentSpacing = XMAS_LIGHTS.maxSegmentLength;
  private readonly tip = new Vector3();
  private readonly cumulative: number[] = [];
  private readonly start = new Vector3();
  private readonly end = new Vector3();

  constructor(
    private readonly scene: Scene,
    parts: RopeParts,
    private readonly fishing: Fishing,
  ) {
    const settings = fishing.settings;
    const count = Math.max(1, Math.ceil(settings.maxLineLength / this.segmentSpacing));
    this.chain = new RopeChain(parts, count, ROPE_THICKNESS * settings.lineScale);
    this.chain.root.visible = false;
    this.chain.root.traverse((object) => {
      if (object instanceof Mesh) object.castShadow = false;
    });
    for (let i = 0; i <= count; i++) this.points.push(new Vector3());
    scene.add(this.chain.root);

    // A bobber: white above, red below.
    const red = new MeshBasicMaterial({ color: 0xe03a2a });
    const white = new MeshBasicMaterial({ color: 0xf4f4f0 });
    const top = new Mesh(new SphereGeometry(HOOK_RADIUS, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), white);
    const bottom = new Mesh(
      new SphereGeometry(HOOK_RADIUS, 12, 6, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
      red,
    );
    this.hook.add(top, bottom);
    this.hook.visible = false;
    scene.add(this.hook);

    const dashGeometry = new BoxGeometry(DASH_THICKNESS, DASH_THICKNESS, 1);
    const dashMaterial = new MeshBasicMaterial({
      color: new Color(DASH_COLOR),
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });
    // Enough for a full-length cast with room to spare.
    const dashCount = Math.ceil((settings.maxLineLength * 1.6) / (DASH + GAP)) + 2;
    for (let i = 0; i < dashCount; i++) {
      const dash = new Mesh(dashGeometry, dashMaterial);
      dash.visible = false;
      dash.castShadow = false;
      this.dashes.push(dash);
      scene.add(dash);
    }
    this.ring = new Mesh(
      new RingGeometry(0.22, 0.3, 24),
      new MeshBasicMaterial({
        color: RING_COLOR,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
        side: DoubleSide,
      }),
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.visible = false;
    scene.add(this.ring);
  }

  /**
   * Draws the line from `tip` (the rod's line mark, in world space; undefined if the rod is not
   * on show) and the aim line, for the current frame.
   */
  update(tip: Vector3 | undefined, ground: GroundSampler): void {
    const fishing = this.fishing;
    const showLine = fishing.lineOut && tip !== undefined;
    this.chain.root.visible = showLine;
    this.hook.visible = fishing.lineOut;
    if (fishing.lineOut) this.hook.position.set(fishing.hookX, fishing.hookY, fishing.hookZ);
    if (showLine) this.layLine(tip, ground);
    this.layAim(tip !== undefined);
  }

  private layLine(tip: Vector3, ground: GroundSampler): void {
    const fishing = this.fishing;
    this.tip.copy(tip);
    const dx = fishing.hookX - tip.x;
    const dy = fishing.hookY - tip.y;
    const dz = fishing.hookZ - tip.z;
    const distance = Math.hypot(dx, dy, dz);
    const segments = Math.min(this.points.length - 1, Math.max(3, Math.round(distance / this.segmentSpacing)));
    const sag = distance * fishing.sag;
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const point = this.points[i];
      if (point === undefined) continue;
      const x = tip.x + dx * t;
      const z = tip.z + dz * t;
      let y = tip.y + dy * t - 4 * sag * t * (1 - t);
      // Never through the ground, except where it is tied to the hook.
      if (i > 0 && i < segments) y = Math.max(y, ground(x, z) + LINE_CLEARANCE);
      point.set(x, y, z);
    }
    this.chain.along(this.points.slice(0, segments + 1), (_mid, out) => out.copy(DOWN));
  }

  private layAim(rodOnShow: boolean): void {
    const fishing = this.fishing;
    const n = rodOnShow ? fishing.pathCount : 0;
    const path = fishing.path;

    // Length along the path to each point.
    const cumulative = this.cumulative;
    cumulative.length = 0;
    let total = 0;
    for (let i = 0; i < n; i++) {
      if (i > 0) {
        total += Math.hypot(
          (path[i * 3] ?? 0) - (path[(i - 1) * 3] ?? 0),
          (path[i * 3 + 1] ?? 0) - (path[(i - 1) * 3 + 1] ?? 0),
          (path[i * 3 + 2] ?? 0) - (path[(i - 1) * 3 + 2] ?? 0),
        );
      }
      cumulative.push(total);
    }

    let used = 0;
    if (n >= 2) {
      for (let s = 0; s < total && used < this.dashes.length; s += DASH + GAP) {
        const dash = this.dashes[used];
        if (dash === undefined) break;
        this.pointAt(s, this.start);
        this.pointAt(Math.min(total, s + DASH), this.end);
        const length = this.start.distanceTo(this.end);
        if (length < 1e-4) continue;
        dash.position.addVectors(this.start, this.end).multiplyScalar(0.5);
        dash.scale.set(1, 1, length);
        dash.lookAt(this.end);
        dash.visible = true;
        used++;
      }
    }
    for (let i = used; i < this.dashes.length; i++) {
      const dash = this.dashes[i];
      if (dash !== undefined) dash.visible = false;
    }

    this.ring.visible = n >= 2;
    if (n >= 2) this.ring.position.set(path[(n - 1) * 3] ?? 0, (path[(n - 1) * 3 + 1] ?? 0) + 0.04, path[(n - 1) * 3 + 2] ?? 0);
  }

  /** The point `s` metres along the aim path. */
  private pointAt(s: number, out: Vector3): void {
    const path = this.fishing.path;
    const cumulative = this.cumulative;
    let i = 1;
    while (i < cumulative.length - 1 && (cumulative[i] ?? 0) < s) i++;
    const a = cumulative[i - 1] ?? 0;
    const b = cumulative[i] ?? a;
    const t = b > a ? Math.min(1, Math.max(0, (s - a) / (b - a))) : 0;
    const p = (i - 1) * 3;
    const q = i * 3;
    out.set(
      (path[p] ?? 0) + ((path[q] ?? 0) - (path[p] ?? 0)) * t,
      (path[p + 1] ?? 0) + ((path[q + 1] ?? 0) - (path[p + 1] ?? 0)) * t,
      (path[p + 2] ?? 0) + ((path[q + 2] ?? 0) - (path[p + 2] ?? 0)) * t,
    );
  }

  /** Hands the line's bulbs to the glow pool. Call between `bulbLights.begin` and `commit`. */
  offerLights(): void {
    this.chain.offerLights();
  }

  dispose(): void {
    this.scene.remove(this.chain.root, this.hook, this.ring, ...this.dashes);
  }
}
