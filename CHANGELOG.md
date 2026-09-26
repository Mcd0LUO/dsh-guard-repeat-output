# Changelog

## 1.2.0

- **The perturbation ladder is now derived from the adapter.** The guard asks the
  provider which reasoning efforts the exact model declares and steps down that
  list, instead of trusting a hard-coded ladder. A rung the model does not offer
  throws `UNSUPPORTED_REASONING_EFFORT` and turns a caught collapse into a dead
  turn, so this removes a class of failure rather than just a value.
- **The lowered effort is restored on the next request.** A perturbation is
  written into `request/header` and every later request derives from it, so
  without an explicit restore one collapse left the session on the lowered rung
  permanently. A live session dropped to `low` and ran its remaining 12 steps
  there. Recovery also defers to any externally chosen effort.
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