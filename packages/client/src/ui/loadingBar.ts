/**
 * The LOADING... bar (`#loading` in index.html). It is in the page's own HTML so it is on
 * screen while the script bundle is still downloading; that stretch has no countable steps
 * and shows a sliding bar. After Play, `set` fills it as the game's assets load.
 */
export class LoadingBar {
  private readonly fill: HTMLElement;
  private readonly label: HTMLElement;

  constructor(private readonly root: HTMLElement) {
    this.fill = this.query("#loading-fill");
    this.label = this.query("#loading-label");
  }

  /** Shows the bar empty and counting, for work that can be measured. */
  begin(): void {
    this.root.classList.remove("indeterminate");
    this.label.textContent = "LOADING...";
    this.set(0);
    this.root.hidden = false;
  }

  /** `fraction` is 0..1. */
  set(fraction: number): void {
    this.fill.style.width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
  }

  hide(): void {
    this.root.hidden = true;
  }

  /** Replaces the bar's text with what went wrong, so a failed start is not a bar stuck forever. */
  fail(message: string): void {
    this.root.classList.remove("indeterminate");
    this.label.textContent = message;
    this.root.hidden = false;
  }

  private query(selector: string): HTMLElement {
    const element = this.root.querySelector<HTMLElement>(selector);
    if (element === null) throw new Error(`loading bar: missing ${selector}`);
    return element;
  }
}
