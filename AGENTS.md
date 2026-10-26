# Maintenance instructions

This repository contains the desktop source corresponding to the published
`v0.8.5-build142-desktop-preview` binaries. Start with
[`docs/BUILD142-MAINTENANCE.md`](docs/BUILD142-MAINTENANCE.md).

- The maintained desktop project is `desktop/`. Existing `ios/` and `obsidian/`
  are retained separately; this desktop handoff does not claim they were updated
  to native build143 or later.
- Never modify, migrate, rename, delete or reorganize a real notes folder just to
  run or test this repository. Never use a real iCloud vault as a test fixture.
- Do not launch development code against the installed application's profile.
  Use `cd desktop && npm run dev:safe`, which creates isolated local data and a
  synthetic vault. The normal `npm start` uses Electron's normal profile rules.
- Preserve `org.inkspace.desktop`, internal helper IDs, `人生赢家` profile naming,
  URI schemes and file-format compatibility unless a migration is explicitly
  designed, tested and requested. Browser sessions, API credentials, mail
  accounts, device identities and notes must never enter commits or artifacts.
- Before fixing a reported bug, record the installed build, OS, steps to
  reproduce, expected behavior and actual behavior. Use synthetic/minimized
  fixtures. Check the baseline manifest before claiming source equivalence.
- Keep changes in Git, test relevant behavior, then publish versioned platform
  packages from the same reviewed source. Do not patch an installed `app.asar`
  in place or keep unrecorded machine-specific fixes as the maintained version.
- Run `npm run typecheck`, `npm test`, and `npm run build` for a desktop release.
  Run `npm run verify:source` to compare the frozen baseline; new intentional
  changes will need a new reviewed baseline rather than pretending to be142.
- Windows is a compatibility preview. Apple handwriting, Vision OCR, local
  dictation/recording, Notebook scientific execution and the native mail helper
  are not implemented on Windows. Do not claim package checks are Windows
  installation or runtime tests.
- `desktop/runtime-src/` contains owned runtime source. Downloaded runtimes,
  caches, build outputs, signing material and user data are ignored. Never commit
  them. Keep third-party licenses and provenance in distributable packages.
- Preserve historical release tags. The original binary tag points at an older
  repository commit; the explicitly named build142 source archive and current
  `desktop/` are the maintenance starting point. Do not move that tag.

Root `source-manifest.json` and `.source-tree-state.json` record the reviewed
source archive and its initial expansion. Older dated ZIP archives remain as
historical references. Maintain subsequent fixes directly in Git; for the frozen
desktop142 comparison use `desktop/release-baseline/build142.json`.
