export type ProgressStrip = {
  readonly element: HTMLDivElement;
  /** ratio in [0,1], or null to hide. */
  setProgress(ratio: number | null): void;
};

export function createProgressStrip(): ProgressStrip {
  const element = document.createElement("div");
  element.className = "dp-progress-strip";
  element.setAttribute("aria-hidden", "true");
  element.dataset.state = "idle";

  const fill = document.createElement("div");
  fill.className = "dp-progress-strip-fill";
  fill.style.width = "0%";
  element.append(fill);

  return {
    element,
    setProgress(ratio: number | null) {
      if (ratio === null || !Number.isFinite(ratio)) {
        element.dataset.state = "idle";
        fill.style.width = "0%";
        return;
      }

      const clamped = Math.min(1, Math.max(0, ratio));
      element.dataset.state = clamped >= 1 ? "complete" : "active";
      fill.style.width = `${(clamped * 100).toFixed(2)}%`;
    },
  };
}
