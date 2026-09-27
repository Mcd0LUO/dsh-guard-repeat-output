# Changelog

## 2.1.5

- **The Chinese README was rewritten for readability.** The first pass was a
  literal translation of the English text, which left it dense and full of
  jargon a Chinese reader had to decode. It now leads with a plain-language
  summary, explains each mechanism in ordinary wording, and drops detail that
  only matters when editing the source.
- **Corrected two numbers in the English README.** The incident table cited
  `"let me write the call"` × 1,951; the actual count is **1,952**. The quoted
  phrases are now reproduced exactly as they appear in the captured text
  (capitalised, with the trailing period), so the counts can be verified by
  search rather than guessed at.
- Both READMEs now state the measured production result — 12 real collapses
  caught, all 12 recovered, none of the discarded text reached session history —
  instead of leaving the reader to infer it.

No behavioural change.


## 2.1.4

- **Fixed: a blank `modelIncludes` silently widened the scope to every model.**
  `[]` deliberately means "every model", but `['   ']` — a list the caller clearly
  meant to narrow — was filtered to empty and therefore matched everything too.
  That is the opposite of the intent and the dangerous direction, because every
  threshold is calibrated on DeepSeek output alone. A non-empty list whose entries
  all normalize away is now rejected with an error that names the empty-array
  alternative. `truncateChannels` was checked for the same class of bug and is
  safe: it matches exactly, so an unmatched entry disables truncation rather than
  enabling it everywhere.
- **Chinese README** (`README.zh-CN.md`) with a language switcher in both files.
- `verify/config.mjs` — 23 checks covering scope validation, numeric ranges and
  boolean flags, so a future edit cannot quietly reintroduce the fail-open.


## 2.1.3

- **Package metadata completed.** `repository`, `homepage`, `bugs` and `author`
  were absent, so the npm page carried no link back to this repository. (They
  were added once before and then dropped when `package.json` was rewritten for
  1.2.0 — which is why the fix is called out here rather than assumed.)
- **The description was stale.** It still described v1's behaviour ("truncates
  the stream at the collapse point"); v2 discards the whole attempt and retries,
  and the package now also strips garbage code points and can decontaminate a
  session retroactively. All three are named now.

No behavioural change.


## 2.1.2

- **The activation line now goes to `console.log`, not `ctx.logger.info`.** The
  2.1.1 line was written through `ctx.logger` and never appeared: the harness does
  not surface `logger.info` to the service journal. Confirmed on a live deploy —
  the line was invisible through `ctx.logger` and visible through `console.log`,
  which is also what the sibling plugins use for their own startup lines.

## 2.1.1

- **The plugin now logs one activation line.** It was silent on mount, so a
  mounted plugin and an unmounted one looked identical in the journal — which
  made "is it actually running?" unanswerable at exactly the moment it matters,
  right after a deploy. Found while deploying: the only way to confirm the mount
  was to load the module by hand in the profile directory.

## 2.1.0

Ported the two capabilities of the earlier `@local/dsh-degeneration-guard` so that
replacing it with this package loses nothing.

- **Blacklist sanitization** (`lib/sanitize.js`). Control characters, U+FFFD,
  zero-width filler and lone surrogates are stripped from every delta before it is
  forwarded, so they can never reach the session log. A *dense* burst (an unbroken
  run of `garbageRunChars`, or a `garbageRatio` share of one delta) is treated as
  collapse evidence in its own right; a single stray U+FFFD is a decoding hiccup and
  is cleaned silently. Configure with `sanitizeGarbage`, `garbageRunChars`,
  `garbageRatio`.
- **Retroactive cleanup** (`lib/cleanup.js`, `/guard-cleanup`). Scans the session
  log for degenerate reasoning that is already persisted and shadows it with a short
  note, so the next request stops replaying it. Nothing is deleted — the append-only
  log keeps the original bytes. A message that owns tool calls is skipped rather than
  shadowed, because shadowing it would orphan its `tool/result` replies.
- **The offline scan reuses the live detector** rather than a second implementation,
  so the two can never disagree about what "degenerate" means. This is the one
  deliberate departure from the original module, which had its own detector class.
