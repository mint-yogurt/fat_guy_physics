/**
 * A graphic that pops up in the middle of the screen when a trick is landed:
 * springs in with a little overshoot, hangs, fades. Styled inline (and animated
 * with the Web Animations API) so it needs nothing from the stylesheet.
 */

/** Native size of skateboard_sick.png, scaled down to 70% of 3x. */
const SCALE = 2.1;
const TOTAL_MS = 750;

export class TrickBanner {
  private readonly image: HTMLImageElement;
  private animation: Animation | undefined;

  constructor(host: HTMLElement, src: string) {
    const image = document.createElement("img");
    image.src = src;
    image.alt = "";
    image.hidden = true;
    image.draggable = false;
    image.style.cssText = [
      "position:absolute",
      "left:50%",
      "top:40%",
      "pointer-events:none",
      "image-rendering:pixelated",
      "user-select:none",
    ].join(";");
    host.append(image);
    this.image = image;
  }

  /** Takes it away at once, mid-animation or not. */
  hide(): void {
    if (this.image.hidden) return;
    this.animation?.cancel();
    this.image.hidden = true;
  }

  /** Shows it from the start, even if it is already showing. */
  show(): void {
    const { image } = this;
    this.animation?.cancel();
    image.hidden = false;
    if (image.naturalWidth > 0) image.style.width = `${image.naturalWidth * SCALE}px`;
    const place = "translate(-50%, -50%)";
    this.animation = image.animate(
      [
        { opacity: 0, transform: `${place} scale(0.3) rotate(-10deg)`, offset: 0 },
        { opacity: 1, transform: `${place} scale(1.18) rotate(-3deg)`, offset: 0.1 },
        { opacity: 1, transform: `${place} scale(1) rotate(-4deg)`, offset: 0.16 },
        { opacity: 1, transform: `${place} scale(1.04) rotate(-4deg)`, offset: 0.75 },
        { opacity: 0, transform: `${place} scale(1.1) rotate(-4deg)`, offset: 1 },
      ],
      { duration: TOTAL_MS, easing: "ease-out" },
    );
    this.animation.onfinish = () => {
      image.hidden = true;
    };
  }
}
