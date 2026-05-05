export type StatusTone = "neutral" | "busy" | "positive" | "warning" | "negative";

const toneRing: Record<StatusTone, string> = {
  neutral: "ring-transparent",
  busy: "ring-transparent",
  positive: "ring-transparent",
  warning: "ring-transparent",
  negative: "ring-transparent",
};

const toneBorder: Record<StatusTone, string> = {
  neutral: "border-border",
  busy: "border-border",
  positive: "border-border",
  warning: "border-border",
  negative: "border-danger/45",
};

export type StatusBanner = {
  readonly element: HTMLDivElement;
  setText(text: string, tone?: StatusTone): void;
};

export function createStatusBanner(initial = "", tone: StatusTone = "neutral"): StatusBanner {
  const element = document.createElement("div");
  element.setAttribute("role", "status");
  element.setAttribute("aria-live", "polite");

  const inner = document.createElement("div");
  inner.className = "dp-status-content";

  element.append(inner);
  setElementText(initial, tone);

  function applyChrome(el: HTMLDivElement, t: StatusTone, hasText: boolean) {
    if (!hasText) {
      el.className = "hidden";
      return;
    }

    el.className = ["dp-status transition-[border-color,box-shadow] duration-200", toneBorder[t], toneRing[t]].join(" ");
  }

  function setElementText(text: string, nextTone: StatusTone) {
    const trimmed = text.trim();
    renderStatusContent(inner, trimmed);
    applyChrome(element, nextTone, trimmed.length > 0);
  }

  return {
    element,
    setText(text: string, nextTone: StatusTone = "neutral") {
      setElementText(text, nextTone);
    },
  };
}

function renderStatusContent(container: HTMLDivElement, text: string): void {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  container.replaceChildren();

  for (const [index, line] of lines.entries()) {
    const row = document.createElement("div");
    row.className =
      index === 0
        ? "dp-status-primary"
        : line.toLowerCase().startsWith("check")
          ? "dp-status-warning"
          : "dp-status-detail";
    row.textContent = line;
    container.append(row);
  }
}
