export type ExportButtonOptions = {
  onClick: () => void;
};

export type ExportButton = {
  readonly root: HTMLButtonElement;
  setEnabled(enabled: boolean): void;
  setBusy(busy: boolean): void;
};

export function createExportButton(options: ExportButtonOptions): ExportButton {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "dp-button dp-button-secondary";
  button.textContent = "Export…";
  button.disabled = true;
  button.title = "Export the current view (filtered + sorted) to a CSV file";

  button.addEventListener("click", () => {
    if (button.disabled) return;
    options.onClick();
  });

  return {
    root: button,
    setEnabled(enabled: boolean) {
      button.disabled = !enabled;
    },
    setBusy(busy: boolean) {
      button.disabled = busy;
      button.textContent = busy ? "Exporting…" : "Export…";
    },
  };
}
