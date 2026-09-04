import { formatEncoding } from "../app/format";

export type ErrorCardOptions = {
  encodings: Array<{ label: string; value: string }>;
  onReopen: (encoding: string) => void;
  onDismiss: () => void;
  onOpenOther: () => void;
};

export type ErrorCardContent = {
  title: string;
  message: string;
  /** First data row as decoded, when we have one. */
  preview?: string | null;
  currentEncoding?: string | null;
  /** Show the encoding picker and Reopen action. */
  offerReopen: boolean;
  /** Offer "Keep as is" (file did open, this is a warning) vs "Open another file". */
  isWarning: boolean;
};

export type ErrorCard = {
  readonly root: HTMLElement;
  show(content: ErrorCardContent): void;
  hide(): void;
};

export function createErrorCard(options: ErrorCardOptions): ErrorCard {
  const root = document.createElement("div");
  root.className = "cr-errorwrap";
  root.hidden = true;

  const card = document.createElement("div");
  card.className = "cr-error";
  card.setAttribute("role", "alertdialog");

  const heading = document.createElement("h2");
  const icon = document.createElement("span");
  icon.className = "cr-error-icon";
  icon.textContent = "!";
  const headingText = document.createElement("span");
  heading.append(icon, headingText);

  const message = document.createElement("p");
  const preview = document.createElement("pre");
  preview.className = "cr-error-preview";

  const row = document.createElement("div");
  row.className = "cr-error-actions";

  const select = document.createElement("select");
  select.className = "cr-select";
  for (const option of options.encodings) {
    const el = document.createElement("option");
    el.value = option.value;
    el.textContent = option.label;
    select.append(el);
  }

  const reopen = document.createElement("button");
  reopen.type = "button";
  reopen.className = "cr-btn cr-btn-primary";
  reopen.textContent = "Reopen";
  reopen.addEventListener("click", () => options.onReopen(select.value));

  const secondary = document.createElement("button");
  secondary.type = "button";
  secondary.className = "cr-btn cr-btn-secondary";

  row.append(select, reopen, secondary);
  card.append(heading, message, preview, row);
  root.append(card);

  let isWarning = false;
  secondary.addEventListener("click", () => {
    if (isWarning) options.onDismiss();
    else options.onOpenOther();
  });

  return {
    root,
    show(content) {
      isWarning = content.isWarning;
      root.dataset.kind = content.isWarning ? "warning" : "error";
      headingText.textContent = content.title;
      message.textContent = content.message;
      preview.hidden = !content.preview;
      preview.textContent = content.preview ?? "";
      select.hidden = !content.offerReopen;
      reopen.hidden = !content.offerReopen;
      if (content.currentEncoding) {
        const match = options.encodings.find((e) => e.value === content.currentEncoding);
        select.value = match ? match.value : "windows-1252";
        if (!match) {
          const el = document.createElement("option");
          el.value = content.currentEncoding;
          el.textContent = formatEncoding(content.currentEncoding);
          select.prepend(el);
          select.value = content.currentEncoding;
        }
      } else {
        select.value = "windows-1252";
      }
      secondary.textContent = content.isWarning ? "Keep as is" : "Open another file";
      root.hidden = false;
    },
    hide() {
      root.hidden = true;
    },
  };
}
