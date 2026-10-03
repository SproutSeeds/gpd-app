# Third-party license summary

Regenerated 2026-10-03 from `bun.lock` + `packages/desktop/src-tauri/Cargo.lock`.
Do not hand-edit — run `scripts/licenses/regen.sh` and commit the diff.

Deduplicated roll-up of every license string that appears on a dependency
shipped inside the GPD Desktop binary. Compound SPDX expressions like
`A OR B` are NOT split — they represent a single upstream license that the
consumer picks from. Per-package detail + full license texts live in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

**Totals:** 825 npm packages · 683 Rust crates · 43 distinct license strings · 1508 total package entries.

## Licenses in use

| License | npm | Rust | Total |
|---|---:|---:|---:|
| `MIT` | 555 | 178 | 733 |
| `Apache-2.0 OR MIT` | 1 | 394 | 395 |
| `Apache-2.0` | 136 | 5 | 141 |
| `ISC` | 72 | 3 | 75 |
| `Apache-2.0 OR MIT OR Zlib` |  | 29 | 29 |
| `BSD-3-Clause` | 21 | 5 | 26 |
| `Unicode-3.0` |  | 18 | 18 |
| `MIT OR Apache-2.0` | 12 |  | 12 |
| `BlueOak-1.0.0` | 10 |  | 10 |
| `BSD-2-Clause` | 7 | 2 | 9 |
| `MPL-2.0` |  | 8 | 8 |
| `MIT OR Unlicense` |  | 7 | 7 |
| `Apache-2.0 OR Apache-2.0 WITH LLVM-exception OR MIT` |  | 5 | 5 |
| `0BSD` | 1 | 3 | 4 |
| `Apache-2.0 OR BSD-2-Clause OR MIT` |  | 2 | 2 |
| `Apache-2.0 OR BSD-3-Clause` |  | 2 | 2 |
| `Apache-2.0 OR BSD-3-Clause OR MIT` |  | 2 | 2 |
| `Apache-2.0 OR ISC OR MIT` |  | 2 | 2 |
| `BSL-1.0` |  | 2 | 2 |
| `CC0-1.0` | 1 | 1 | 2 |
| `LICENSE` |  | 2 | 2 |
| `(AFL-2.1 OR BSD-3-Clause)` | 1 |  | 1 |
| `(Apache-2.0 OR MIT) AND BSD-3-Clause` |  | 1 | 1 |
| `(Apache-2.0 OR MIT) AND Unicode-3.0` |  | 1 | 1 |
| `(MIT AND Zlib)` | 1 |  | 1 |
| `(MIT OR CC0-1.0)` | 1 |  | 1 |
| `(MPL-2.0 OR Apache-2.0)` | 1 |  | 1 |
| `0BSD OR Apache-2.0 OR MIT` |  | 1 | 1 |
| `Apache-2.0 AND ISC` |  | 1 | 1 |
| `Apache-2.0 AND MIT` |  | 1 | 1 |
| `Apache-2.0 OR BSL-1.0` |  | 1 | 1 |
| `Apache-2.0 OR CC0-1.0 OR MIT-0` |  | 1 | 1 |
| `Apache-2.0 OR LGPL-2.1-or-later OR MIT` |  | 1 | 1 |
| `BSD-3-Clause AND MIT` |  | 1 | 1 |
| `BSD-3-Clause OR MIT` |  | 1 | 1 |
| `CC-BY-3.0` | 1 |  | 1 |
| `CC-BY-4.0` | 1 |  | 1 |
| `CDLA-Permissive-2.0` |  | 1 | 1 |
| `MIT (Bun) + LGPL-2.0 (statically-linked JavaScriptCore/WebKit)` | 1 |  | 1 |
| `MIT (inferred from LICENSE file)` | 1 |  | 1 |
| `SEE LICENSE IN README.md` | 1 |  | 1 |
| `UNKNOWN` |  | 1 | 1 |
| `Zlib` |  | 1 | 1 |

## Flagged licenses (copyleft / non-permissive, surfaced for review)

| Stack | Package | Version | License |
|---|---|---|---|
| cargo | `cssparser` | 0.29.6 | MPL-2.0 |
| cargo | `cssparser-macros` | 0.6.1 | MPL-2.0 |
| cargo | `dtoa-short` | 0.3.5 | MPL-2.0 |
| cargo | `freedesktop_entry_parser` | 1.3.0 | MPL-2.0 |
| cargo | `linicon` | 2.3.0 | MPL-2.0 |
| cargo | `linicon-theme` | 1.2.0 | MPL-2.0 |
| cargo | `option-ext` | 0.2.0 | MPL-2.0 |
| cargo | `r-efi` | 5.3.0 | Apache-2.0 OR LGPL-2.1-or-later OR MIT |
| cargo | `selectors` | 0.24.0 | MPL-2.0 |

## Runtime LGPL obligations (summary)

- **Bun** statically links JavaScriptCore/WebKit (LGPL-2) into the compiled
  `opencode-cli` sidecar → relink instructions in
  `THIRD_PARTY_NOTICES.md` § *Bun runtime + JavaScriptCore/WebKit*.
- **Linux builds** dynamically link WebKitGTK + GTK3 (LGPL-2.1-or-later)
  from the user's distro → dynamic-link compliance, library is
  user-replaceable via the package manager.
