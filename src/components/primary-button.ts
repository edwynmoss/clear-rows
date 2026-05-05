export type ButtonVariant = "primary" | "ghost";

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    "dp-button dp-button-primary min-w-[7.5rem]",
  ghost:
    "dp-button dp-button-secondary",
};

export type PrimaryButtonOptions = {
  label: string;
  variant?: ButtonVariant;
  disabled?: boolean;
  onClick?: () => void;
};

export function createButton(options: PrimaryButtonOptions): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = options.label;
  btn.className = variantClasses[options.variant ?? "primary"];

  if (options.disabled) {
    btn.disabled = true;
  }

  if (options.onClick) {
    btn.addEventListener("click", options.onClick);
  }

  return btn;
}