- `DEFAULTS` is now exported so tests exercise the real thresholds instead of a copy.
- `files` includes `lib`, so the new modules ship. This is the same class of
  packaging mistake that caused an earlier crash-loop: a declared entry point whose
  file is absent from the tarball.


## 2.0.0

**Breaking: the retry no longer changes the reasoning effort.**

- **Removed effort perturbation.** The guard re-issues a collapsed attempt with the
  route unchanged. Measured against real traffic before removing it: of 16
  convictions, 6 of the 9 sessions that were successfully lowered collapsed again
  anyway (67%), so the lowering conferred no immunity and the discard-and-regenerate
  is what does the work. It also cost 8 dead turns, each an adapter rejecting a rung
  the model does not declare (`does not support reasoning effort "medium"`). A guard
  whose recovery can kill the turn is worse than one that only discards.
- **Removed the `perturbEfforts` option** and the `agent/request` listener. The
  guard no longer rewrites the request config at all, so it cannot fail a turn by
  proposing an unsupported effort.
- **Added `exports` entries** for `./cordis.patch.yml` and `./package.json`, matching
  every other plugin and the official bundles. This does not affect mounting — DSH
  resolves a bundle's patch with `join(packageDir, file)`, not through `exports` —
  but it makes the package consistent for tooling that reads them.
- `verify/effort-necessity.mjs` is kept so the measurement above stays falsifiable.


## 1.3.0

- **The lowered rung now lasts exactly one turn.** Recovery moved from "the next
  request" to the turn boundary: within the collapsing turn the lowered rung
  stands (a long turn cannot thrash back to the effort that just collapsed), and
  the first request of the next turn restores the original effort.
- **Measured whether the lowering is actually necessary** — see
  [`verify/effort-necessity.mjs`](./verify/effort-necessity.mjs). Across 16 real
  convictions: 9 were lowered and all 9 resolved; 7 were *rejected* lowerings and
  3 of those died. Separately, 6 of the 9 successfully-lowered sessions collapsed
  again later (67%), so the discard-and-regenerate is doing most of the work and
  the lowering is a cheap perturbation rather than a cure. The script is kept so
  the claim stays falsifiable.

## 1.2.0

- **The perturbation ladder is now derived from the adapter.** The guard asks the
  provider which reasoning efforts the exact model declares and steps down that
  list, instead of trusting a hard-coded ladder. A rung the model does not offer
  throws `UNSUPPORTED_REASONING_EFFORT` and turns a caught collapse into a dead
  turn, so this removes a class of failure rather than just a value.
- **The lowered effort is restored.** A perturbation is written into
  `request/header` and every later request derives from it, so without an explicit
  restore one collapse left the session on the lowered rung permanently. A live
  session dropped to `low` and ran its remaining 12 steps there. Recovery also
  defers to any externally chosen effort.
- **Fallback ladder no longer names `medium`.** The observed DeepSeek adapter
  declares `off`/`low`/`high`/`max`; `medium` was never valid for it. The
  fallback is now `['max','high','low','off']`, strongest-first.
- Corrected a source comment that claimed a perturbed config "is never persisted
  as the session's route". The loop re-logs `request/header` whenever the config
  changes, so it *is* persisted — which is why recovery is needed.

## 1.1.0

Cross-platform support. The plugin previously assumed a Linux host in five
places; all are fixed.

- **Portable configured paths.** `copyDir` and `logPath` accept `~`, `$DSH_HOME`,
  a relative path (resolved under the harness home), or any platform's absolute
  path. The shipped defaults are now relative instead of Linux absolute paths.
- **No more string-concatenated paths.** `writeCopy` used `${dir}/${name}`, which
  produced mixed separators on Windows; it now uses `path.join`.
- **Absolute paths are never silently rebased.** A Windows path read on Linux
  (or vice versa) is passed through rather than rewritten under the harness home.
- **Log directories are created when missing.** `appendFile` does not create
  parents on any platform, so a fresh install silently lost every record.
- **Sidecar file names are sanitized.** Session/agent ids could contribute
  characters that are illegal on some platforms, including reserved device names
  such as `CON` and `COM1`.

## 1.0.1

- Redacted internal session identifiers from the source comments.

## 1.0.0

- Initial release.