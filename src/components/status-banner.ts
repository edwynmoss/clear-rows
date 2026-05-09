export type StatusTone = "neutral" | "busy" | "positive" | "warning" | "negative";

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
      el.removeAttribute("data-tone");
      return;
    }

    el.className = "dp-status transition-[border-color,background-color,box-shadow] duration-200";
    el.dataset.tone = t;
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
