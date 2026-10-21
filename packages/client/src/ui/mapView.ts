import { keyX, keyZ } from "@fgp/shared/sim/chunkKey";
import { MAP_PX_METERS, MAP_TILE_PX, type MapData } from "@fgp/shared/map/mapData";

/**
 * Screen pixels (CSS) per map pixel: where it starts, and how far in or out it
 * goes. Below 1 a screen pixel covers several map pixels; the floor is only
 * there so the number cannot reach zero.
 */
const ZOOM_MIN = 0.002;
const ZOOM_MAX = 24;
const ZOOM_START = 6;
/** Zoom change per wheel pixel; one 100px notch is about 15%. */
const ZOOM_PER_WHEEL = 0.0015;
/** How fast WASD pans, in screen pixels per second, at any zoom. */
const PAN_SCREEN_PX_PER_SECOND = 600;

/**
 * Draws a {@link MapData} centred on the player (or wherever WASD has panned
 * to), north (-Z) up.
 *
 * The visible window is composed into an offscreen buffer and then scaled up
 * with smoothing off, so each map pixel stays a crisp block at any zoom and the
 * per-frame cost depends on the panel size, not on how much has been explored.
 * Zoomed out past one map pixel per screen pixel the buffer samples every
 * `stride`th map pixel, which keeps it no bigger than the panel however far out
 * it goes.
 */
export class MapView {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly buffer = document.createElement("canvas");
  private readonly bufferCtx: CanvasRenderingContext2D;
  private image: ImageData | undefined;
  private zoom = ZOOM_START;
  /** Metres the view is panned away from the player. */
  private panX = 0;
  private panZ = 0;

  constructor(private readonly root: HTMLElement) {
    this.canvas = root.querySelector("canvas") as HTMLCanvasElement;
    this.ctx = this.canvas.getContext("2d") as CanvasRenderingContext2D;
    this.bufferCtx = this.buffer.getContext("2d") as CanvasRenderingContext2D;
  }

  get open(): boolean {
    return !this.root.hidden;
  }

  set open(value: boolean) {
    // Each time it opens, it opens on the player.
    if (value && this.root.hidden) {
      this.panX = 0;
      this.panZ = 0;
    }
    this.root.hidden = !value;
  }

