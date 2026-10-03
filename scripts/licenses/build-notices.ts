#!/usr/bin/env bun
/**
 * Build THIRD_PARTY_NOTICES.md from bun.lock + Cargo.lock.
 *
 * Why not license-checker: it walks node_modules top-down. Bun hoists every
 * resolved package into `node_modules/.bun/<name>@<ver>/node_modules/...`,
 * so a `--production` walk from a workspace leaf sees only what's directly
 * symlinked into that workspace's private node_modules — 160ish entries,
 * missing the vast transitive closure. Parsing bun.lock gives us the full
 * resolved set.
 *
 * Shipping-subset rule:
 *   Roots = production dependencies of these workspaces:
 *     @opencode-ai/app, @opencode-ai/ui, opencode, @opencode-ai/desktop.
 *   Walk the transitive closure of `dependencies` (not dev/peer/optional).
 *   Follow `workspace:*` links recursively.
 *
 * License text: read `license` field from resolved package.json; look for
 * LICENSE / LICENSE.md / LICENCE / etc. in the resolved node_modules dir.
 * For Apache-2.0 also capture NOTICE.
 *
 * Rust side: consumed from /tmp/gpd-notices/cargo.json, produced by
 *   cargo license --json --avoid-build-deps --avoid-dev-deps
 * (see scripts/licenses/regen.sh).
 *
 * Emits: <repo-root>/THIRD_PARTY_NOTICES.md.
 */
import fs from "fs/promises"
import fsSync from "fs"
import path from "path"

const ROOT = path.resolve(import.meta.dir, "..", "..")
const BUN_LOCK = path.join(ROOT, "bun.lock")
const CARGO_JSON = "/tmp/gpd-notices/cargo.json"

const SHIPPING_WORKSPACES = new Set<string>([
  "opencode",
  "@opencode-ai/app",
  "@opencode-ai/ui",
  "@opencode-ai/desktop",
])

type PkgEntry = { name: string; version: string; deps: Record<string, string> }
type ResolvedPkg = {
  name: string
  version: string
  license: string
  repository?: string
  author?: string
  description?: string
  licenseText: string
  noticeText: string
}

function parsePackageKey(entry: unknown[]): { name: string; version: string } {
  const header = (entry[0] as string) ?? ""
  const atIdx = header.lastIndexOf("@")
  if (atIdx <= 0) return { name: header, version: "" }
  return { name: header.slice(0, atIdx), version: header.slice(atIdx + 1) }
}

async function readFirstFile(dir: string, candidates: string[]): Promise<string> {
  for (const n of candidates) {
    try {
      const t = await fs.readFile(path.join(dir, n), "utf8")
      return t.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim()
    } catch {}
  }
  return ""
}

const BUN_ROOT = path.join(ROOT, "node_modules", ".bun")
const bunDirCache: Map<string, string | null> = new Map()

function resolveBunPath(name: string, version: string): string | null {
  const cacheKey = `${name}@${version}`
  if (bunDirCache.has(cacheKey)) return bunDirCache.get(cacheKey)!
  const keyName = name.replace("/", "+")
  // Bun dirs: `<name>+<ver>` OR `<name>+<ver>+<hash>` (patches/overrides).
  // Try exact first, then a starts-with scan.
  const exact = path.join(BUN_ROOT, `${keyName}@${version}`, "node_modules", name)
  try {
    fsSync.accessSync(exact)
    bunDirCache.set(cacheKey, exact)
    return exact
  } catch {}
  const prefix = `${keyName}@${version}`
  try {
    const entries = fsSync.readdirSync(BUN_ROOT)
    for (const entry of entries) {
      if (entry === prefix || entry.startsWith(prefix + "+")) {
        const p = path.join(BUN_ROOT, entry, "node_modules", name)
        try {
          fsSync.accessSync(p)
          bunDirCache.set(cacheKey, p)
          return p
        } catch {}
      }
    }
  } catch {}
  bunDirCache.set(cacheKey, null)
  return null
}

