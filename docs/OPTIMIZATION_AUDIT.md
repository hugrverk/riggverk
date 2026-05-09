# Optimization Audit

**Starting commit:** `74367d9fcd2b3d4e913cf2a4ecf2b7655a21f24b` (`v0.1.0-rc.1`)
**Date:** 2026-05-09

## Baseline Sizes

| Artifact | Before |
|---|---|
| dist (raw) | 352KB |
| dist JS (raw) | 292.5KB |
| dist JS (gzip) | 82.9KB |
| dist CSS (raw) | 60.4KB |
| dist CSS (gzip) | 9.3KB |
| Tauri bundle | 19MB |
| .app | 11MB |
| DMG | 6.2MB |
| Executable | 8.9MB |
| Icon (icns) | 1.6MB |
| Default workspace | 300KB |

## After Sizes

| Artifact | After | Delta |
|---|---|---|
| dist (raw) | 360KB | +8KB (extra chunks) |
| dist main JS (raw) | 256.2KB | **-36.3KB (-12%)** |
| dist main JS (gzip) | 75.9KB | **-7.0KB (-8%)** |
| dist CSS (raw) | 61.2KB | +0.8KB (new styles) |
| dist CSS (gzip) | 9.4KB | +0.1KB |
| Lazy chunks (total) | 38.5KB | new (deferred load) |
| Tauri bundle | 16MB | **-3MB (-16%)** |
| .app | 9.0MB | **-2.0MB (-18%)** |
| DMG | 5.8MB | **-0.4MB (-6%)** |
| Executable | 7.2MB | **-1.7MB (-19%)** |
| Default workspace | 300KB | unchanged |

## Delta Summary

| Area | Savings | Method |
|---|---|---|
| Initial JS bundle | -36KB raw / -7KB gzip | React.lazy code splitting |
| Executable | -1.7MB | `strip = true` + `lto = "thin"` |
| .app bundle | -2.0MB | Profile tuning (propagates from executable) |
| DMG | -0.4MB | Profile tuning |
| Total bundle | -3MB | Profile tuning |

## Runtime Observations

- Build time: ~540ms (Vite), ~90s (Tauri release with LTO — was ~24s without LTO)
- LTO adds ~60s to Rust build time; acceptable for release builds
- No runtime performance regressions observed
- Lazy-loaded views show brief "loading…" fallback (<100ms on local machine)

## UX Findings

### Implemented
- **Dismissible error banner** — error banner now has an × dismiss button with `role="alert"`
- **Focus-visible styles** — all interactive elements show accent-colored focus ring for keyboard navigation; mouse focus remains clean
- **Search clear buttons** — changed from single "x" to labeled "clear" buttons with better opacity hover
- **Loading fallbacks** — lazy-loaded views show styled "loading library…"/"loading…" text

### Deferred (no measurable impact or low priority)
- Icon optimization (1.6MB icns) — quality loss not worth ~200-400KB savings
- Further CSS minification — already at 9.4KB gzipped; diminishing returns
- Markdown parser replacement — custom parser is lightweight; no measurable bottleneck
- Terminal output virtualization — output volumes in this app don't justify the complexity

## Implemented Changes

### A. Size reporting
- `scripts/release-size-report.sh` — reports dist, default workspace, and Tauri bundle sizes

### B. Frontend bundle optimization
- `React.lazy` + `Suspense` for LibraryView, RoutingView, SettingsView
- WorkspaceView remains eager (initial view)
- Loading fallbacks styled with `.view-loading` class

### C. React render optimization
- `useMemo` for `filteredSkills` in WorkspaceView
- `useMemo` for `activeProfileId` in App.tsx
- `useMemo` for `installAgentsArray` in App.tsx
- `useMemo` for `configTargets` in App.tsx
- `useMemo` for `ruleTargets` in LibraryView
- `useMemo` for skill filtering in LibraryView SkillItemList

### D. Markdown/JSON rendering
- `useMemo` for Markdown component parsing (memoized on `content` prop)
- `useMemo` for JSON formatting in ConfigContent (memoized on content)

### E. Cargo release profile
- Added `[profile.release]` with `strip = true` and `lto = "thin"`
- Build time increased from ~24s to ~90s (acceptable for release)

### F. Default workspace
- No changes needed — already lean at 300KB, no stale content found

### G. UX polish
- Dismissible error banner with `role="alert"`
- `:focus-visible` / `:focus` split for keyboard vs mouse focus
- Search clear buttons labeled "clear" instead of "x"

### H. Docs
- Updated `docs/APP_RELEASE_SMOKE.md` with lazy-loaded views and keyboard navigation checks
- Added size report to preflight checklist

## Verification

| Check | Result |
|---|---|
| `npm run build` | PASS |
| `cargo fmt --check` | PASS |
| `cargo check` | PASS |
| `cargo clippy -- -D warnings` | PASS |
| `cargo test` | PASS (206 tests) |
| `./scripts/release-check.sh` | PASS |
| `./scripts/release-size-report.sh` | PASS |

## Remaining Risks

- LTO increases release build time (~60s penalty) — acceptable for CI/release
- Lazy-loaded views add one extra chunk per view — negligible network impact for local app
- No automated size regression guard yet — size report is informational only

## Recommended Next Action

**Publish RC** — all gates pass, sizes improved measurably, UX polish complete.
Follow-up: code signing/notarization for public distribution.
