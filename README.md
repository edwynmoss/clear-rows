# Clear Rows

Clear Rows is a local-first desktop app for opening large delimited files and searching across multiple CSV, TSV, and text exports without turning your laptop into a tiny smoke machine.

It is built for the very specific moment where a spreadsheet is too heavy, grep is too blunt, and you still need to find the row that matters.

## What It Does

- Opens large CSV-like files progressively, so the UI can show useful rows before indexing is complete.
- Detects CSV, TSV, plain text, semicolon-delimited CSVs, UTF-8 BOMs, and a few awkward-but-real export shapes.
- Searches across multiple selected files with a configurable result cap.
- Shows search hits in a real table view using the source file's columns, with the matching cell highlighted.
- Keeps everything local. No upload step, no service account, no mystery cloud box.

## Why It Exists

Clear Rows is for incident review, inventory exports, endpoint/app lists, asset dumps, and other "please find the thing in this giant file" work.

The design goal is simple: stay calm, stay fast, and do not make the user babysit a frozen grid.

## Stack

- Desktop shell: Tauri 2
- Frontend: TypeScript, Vite, Tailwind CSS v4
- Backend/parser: Rust
- Data model: local files only, streamed/progressive indexing

## Getting Started

```powershell
npm install
npm run tauri -- dev
```

Build the desktop app:

```powershell
npm run tauri -- build
```

Run the frontend-only build:

```powershell
npm run build
```

Run Rust tests:

```powershell
cd src-tauri
cargo test
```

## Sample Data

Use `samples/small.csv` for quick smoke testing.

Real CSV exports are intentionally ignored by git. If you need local fixtures, keep them at the project root or outside the repo. They will not be committed unless you deliberately change the ignore rules.

## Public Safety

This repo is prepared to be public:

- Root-level CSV exports are ignored.
- Local logs, screenshots, Playwright scratch files, build outputs, and env files are ignored.
- The app does not require secrets to run.
- The app reads local files through the desktop dialog and does not upload data.

See [docs/PUBLIC_SAFETY.md](docs/PUBLIC_SAFETY.md) for the quick release checklist.

## Docs Reference

- [Tauri 2 documentation](https://tauri.app/)
- [Vite guide](https://vite.dev/guide/)
- [Tailwind CSS documentation](https://tailwindcss.com/docs)
- [Rust book](https://doc.rust-lang.org/book/)
- [WAI-ARIA Authoring Practices](https://www.w3.org/WAI/ARIA/apg/)

## Status

Clear Rows is early, practical, and already useful. Expect sharp edges, but not mystery behavior. If something feels weird in the UI, it probably deserves to be simplified.

## License

MIT
