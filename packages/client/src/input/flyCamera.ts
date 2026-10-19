import type { PerspectiveCamera } from "three/webgpu";

/**
 * Free-flying debug camera.
 *
 * This is scaffolding, not a feature: it exists so M2's streaming can be
 * flown around and inspected before the real player controller lands at M4.
 * The look maths is deliberately identical to src/Player.cpp:51-64 --
 * degrees, 0.1 deg/pixel, pitch clamped to +-89, and the same
 * yaw/pitch-to-direction formula with X = cos(yaw)cos(pitch) -- so that when
 * the player controller is ported it inherits a look implementation already
 * confirmed to feel right, instead of two subtly different ones.
 *
 * Movement is not ported from anything. The player walks; this flies.
 */

/** Matches Player::mouseSensitivity. Degrees of rotation per pixel of motion. */
const SENSITIVITY_DEG_PER_PIXEL = 0.1;

const PITCH_LIMIT_DEG = 89;

const BASE_SPEED = 8;
const BOOST_MULTIPLIER = 5;
const DEG_TO_RAD = Math.PI / 180;

export class FlyCamera {
  /** Matches Player's initial yaw: -90 degrees faces down +Z... see direction(). */
  private yawDeg = -90;
  private pitchDeg = -20;

  private readonly keys = new Set<string>();

  /**
   * Mouse motion accumulated since the last update. Pointer-lock
   * mousemove events can fire several times per frame (and, with a
   * high-polling-rate mouse, many times), so deltas are summed rather than
   * applied immediately -- same reason the C++ accumulates in
   * cursorPosCallback (src/main.cpp:211).
   */
  private pendingDx = 0;
  private pendingDy = 0;

  private disposers: (() => void)[] = [];

  constructor(
    private readonly camera: PerspectiveCamera,
    private readonly canvas: HTMLCanvasElement,
  ) {}

  get locked(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  attach(): void {
    const onClick = (): void => {
      if (!this.locked) void this.canvas.requestPointerLock();
    };
    const onMouseMove = (event: MouseEvent): void => {
      if (!this.locked) return;
      this.pendingDx += event.movementX;
      // Screen Y grows downward; the C++ flips it in its cursor callback
      // before accumulating, so the sign is handled here to match.
      this.pendingDy -= event.movementY;
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      this.keys.add(event.code);
      // Space scrolls the page by default, which is visible even with a
      // full-viewport canvas and no scrollbar.
      if (event.code === "Space") event.preventDefault();
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      this.keys.delete(event.code);
    };
    // Releasing pointer lock (Esc) or losing focus (alt-tab) does not emit
    // keyup, so without this a key held at that moment stays stuck down and
    // the camera drifts forever.
    const onBlur = (): void => {
      this.keys.clear();
    };

    this.canvas.addEventListener("click", onClick);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    document.addEventListener("pointerlockchange", onBlur);

    this.disposers = [
      () => this.canvas.removeEventListener("click", onClick),
      () => window.removeEventListener("mousemove", onMouseMove),
      () => window.removeEventListener("keydown", onKeyDown),
      () => window.removeEventListener("keyup", onKeyUp),
      () => window.removeEventListener("blur", onBlur),
      () => document.removeEventListener("pointerlockchange", onBlur),
    ];
  }

  dispose(): void {
    for (const off of this.disposers) off();
    this.disposers = [];
  }

  /** @param dt clamped frame delta in seconds */
  update(dt: number): void {
    this.yawDeg += this.pendingDx * SENSITIVITY_DEG_PER_PIXEL;
    this.pitchDeg += this.pendingDy * SENSITIVITY_DEG_PER_PIXEL;
    this.pitchDeg = Math.min(PITCH_LIMIT_DEG, Math.max(-PITCH_LIMIT_DEG, this.pitchDeg));
    this.pendingDx = 0;
    this.pendingDy = 0;

    const yaw = this.yawDeg * DEG_TO_RAD;
    const pitch = this.pitchDeg * DEG_TO_RAD;
    const cosPitch = Math.cos(pitch);

    // src/Player.cpp:62-64, verbatim.
    const fx = Math.cos(yaw) * cosPitch;
    const fy = Math.sin(pitch);
    const fz = Math.sin(yaw) * cosPitch;

    // Right vector: forward x worldUp, with the Y term dropped since
    // worldUp is exactly +Y. Derived from the flat heading rather than from
    // `forward` so that strafing stays horizontal while looking up or down.
    const rx = Math.sin(yaw);
    const rz = -Math.cos(yaw);

    let mx = 0;
    let my = 0;
    let mz = 0;
    if (this.keys.has("KeyW")) {
      mx += fx;
      my += fy;
      mz += fz;
    }
    if (this.keys.has("KeyS")) {
      mx -= fx;
      my -= fy;
      mz -= fz;
    }
    if (this.keys.has("KeyD")) {
      mx += rx;
      mz += rz;
    }
    if (this.keys.has("KeyA")) {
      mx -= rx;
      mz -= rz;
    }
    if (this.keys.has("Space")) my += 1;
    if (this.keys.has("KeyC") || this.keys.has("ControlLeft")) my -= 1;

    const length = Math.hypot(mx, my, mz);
    if (length > 0) {
      // Normalise so that diagonal input is not sqrt(2) faster than
      // straight-ahead input.
      const speed =
        (BASE_SPEED * (this.keys.has("ShiftLeft") ? BOOST_MULTIPLIER : 1) * dt) / length;
      this.camera.position.x += mx * speed;
      this.camera.position.y += my * speed;
      this.camera.position.z += mz * speed;
    }

    const p = this.camera.position;
    this.camera.lookAt(p.x + fx, p.y + fy, p.z + fz);
  }
}
