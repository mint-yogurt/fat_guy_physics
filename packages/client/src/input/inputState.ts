/**
 * Keyboard, mouse and pointer-lock state.
 *
 * Replaces the GLFW callbacks in src/main.cpp. Two things it keeps from
 * there, both load-bearing:
 *
 *  - Mouse motion is *accumulated* rather than applied on arrival. Pointer
 *    lock delivers several mousemove events per frame (many more with a
 *    high-polling-rate mouse), and the C++ sums them in cursorPosCallback
 *    for the same reason.
 *  - Discrete actions are edge-triggered and consumed. The physics loop runs
 *    up to 8 substeps per frame, so a level-triggered "jump is down" flag
 *    would fire the jump impulse several times from one keypress, and a
 *    level-triggered mode toggle would flip back and forth within a single
 *    frame and appear to do nothing.
 */
export class InputState {
  private readonly keys = new Set<string>();
  private readonly buttons = new Set<number>();
  private readonly pressedThisFrame = new Set<string>();

  /** Accumulated pointer-lock motion since the last consumeMouse(). */
  private pendingDx = 0;
  private pendingDy = 0;

  /** Set when pointer lock was refused, so the HUD can say why. */
  lockError: string | undefined;

  private disposers: (() => void)[] = [];

  constructor(private readonly canvas: HTMLCanvasElement) {}

  get locked(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  isDown(code: string): boolean {
    return this.keys.has(code);
  }

  /** Level-triggered: digging is a hold-to-repeat action on its own timer. */
  isMouseDown(button: number): boolean {
    return this.buttons.has(button);
  }

  /** True once per physical keypress, cleared by {@link endFrame}. */
  wasPressed(code: string): boolean {
    return this.pressedThisFrame.has(code);
  }

  attach(): void {
    const onClick = (): void => {
      if (this.locked) return;
      // requestPointerLock returns a promise that genuinely rejects: in a
      // cross-origin iframe without allow="pointer-lock", and when the user
      // clicks again during the browser's cooldown after an Esc. An uncaught
      // rejection spams the console on every click, so it is recorded for
      // the HUD instead -- "the game will not capture my mouse" needs to
      // show up somewhere the player can see it.
      void this.canvas.requestPointerLock()?.catch((err: unknown) => {
        this.lockError = err instanceof Error ? err.message : String(err);
      });
    };
    const onMouseDown = (event: MouseEvent): void => {
      // Only while captured. The click that *takes* the lock must not also
      // count as a dig -- it was aimed at the window, not at terrain.
      if (this.locked) this.buttons.add(event.button);
    };
    const onMouseUp = (event: MouseEvent): void => {
      this.buttons.delete(event.button);
    };
    const onContextMenu = (event: MouseEvent): void => {
      // Right-click is chup (M6); the browser menu would swallow it.
      if (this.locked) event.preventDefault();
    };
    const onMouseMove = (event: MouseEvent): void => {
      if (!this.locked) return;
      this.pendingDx += event.movementX;
      // Screen Y grows downward; the C++ flips it in its cursor callback
      // before accumulating, so the sign is handled here to match.
      this.pendingDy -= event.movementY;
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      // Ignore auto-repeat: a held key must not re-fire edge-triggered
      // actions at the OS repeat rate.
      if (!event.repeat) this.pressedThisFrame.add(event.code);
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
    // the player walks off on their own forever.
    const onBlur = (): void => {
      this.keys.clear();
      this.buttons.clear();
      this.pendingDx = 0;
      this.pendingDy = 0;
    };
    const onLockChange = (): void => {
      onBlur();
      // A lock that succeeded clears any earlier refusal, so the HUD does
      // not keep showing a stale error after the problem went away.
      if (this.locked) this.lockError = undefined;
    };

    this.canvas.addEventListener("click", onClick);
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("contextmenu", onContextMenu);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    document.addEventListener("pointerlockchange", onLockChange);

    this.disposers = [
      () => this.canvas.removeEventListener("click", onClick),
      () => window.removeEventListener("mousedown", onMouseDown),
      () => window.removeEventListener("mouseup", onMouseUp),
      () => window.removeEventListener("contextmenu", onContextMenu),
      () => window.removeEventListener("mousemove", onMouseMove),
      () => window.removeEventListener("keydown", onKeyDown),
      () => window.removeEventListener("keyup", onKeyUp),
      () => window.removeEventListener("blur", onBlur),
      () => document.removeEventListener("pointerlockchange", onLockChange),
    ];
  }

  dispose(): void {
    for (const off of this.disposers) off();
    this.disposers = [];
  }

  /** Returns accumulated mouse X motion and clears it. */
  consumeMouseX(): number {
    const dx = this.pendingDx;
    this.pendingDx = 0;
    return dx;
  }

  /** Returns accumulated mouse Y motion and clears it. Already Y-up. */
  consumeMouseY(): number {
    const dy = this.pendingDy;
    this.pendingDy = 0;
    return dy;
  }

  /** Call at the end of every rendered frame. */
  endFrame(): void {
    this.pressedThisFrame.clear();
  }
}