async function resolvePkgJson(nmPath: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(nmPath, "package.json"), "utf8"))
  } catch {
    return null
  }
}

function normalizeLicense(pkg: Record<string, unknown>): string {
  const lic = pkg.license
  if (typeof lic === "string") return lic
  if (lic && typeof lic === "object" && "type" in lic) return (lic as { type: string }).type
  const licenses = pkg.licenses as unknown
  if (Array.isArray(licenses)) {
    const joined = licenses
      .map((l) => (typeof l === "string" ? l : (l as { type?: string })?.type ?? ""))
      .filter(Boolean)
      .join(" OR ")
    if (joined) return joined
  }
  return "UNKNOWN"
}

/**
 * When package.json has no `license` / `licenses`, fall back to sniffing the
 * LICENSE file's header for a recognizable SPDX-ish token. Cheap and correct
 * for the 80%+ case (MIT / Apache / BSD / ISC). Returns "UNKNOWN" on miss.
 */
function inferLicenseFromText(text: string): string {
  if (!text) return "UNKNOWN"
  const head = text.slice(0, 400).toLowerCase()
  if (/\bmit license\b/.test(head) || /\bthe mit license\b/.test(head)) return "MIT (inferred from LICENSE file)"
  if (/apache license[^\w]+version\s*2/.test(head)) return "Apache-2.0 (inferred from LICENSE file)"
  if (/\bbsd 2-clause\b/.test(head) || /\bthe 2-clause bsd license\b/.test(head)) return "BSD-2-Clause (inferred)"
  if (/\bbsd 3-clause\b/.test(head) || /\bthe 3-clause bsd license\b/.test(head)) return "BSD-3-Clause (inferred)"
  if (/\bisc license\b/.test(head)) return "ISC (inferred)"
  if (/\bmozilla public license[^\w]+version\s*2/.test(head)) return "MPL-2.0 (inferred)"
  if (/\bthe unlicense\b/.test(head)) return "Unlicense (inferred)"
  if (/\bcreative commons/.test(head)) return "CC (inferred — see text)"
  if (/\b(gpl|lgpl|agpl)\b/i.test(head)) return "GPL-family (inferred — needs review)"
  return "LICENSE file present — license not machine-identifiable"
}

function extractRepo(pkg: Record<string, unknown>): string | undefined {
  const r = pkg.repository
  if (typeof r === "string") return r
  if (r && typeof r === "object" && "url" in r)
    return (r as { url: string }).url.replace(/^git\+/, "").replace(/\.git$/, "")
  return undefined
}

function extractAuthor(pkg: Record<string, unknown>): string | undefined {
  const a = pkg.author
  if (typeof a === "string") return a
  if (a && typeof a === "object" && "name" in a) return (a as { name: string }).name
  return undefined
}

function findVersion(index: Map<string, PkgEntry>, name: string): { name: string; version: string } | null {
  const direct = index.get(name)
  if (direct) return { name, version: direct.version }
  for (const [key, e] of index) {
    if (key.startsWith(name + "@")) return { name, version: e.version }
  }
  return null
}

/**
 * Manual overrides for packages whose license is not machine-discoverable
 * (no `license` field in package.json, no LICENSE file with a parseable
 * header). Verified against the upstream repo / npm registry at audit time.
 * If an override becomes wrong after upstream changes, build-notices.ts
 * diff will catch it on the next run because the `license` in the
 * generated MD will stay fixed while the lockfile moves.
 */
const MANUAL_OVERRIDES: Record<string, { license: string; source: string }> = {
  "@openauthjs/openauth": {
    license: "MIT",
    source: "https://github.com/openauthjs/openauth/blob/master/LICENSE",
  },
  "poe-oauth": {
    license: "MIT",
    source: "https://www.npmjs.com/package/poe-oauth",
  },
  "ghostty-web": {
    license: "MIT",
    source: "https://github.com/anomalyco/ghostty-web",
  },
}

