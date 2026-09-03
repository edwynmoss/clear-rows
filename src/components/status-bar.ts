export type StatusTone = "neutral" | "busy" | "positive" | "warning" | "negative";

export type Activity = {
  /** Short verb phrase: "indexing", "filtering", "sorting", "exporting", "searching". */
  label: string;
  /** Progress ratio in [0,1], or null for indeterminate. */
  ratio: number | null;
  /** Detail after the label: "132,400 / 200,000 rows · 41 MB/s". */
  detail?: string;
  onCancel?: () => void;
};

export type StatusMeta = {
  position?: string;
  encoding?: string;
  delimiter?: string;
  version?: string;
};

export type StatusBar = {
  readonly root: HTMLElement;
  setActivity(activity: Activity | null): void;
  /** One-line note next to the activity: sort summary, last result, error. */
  setMessage(text: string, tone?: StatusTone): void;
  setMeta(meta: StatusMeta): void;
};

export function createStatusBar(): StatusBar {
  const root = document.createElement("footer");
  root.className = "cr-status";

  const live = document.createElement("div");
  live.className = "cr-status-live";
  live.hidden = true;

  const bar = document.createElement("div");
  bar.className = "cr-status-bar";
  const fill = document.createElement("i");
  bar.append(fill);

  const liveText = document.createElement("span");
  liveText.className = "cr-status-live-text";

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "cr-status-cancel";
  cancel.textContent = "Cancel";
  cancel.hidden = true;

  live.append(bar, liveText, cancel);

  const message = document.createElement("div");
  message.className = "cr-status-message";
  message.setAttribute("role", "status");
  message.setAttribute("aria-live", "polite");

  const meta = document.createElement("div");
  meta.className = "cr-status-meta";

  root.append(live, message, meta);

  let cancelHandler: (() => void) | null = null;
  cancel.addEventListener("click", () => cancelHandler?.());

  let currentMeta: StatusMeta = {};

  function renderMeta(): void {
    const parts = [currentMeta.position, currentMeta.encoding, currentMeta.delimiter, currentMeta.version]
      .filter((part): part is string => Boolean(part && part.length > 0));
    meta.replaceChildren();
    parts.forEach((part, index) => {
      if (index > 0) {
        const dot = document.createElement("span");
        dot.className = "cr-status-dot";
        dot.textContent = "·";
        meta.append(dot);
      }
      const span = document.createElement("span");
      span.textContent = part;
      meta.append(span);
    });
  }

  return {
    root,
    setActivity(activity) {
      if (!activity) {
        live.hidden = true;
        cancelHandler = null;
        return;
      }
      live.hidden = false;
      bar.dataset.indeterminate = activity.ratio === null ? "true" : "false";
      fill.style.width = activity.ratio === null ? "35%" : `${Math.round(Math.min(1, Math.max(0, activity.ratio)) * 100)}%`;
      liveText.replaceChildren();
      const label = document.createElement("span");
      label.className = "cr-status-live-label";
      label.textContent = activity.label;
      liveText.append(label);
      if (activity.detail) {
        const detail = document.createElement("span");
        detail.className = "cr-status-live-detail";
        detail.textContent = activity.detail;
        liveText.append(detail);
      }
      cancelHandler = activity.onCancel ?? null;
      cancel.hidden = cancelHandler === null;
    },
    setMessage(text, tone = "neutral") {
      message.textContent = text;
      message.dataset.tone = tone;
      message.hidden = text.length === 0;
    },
    setMeta(next) {
      currentMeta = { ...currentMeta, ...next };
      renderMeta();
    },
  };
}
