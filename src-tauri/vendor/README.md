# GLib security backport

`glib/` is the published `glib 0.18.5` crate with the upstream fix for
[RUSTSEC-2024-0429 / GHSA-wrw7-89jp-8q8g](https://rustsec.org/advisories/RUSTSEC-2024-0429.html).

## Provenance and changes

- Source: <https://crates.io/api/v1/crates/glib/0.18.5/download>
- Archive SHA-256: `233daaf6e83ae6a12a52055f568f9d7cf4671dabb78ff9560ab6da230ce00ee5`.
- Upstream revision: `42b9caf98e03ded086362d9653ca58fe94dc8658` (recorded in
  `glib/.cargo_vcs_info.json`).
- Fix: [gtk-rs-core PR #1343](https://github.com/gtk-rs/gtk-rs-core/pull/1343),
  merged as `05dff0ee696f9bcd8617cd48c4b812d046d440cb`.
- Only `src/variant_iter.rs` is changed from the published source: the output
  pointer is mutable, and `g_variant_get_child` receives `&mut p` instead of `&p`.
- `glib/Cargo.lock` pins the standalone upstream test dependencies. It does not
  replace the application's `src-tauri/Cargo.lock`.
- The upstream MIT licence, copyright, source, tests and metadata are retained.
  The crate version stays 0.18.5; this is not an upstream 0.20 release.

## Why this is local

Tauri 2's Linux GTK3 stack requires `glib ^0.18`. Adding a direct dependency on
0.20 would leave the vulnerable transitive crate in use. The upstream maintainers
have [declined another 0.18 release](https://github.com/gtk-rs/gtk-rs-core/issues/2010).
Migrating the application to an alpha framework release is outside this bounded fix.

The root Cargo patch makes the existing GTK3 consumers share this corrected copy.
No registry cache is modified, no new third-party fork is trusted, and no advisory
ignore or fabricated version is used to hide the finding. Version-only scanners
may still flag 0.18.5; source remediation and the provider's alert state must be
reported separately.

## Validation and maintenance

On Linux with `libglib2.0-dev` and `pkg-config` installed:

```sh
node scripts/verify-glib-source.mjs
cargo test --manifest-path src-tauri/vendor/glib/Cargo.toml --locked --release --lib variant_iter
```

The source check verifies that the Linux application resolves this copy, with no
second registry version. The upstream iterator tests exercise forward and reverse
iteration. Release optimisation is required to expose the original undefined
behaviour. Both CI and the release workflow run these checks; packaging depends on
their success.

Keep further changes to this crate explicit and auditable. When a supported Tauri
stack resolves GLib 0.20 or newer, remove the Cargo patch, vendored crate, source
check and standalone security job together. Verify the complete Linux dependency
tree and runtime before retiring the backport.
