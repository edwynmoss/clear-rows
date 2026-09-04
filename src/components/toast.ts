export type ToastTone = "neutral" | "positive" | "warning" | "negative";

export type ToastOptions = {
  title: string;
  detail?: string;
  tone?: ToastTone;
  /** Milliseconds before auto-dismiss. 0 keeps it until dismissed. */
  duration?: number;
  action?: { label: string; onClick: () => void };
};

export type ToastHost = {
  readonly root: HTMLDivElement;
  show(options: ToastOptions): () => void;
  clear(): void;
};

export function createToastHost(): ToastHost {
  const root = document.createElement("div");
  root.className = "cr-toasts";
  root.setAttribute("aria-live", "polite");

  return {
    root,
    show(options) {
      const toast = document.createElement("div");
      toast.className = "cr-toast";
      toast.dataset.tone = options.tone ?? "neutral";
      toast.role = "status";

      const body = document.createElement("div");
      body.className = "cr-toast-body";

      const title = document.createElement("div");
      title.className = "cr-toast-title";
      title.textContent = options.title;
      body.append(title);

      if (options.detail) {
        const detail = document.createElement("div");
        detail.className = "cr-toast-detail";
        detail.textContent = options.detail;
        body.append(detail);
      }

      toast.append(body);

      if (options.action) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "cr-toast-action";
        button.textContent = options.action.label;
        button.addEventListener("click", () => {
          options.action?.onClick();
          dismiss();
        });
        toast.append(button);
      }

      const close = document.createElement("button");
      close.type = "button";
      close.className = "cr-toast-close";
      close.setAttribute("aria-label", "Dismiss");
      close.textContent = "×";
      close.addEventListener("click", dismiss);
      toast.append(close);

      root.append(toast);
      requestAnimationFrame(() => toast.classList.add("is-visible"));

      let timer = 0;
      const duration = options.duration ?? (options.tone === "negative" ? 0 : 5000);
      if (duration > 0) {
        timer = window.setTimeout(dismiss, duration);
      }

      function dismiss(): void {
        if (timer) window.clearTimeout(timer);
        toast.classList.remove("is-visible");
        window.setTimeout(() => toast.remove(), 180);
      }

      return dismiss;
    },
    clear() {
      root.replaceChildren();
    },
  };
}