async function walk(): Promise<{ pkgs: Map<string, ResolvedPkg>; stats: Record<string, number> }> {
  // bun.lock is JSONC-ish (trailing commas). Bun's own import-loader parses it.
  const lock = (await import(BUN_LOCK)).default as {
    workspaces: Record<
      string,
      { name?: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }
    >
    packages: Record<string, unknown[]>
  }

  const wsByName = new Map<string, (typeof lock.workspaces)[string]>()
  for (const ws of Object.values(lock.workspaces)) {
    if (ws.name) wsByName.set(ws.name, ws)
  }

  const packagesByKey = new Map<string, PkgEntry>()
  for (const [k, v] of Object.entries(lock.packages)) {
    const { name, version } = parsePackageKey(v)
    const opts = (v[2] ?? {}) as Record<string, unknown>
    const deps = (opts.dependencies ?? {}) as Record<string, string>
    packagesByKey.set(`${name}@${version}`, { name, version, deps })
    if (!packagesByKey.has(name)) packagesByKey.set(name, { name, version, deps })
  }

  const visited = new Set<string>()
  const pkgs = new Map<string, ResolvedPkg>()
  const queue: Array<{ name: string; version: string; fromWorkspace?: boolean }> = []

  for (const wsName of SHIPPING_WORKSPACES) {
    const ws = wsByName.get(wsName)
    if (!ws) {
      console.warn(`[notices] shipping workspace not found in lockfile: ${wsName}`)
      continue
    }
    for (const [depName, constraint] of Object.entries(ws.dependencies ?? {})) {
      if (constraint.startsWith("workspace:")) {
        // Recurse into the workspace's deps
        const childWs = wsByName.get(depName)
        if (childWs) {
          for (const innerName of Object.keys(childWs.dependencies ?? {})) {
            const r = findVersion(packagesByKey, innerName)
            if (r) queue.push(r)
          }
        }
        continue
      }
      const resolved = findVersion(packagesByKey, depName)
      if (resolved) queue.push(resolved)
    }
  }

  // Bun itself — carries LGPL-2 JSC/WebKit via bun build --compile.
  pkgs.set("bun@static-link", {
    name: "bun (runtime, statically linked into opencode sidecar)",
    version: "",
    license: "MIT (Bun) + LGPL-2.0 (statically-linked JavaScriptCore/WebKit)",
    repository: "https://github.com/oven-sh/bun",
    author: "Oven",
    description:
      "Bun runtime. `bun build --compile` statically links JavaScriptCore + WebKit into the sidecar binary. Per Bun's own LICENSE.md, JSC/WebKit are LGPL-2-licensed and users are entitled to relink the binary against a modified build.",
    licenseText:
      "Bun itself is MIT — https://github.com/oven-sh/bun/blob/main/LICENSE.md.\n\nThe statically-linked JavaScriptCore/WebKit is LGPL-2. Modified source for Bun's WebKit fork is available at https://github.com/oven-sh/webkit. To relink the sidecar with a different JSC/WebKit, rebuild Bun from source against your replacement and re-run `bun build --compile` on `packages/opencode`.\n\nLGPL-2 full text: https://www.gnu.org/licenses/old-licenses/lgpl-2.0.en.html",
    noticeText: "",
  })

  while (queue.length) {
    const next = queue.shift()!
    const key = `${next.name}@${next.version}`
    if (visited.has(key)) continue
    visited.add(key)

    // Skip workspace: packages — they're our own code, covered by the root
    // LICENSE, and not third-party in any meaningful sense.
    if (next.version.startsWith("workspace:")) {
      continue
    }

    const nmPath = resolveBunPath(next.name, next.version)
    const pkgJson = nmPath ? await resolvePkgJson(nmPath) : null
    if (!pkgJson) {
      const override = MANUAL_OVERRIDES[next.name]
      pkgs.set(key, {
        name: next.name,
        version: next.version,
        license: override
          ? `${override.license} (manual override; source: ${override.source})`
          : "UNKNOWN",
        licenseText: "",
        noticeText: "",
      })
      continue
    }
    let license = normalizeLicense(pkgJson)
    const licenseText = await readFirstFile(nmPath!, [
      "LICENSE",
      "LICENSE.md",
      "LICENSE.txt",
      "LICENCE",
      "LICENCE.md",
      "LICENCE.txt",
      "license",
      "license.md",
    ])
    const noticeText = await readFirstFile(nmPath!, ["NOTICE", "NOTICE.md", "NOTICE.txt"])
    if (license === "UNKNOWN") license = inferLicenseFromText(licenseText)
    const override = MANUAL_OVERRIDES[next.name]
    if (override && (license === "UNKNOWN" || license.startsWith("LICENSE file present"))) {
      license = `${override.license} (manual override; source: ${override.source})`
    }
    pkgs.set(key, {
      name: next.name,
      version: next.version,
      license,
      repository: extractRepo(pkgJson),
      author: extractAuthor(pkgJson),
      description: (pkgJson.description as string) ?? undefined,
      licenseText,
      noticeText,
    })
    const pkgEntry = packagesByKey.get(key) ?? packagesByKey.get(next.name)
    if (pkgEntry) {
      for (const depName of Object.keys(pkgEntry.deps ?? {})) {
        const resolved = findVersion(packagesByKey, depName)
        if (resolved) queue.push(resolved)
      }
    }
  }

  return {
    pkgs,
    stats: {
      total: pkgs.size,
      unknown: [...pkgs.values()].filter((p) => p.license === "UNKNOWN").length,
    },
  }
}

