# Changelog

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
