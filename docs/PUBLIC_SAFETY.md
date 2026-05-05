# Public Safety Checklist

Use this before pushing or cutting a public release.

## Data

- Do not commit real customer, endpoint, asset, or incident exports.
- Root-level `*.csv` files are ignored by default.
- Keep only small, synthetic examples under `samples/`.

## Secrets

- Do not commit `.env` or `.env.*` files.
- Do not paste tokens into docs, screenshots, tests, or config.
- Run a quick secret scan before publishing:

```powershell
rg -n -i "(api[_-]?key|secret|token|password|private[_-]?key|bearer|authorization)" .
```

## Generated Files

These stay local:

- `node_modules/`
- `dist/`
- `src-tauri/target/`
- `src-tauri/gen/`
- `output/`
- `.playwright-cli/`
- Vite process files and logs

## App Behavior

- Clear Rows reads local files only.
- File opening uses the Tauri dialog permission.
- Search and indexing happen locally in the desktop process.
- No network service is required for normal app use.

## Pre-Push Check

```powershell
npx tsc --noEmit
npm run build
cd src-tauri
cargo test
```