async function main() {
  const npm = await walk()
  const cargo = JSON.parse(await fs.readFile(CARGO_JSON, "utf8")) as Array<{
    name: string
    version: string
    authors?: string
    repository?: string
    license?: string
    license_file?: string
    description?: string
  }>

  const now = new Date().toISOString().slice(0, 10)

  // Roll up license counts across npm + cargo.
  // Strip the "(manual override; source: …)" suffix so matched-via-override
  // packages group with the canonical license. Normalize case so `apache-2.0`
  // merges with `Apache-2.0` instead of showing as two distinct buckets.
  function canonicalize(lic: string): string {
    const stripped = lic.replace(/\s*\(manual override; source:[^)]+\)\s*/g, "").trim()
    // Well-known SPDX-ish ids are PascalCase with digits (`MIT`, `Apache-2.0`,
    // `BSD-3-Clause`, `ISC`, `MPL-2.0`, …). Anything that looks that shape in
    // lowercase, title-case it. Leave compound strings ("A OR B") alone.
    if (/^[a-z0-9.-]+$/.test(stripped) && stripped !== stripped.toUpperCase()) {
      // Don't uppercase a whole thing; just normalize common-case offenders.
      if (stripped.toLowerCase() === "apache-2.0") return "Apache-2.0"
      if (stripped.toLowerCase() === "mit") return "MIT"
      if (stripped.toLowerCase() === "isc") return "ISC"
    }
    return stripped
  }
  const npmLicenseCounts = new Map<string, number>()
  for (const p of npm.pkgs.values()) {
    const lic = canonicalize(p.license)
    npmLicenseCounts.set(lic, (npmLicenseCounts.get(lic) ?? 0) + 1)
  }
  const cargoLicenseCounts = new Map<string, number>()
  for (const c of cargo) {
    const l = canonicalize(c.license ?? c.license_file ?? "UNKNOWN")
    cargoLicenseCounts.set(l, (cargoLicenseCounts.get(l) ?? 0) + 1)
  }

  // Combined, deduplicated: every distinct license + count from each stack + total.
  const allLicenses = new Set<string>([...npmLicenseCounts.keys(), ...cargoLicenseCounts.keys()])
  const combinedRows = [...allLicenses]
    .map((lic) => ({
      license: lic,
      npm: npmLicenseCounts.get(lic) ?? 0,
      cargo: cargoLicenseCounts.get(lic) ?? 0,
      total: (npmLicenseCounts.get(lic) ?? 0) + (cargoLicenseCounts.get(lic) ?? 0),
    }))
    .sort((a, b) => b.total - a.total || a.license.localeCompare(b.license))

  // Copyleft / non-permissive flags we care about surfacing at the top.
  const FLAG_RE = /^(MPL-|LGPL-|GPL-|AGPL-|SSPL-|EUPL-|OSL-|Apache-2\.0 OR LGPL)/
  const npmFlagged = [...npm.pkgs.values()].filter((p) => FLAG_RE.test(p.license))
  const cargoFlagged = cargo.filter((c) => FLAG_RE.test(c.license ?? ""))

  const out: string[] = []
  out.push(
    "# Third-party notices",
    "",
    `Regenerated ${now} from \`bun.lock\` + \`packages/desktop/src-tauri/Cargo.lock\`.`,
    "Do not hand-edit — run `scripts/licenses/regen.sh` and commit the diff.",
    "",
    "## Summary",
    "",
    `- **npm / Bun packages:** ${npm.stats.total} (UNKNOWN: ${npm.stats.unknown})`,
    `- **Rust crates:** ${cargo.length}`,
    "- **Runtime LGPL obligations:**",
    "  - Bun statically links JavaScriptCore/WebKit (LGPL-2) into the compiled sidecar → relink instructions below.",
    "  - Linux builds dynamically link WebKitGTK + GTK3 (LGPL-2.1+) from the user's distro → dynamic-link compliance, user-replaceable via package manager.",
    `- **Flagged licenses (copyleft / non-permissive, surfaced for review):** ${npmFlagged.length + cargoFlagged.length} across both stacks.`,
    `- **Dominant licenses:** permissive (MIT, Apache-2.0, ISC, BSD family) on both sides.`,
    "",
    "### Flagged licenses to review",
    "",
    npmFlagged.length + cargoFlagged.length === 0
      ? "_No copyleft or non-permissive licenses detected in the shipping dependency set. (LGPL-2 obligation still applies to statically-linked Bun JSC/WebKit — see below.)_"
      : [
          "| Stack | Package | Version | License |",
          "|---|---|---|---|",
          ...npmFlagged.map(
            (p) => `| npm | \`${p.name}\` | ${p.version} | ${p.license} |`,
          ),
          ...cargoFlagged.map(
            (c) => `| cargo | \`${c.name}\` | ${c.version} | ${c.license} |`,
          ),
        ].join("\n"),
    "",
    "### Attribution obligation",
    "",
    "Every shipped dependency here is distributed under a license that requires",
    "retention of its copyright notice + license text in the distributable",
    "binary. This file is bundled into the Tauri artifact via",
    "`tauri.conf.json` → `bundle.resources` and surfaced to end users via",
    "the desktop app's Settings → About → Licenses screen. Regeneration on",
    "each dep change is enforced by the `licenses-regen` GitHub Actions",
    "workflow; a stale file fails CI.",
    "",
    "## Scope",
    "",
    "Every third-party dependency that ships inside the GPD Desktop binary:",
    "the Tauri shell, the compiled `opencode` sidecar, and everything they",
    "statically or dynamically link.",
    "",
    "Out of scope (separate deploy artifacts, not on end-user machines):",
    "",
    "- `packages/web/` — documentation site",
    "- `packages/console/`, `@opencode-ai/console-app` — web console",
    "- `packages/enterprise/` — enterprise-only deploys",
    "- `infra/litellm/gpd_log/` — Railway-side log ingest (see `docs/LOGGING.md`)",
    "- Dev-only tooling (turbo, prettier, eslint, vite, typescript, etc.)",
    "",
    "## Bun runtime + JavaScriptCore/WebKit (LGPL-2) — obligation",
    "",
    "The `opencode` sidecar is produced by `bun build --compile`, which",
    "statically links Bun's embedded JavaScriptCore and WebKit builds into",
    "the output binary. Per Bun's own `LICENSE.md`, JavaScriptCore/WebKit",
    "are LGPL-2, and binary distribution requires us to provide end users",
    "the ability to relink the binary against a modified JSC/WebKit.",
    "",
    "LGPL-2 §6 compliance:",
    "",
    "1. **Modified source of JSC/WebKit as used by Bun:**  ",
    "   <https://github.com/oven-sh/webkit>",
    "2. **Bun source:**  ",
    "   <https://github.com/oven-sh/bun>",
    "3. **Relink procedure:** rebuild Bun from source against the modified",
    "   JSC/WebKit (see Bun's `CONTRIBUTING.md`); then re-run",
    "   `bun build --compile` from `packages/opencode/` to produce a",
    "   replacement `opencode-cli-<triple>` and drop it into",
    "   `packages/desktop/src-tauri/sidecars/` before rebuilding the Tauri",
    "   bundle.",
    "",
    "Full LGPL-2 text: <https://www.gnu.org/licenses/old-licenses/lgpl-2.0.en.html>.",
    "",
    "## Upstream fork",
    "",
    "This repository is a downstream fork of [OpenCode](https://github.com/anomalyco/opencode),",
    "which is MIT-licensed. Both the upstream opencode copyright and the PSI",
    "fork copyright are preserved in the root `LICENSE` file.",
    "",
    "## Bundled binaries",
    "",
    "Binaries shipped inside the Tauri bundle, outside the Rust/npm dep trees above:",
    "",
    "| Binary | License | Where | Source |",
    "|---|---|---|---|",
    "| `uv` | MIT | `packages/desktop/src-tauri/uv-bundle/uv` → bundled into `.app`/`.exe`/`.deb` as a resource | <https://github.com/astral-sh/uv> |",
    "| `tectonic` | MIT | Downloaded on demand when the user enables the LaTeX capability. Installed to `~/.config/gpd/.capabilities/tectonic/bin/tectonic`. | <https://github.com/tectonic-typesetting/tectonic> |",
    "| CPython | PSF License | Optional: installer fetches `python-build-standalone` from Astral when no suitable system Python is present. Installed to `~/.gpd/python/`. | <https://github.com/indygreg/python-build-standalone> |",
    "",
    "`tectonic` links to: `libxz` (public-domain / 0BSD core, some tooling GPL-2 not shipped),",
    "ICU (Unicode License), `zlib` (Zlib License), FreeType (FTL / GPL-2 dual — we consume",
    "FTL terms), fontconfig (MIT). Full license texts are distributed with the tectonic",
    "binary when it is fetched at runtime.",
    "",
    "## System-linked platform runtime",
    "",
    "| Platform | Library | Linking | License | Notes |",
    "|---|---|---|---|---|",
    "| macOS | WKWebView (Apple WebKit) | Dynamic, system-provided | Apple Public Source License 2.0 | Shipped by macOS; users can't meaningfully replace. Trivial compliance. |",
    "| Windows | WebView2 (Chromium-based, Microsoft Edge) | Dynamic, system-provided | Microsoft Software License Terms (proprietary) | User installs WebView2 runtime separately (or it's preinstalled). Not redistributed by us. |",
    "| Linux | WebKitGTK (`webkit2gtk` 2.0.2+) | Dynamic, system-provided (user's distro) | **LGPL-2.1-or-later** | LGPL-compliant because the library is dynamically linked and user-replaceable via the distro's package manager. Source: <https://webkit.org/>. |",
    "",
    "On Linux we additionally link to GTK3 (LGPL-2.1-or-later, same compliance",
    "as WebKitGTK) via the `gtk` + `gdk` Rust crates.",
    "",
    "## Python sidecar (`get-physics-done` + transitive deps)",
    "",
    "The installer (`install-gpd/install`, `install-gpd/windows_11/install.ps1`)",
    "provisions a per-user Python venv at `~/.gpd/venv/` and `pip install`s",
    "[`get-physics-done`](https://github.com/psi-oss/get-physics-done) into it",
    "at first run. The sidecar spawns MCP servers from that venv.",
    "",
    "These packages are **downloaded from PyPI by the user's machine at install",
    "time**, not bundled in the Tauri binary. Licenses listed for completeness.",
    "Actual versions resolved at install time live at",
    "`~/.gpd/venv/lib/python3.*/site-packages/*.dist-info/METADATA`.",
    "",
    "| Package | Role | License |",
    "|---|---|---|",
    "| `get-physics-done` | GPD CLI + MCP servers | Apache-2.0 |",
    "| `typer` | CLI framework | MIT |",
    "| `rich` | Terminal rendering | MIT |",
    "| `pydantic` | Data validation | MIT |",
    "| `PyYAML` | YAML parsing | MIT |",
    "| `mcp[cli]` | Anthropic Model Context Protocol SDK | MIT |",
    "| `pybtex` | BibTeX parsing | MIT |",
    "| `Pillow` | Image handling | MIT-CMU / HPND |",
    "| `jinja2` | Template engine | BSD-3-Clause |",
    "| `arxiv-mcp-server` (optional, `arxiv` extra) | arXiv integration MCP | Apache-2.0 |",
    "| `pypdf` (optional, `arxiv` extra) | PDF parsing | BSD-3-Clause |",
    "",
    "Transitive Python deps (pulled in by the above, ~50 packages): all",
    "permissive per spot-check (MIT / Apache-2.0 / BSD family / PSF).",
    "`get-physics-done`'s `pyproject.toml` is canonical for the direct set;",
    "`uv pip compile` produces the full resolved tree.",
    "",
    "---",
    "",
    "## npm / Bun packages",
    "",
    `Total: ${npm.stats.total} packages. UNKNOWN license: ${npm.stats.unknown}.`,
    "",
  )

  const npmSorted = [...npm.pkgs.values()].sort((a, b) =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
  )
  for (const p of npmSorted) {
    const head = p.version ? `${p.name}@${p.version}` : p.name
    out.push(`### ${head} — ${p.license}`)
    if (p.author) out.push(`- **Author:** ${p.author}`)
    if (p.repository) out.push(`- **Repository:** ${p.repository}`)
    if (p.description) out.push(`- **Description:** ${p.description}`)
    if (p.licenseText) {
      out.push("", "<details><summary>License text</summary>", "", "```")
      out.push(p.licenseText.slice(0, 20000))
      out.push("```", "", "</details>")
    }
    if (p.noticeText) {
      out.push("", "<details><summary>NOTICE (Apache-2.0)</summary>", "", "```")
      out.push(p.noticeText.slice(0, 20000))
      out.push("```", "", "</details>")
    }
    out.push("")
  }

  out.push("---", "", "## Rust crates", "", `Total: ${cargo.length} crates.`, "")
  const CARGO_OVERRIDES: Record<string, string> = {
    // cargo-license reports the `license_file` field ("LICENSE") as the
    // license string when no SPDX `license` field is set. Both crates ship
    // an MIT LICENSE file; verified by reading
    // ~/.cargo/registry/src/.../dlopen2-*/LICENSE.
    dlopen2: "MIT (from LICENSE file in crate source)",
    dlopen2_derive: "MIT (from LICENSE file in crate source)",
    // Our own git dep; no LICENSE in that repo yet. Tracked as a P1 followup
    // to push a LICENSE (MIT) commit to psi-oss/tauri-plugin-mcp.
    "tauri-plugin-mcp":
      "MIT (PSI fork — LICENSE file missing from upstream repo, owner will add)",
  }
  const cargoSorted = [...cargo].sort((a, b) =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
  )
  for (const c of cargoSorted) {
    const rawLicense = c.license ?? c.license_file ?? "UNKNOWN"
    const license = CARGO_OVERRIDES[c.name] ?? rawLicense
    out.push(`### ${c.name} ${c.version} — ${license}`)
    if (c.authors) out.push(`- **Authors:** ${c.authors}`)
    if (c.repository) out.push(`- **Repository:** ${c.repository}`)
    if (c.description) out.push(`- **Description:** ${c.description}`)
    out.push("")
  }

  await fs.writeFile(path.join(ROOT, "THIRD_PARTY_NOTICES.md"), out.join("\n"))

  // Emit a separate summary file with just the deduplicated license roll-up.
  // This is the human-scannable "what licenses do we ship and how many of each"
  // view; the full per-package manifest stays in THIRD_PARTY_NOTICES.md.
  const summary: string[] = []
  summary.push(
    "# Third-party license summary",
    "",
    `Regenerated ${now} from \`bun.lock\` + \`packages/desktop/src-tauri/Cargo.lock\`.`,
    "Do not hand-edit — run `scripts/licenses/regen.sh` and commit the diff.",
    "",
    "Deduplicated roll-up of every license string that appears on a dependency",
    "shipped inside the GPD Desktop binary. Compound SPDX expressions like",
    "`A OR B` are NOT split — they represent a single upstream license that the",
    "consumer picks from. Per-package detail + full license texts live in",
    "[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).",
    "",
    `**Totals:** ${npm.stats.total} npm packages · ${cargo.length} Rust crates · ${combinedRows.length} distinct license strings · ${npm.stats.total + cargo.length} total package entries.`,
    "",
    "## Licenses in use",
    "",
    "| License | npm | Rust | Total |",
    "|---|---:|---:|---:|",
    ...combinedRows.map(
      (r) => `| \`${r.license}\` | ${r.npm || ""} | ${r.cargo || ""} | ${r.total} |`,
    ),
    "",
    "## Flagged licenses (copyleft / non-permissive, surfaced for review)",
    "",
    npmFlagged.length + cargoFlagged.length === 0
      ? "_None in the shipping dependency set. (LGPL-2 obligation still applies to statically-linked Bun JSC/WebKit — see `THIRD_PARTY_NOTICES.md` § Bun runtime.)_"
      : [
          "| Stack | Package | Version | License |",
          "|---|---|---|---|",
          ...npmFlagged.map(
            (p) => `| npm | \`${p.name}\` | ${p.version} | ${p.license} |`,
          ),
          ...cargoFlagged.map(
            (c) => `| cargo | \`${c.name}\` | ${c.version} | ${c.license} |`,
          ),
        ].join("\n"),
    "",
    "## Runtime LGPL obligations (summary)",
    "",
    "- **Bun** statically links JavaScriptCore/WebKit (LGPL-2) into the compiled",
    "  `opencode-cli` sidecar → relink instructions in",
    "  `THIRD_PARTY_NOTICES.md` § *Bun runtime + JavaScriptCore/WebKit*.",
    "- **Linux builds** dynamically link WebKitGTK + GTK3 (LGPL-2.1-or-later)",
    "  from the user's distro → dynamic-link compliance, library is",
    "  user-replaceable via the package manager.",
    "",
  )
  await fs.writeFile(path.join(ROOT, "THIRD_PARTY_SUMMARIES.md"), summary.join("\n"))

  console.log(
    `wrote THIRD_PARTY_NOTICES.md — ${npm.stats.total} npm + ${cargo.length} cargo + 1 Bun LGPL section`,
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