  zoomBy(wheelDelta: number): void {
    this.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, this.zoom * Math.exp(-wheelDelta * ZOOM_PER_WHEEL)));
  }

  /** Pans by `dt` seconds of holding a direction (each of `x`, `z` is -1, 0 or 1; +z is south). */
  pan(x: number, z: number, dt: number): void {
    const metres = (PAN_SCREEN_PX_PER_SECOND / this.zoom) * MAP_PX_METERS * dt;
    this.panX += x * metres;
    this.panZ += z * metres;
  }

  /** Redraws. Position in metres; the arrow points along (frontX, frontZ). */
  render(map: MapData, x: number, z: number, frontX: number, frontZ: number): void {
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    const scale = this.zoom * dpr;
    const stride = Math.max(1, Math.floor(1 / scale));

    // The window in map pixels, and the stride-aligned buffer covering it: its
    // pixel i is the map pixel originX + i * stride.
    const centreX = (x + this.panX) / MAP_PX_METERS;
    const centreZ = (z + this.panZ) / MAP_PX_METERS;
    const viewW = width / scale;
    const viewH = height / scale;
    const left = centreX - viewW / 2;
    const top = centreZ - viewH / 2;
    const originX = Math.floor(left / stride) * stride;
    const originY = Math.floor(top / stride) * stride;
    const bufW = Math.ceil(viewW / stride) + 2;
    const bufH = Math.ceil(viewH / stride) + 2;

    if (this.image === undefined || this.image.width !== bufW || this.image.height !== bufH) {
      this.image = new ImageData(bufW, bufH);
      this.buffer.width = bufW;
      this.buffer.height = bufH;
    }
    const data = this.image.data;
    data.fill(0);

    const copyTile = (tx: number, tz: number, tile: Uint8ClampedArray): void => {
      // The tile's pixels that fall on the buffer's grid.
      const gx0 = tx * MAP_TILE_PX;
      const gy0 = tz * MAP_TILE_PX;
      const px0 = (((-gx0) % stride) + stride) % stride;
      const py0 = (((-gy0) % stride) + stride) % stride;
      for (let py = py0; py < MAP_TILE_PX; py += stride) {
        const by = (gy0 + py - originY) / stride;
        if (by < 0 || by >= bufH) continue;
        for (let px = px0; px < MAP_TILE_PX; px += stride) {
          const bx = (gx0 + px - originX) / stride;
          if (bx < 0 || bx >= bufW) continue;
          const s = (py * MAP_TILE_PX + px) * 4;
          const d = (by * bufW + bx) * 4;
          data[d] = tile[s] as number;
          data[d + 1] = tile[s + 1] as number;
          data[d + 2] = tile[s + 2] as number;
          data[d + 3] = tile[s + 3] as number;
        }
      }
    };

    const firstTileX = Math.floor(originX / MAP_TILE_PX);
    const lastTileX = Math.floor((originX + bufW * stride) / MAP_TILE_PX);
    const firstTileZ = Math.floor(originY / MAP_TILE_PX);
    const lastTileZ = Math.floor((originY + bufH * stride) / MAP_TILE_PX);
    const inView = (lastTileX - firstTileX + 1) * (lastTileZ - firstTileZ + 1);
    if (inView <= map.tiles.size) {
      for (let tz = firstTileZ; tz <= lastTileZ; tz++) {
        for (let tx = firstTileX; tx <= lastTileX; tx++) {
          const tile = map.tile(tx, tz);
          if (tile !== undefined) copyTile(tx, tz, tile);
        }
      }
    } else {
      // Zoomed far out: more tiles are in view than have been explored, so
      // walk the explored ones instead.
      for (const [key, tile] of map.tiles) {
        const tx = keyX(key);
        const tz = keyZ(key);
        if (tx < firstTileX || tx > lastTileX || tz < firstTileZ || tz > lastTileZ) continue;
        copyTile(tx, tz, tile);
      }
    }
    this.bufferCtx.putImageData(this.image, 0, 0);

    const ctx = this.ctx;
    ctx.fillStyle = "#0b0e13";
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      this.buffer,
      (originX - left) * scale,
      (originY - top) * scale,
      bufW * stride * scale,
      bufH * stride * scale,
    );

    // The player is where they are, which is the middle of the screen only until the view is panned.
    this.drawPlayer(
      width / 2 - (this.panX / MAP_PX_METERS) * scale,
      height / 2 - (this.panZ / MAP_PX_METERS) * scale,
      frontX,
      frontZ,
      dpr,
    );
    ctx.fillStyle = "#e8f0f7";
    ctx.font = `${String(12 * dpr)}px ui-monospace, Consolas, monospace`;
    ctx.textAlign = "center";
    ctx.fillText("N", width / 2, 16 * dpr);
    ctx.textAlign = "left";
    const cmPerPx = (MAP_PX_METERS / this.zoom) * 100;
    const scaleText = cmPerPx >= 1000 ? `${(cmPerPx / 100).toFixed(0)}m/px` : `${cmPerPx.toFixed(0)}cm/px`;
    ctx.fillText(`${scaleText}  WASD to pan  scroll to zoom  M to close`, 8 * dpr, height - 8 * dpr);
  }

  private drawPlayer(cx: number, cy: number, frontX: number, frontZ: number, dpr: number): void {
    const len = Math.max(1e-3, Math.hypot(frontX, frontZ));
    const fx = frontX / len;
    const fz = frontZ / len;
    const size = 7 * dpr;
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(cx + fx * size * 1.4, cy + fz * size * 1.4);
    ctx.lineTo(cx - fx * size + fz * size * 0.8, cy - fz * size - fx * size * 0.8);
    ctx.lineTo(cx - fx * size * 0.4, cy - fz * size * 0.4);
    ctx.lineTo(cx - fx * size - fz * size * 0.8, cy - fz * size + fx * size * 0.8);
    ctx.closePath();
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 1.5 * dpr;
    ctx.fill();
    ctx.stroke();
  }
}
