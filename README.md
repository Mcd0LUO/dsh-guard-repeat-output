# dsh-guard-repeat-output

**Stops a model's repetition collapse before it burns your context.**

A host-side guard for [DSH](https://github.com/deepseek-ai) that watches the model's output
stream and cuts off degenerate repetition the moment it starts.

---

## The problem

Sometimes a model gets stuck. Instead of finishing its thought, it starts emitting the same
phrase over and over:

```
let me write the call let me write the call let me write the call let me write ...
```

This is not a rare edge case. Two real incidents captured on a production server:

| Length | Shape |
|---|---|
| 1,371,962 chars | `"let me produce"` × 27,269 — pure repetition |
| 250,506 chars | `"let me write"` × 1,958 alternating with `"let me write the call"` × 1,951 |

Nothing in the loop noticed. The turn kept generating — and billing — until the model happened
to stop on its own, or a human pressed cancel. Every one of those tokens then sits in the
context window, crowding out the work that actually mattered.

## What it does

The guard evaluates a sliding window of the stream as it arrives. On conviction it does not
merely truncate — it **discards the collapsed attempt** and retries:

1. **Detect** — a sliding window over the reasoning channel, checking phrase repetition,
   low-information density, and segment structure.
2. **Discard** — the collapsed attempt is settled as a log-only event instead of a surfaced
   message, so none of the degenerate text enters derived history.
3. **Retry with a twist** — the request is re-issued one rung *down* the reasoning ladder the
   adapter declares for that exact model. An identical request tends to reproduce an identical
   collapse. The lowered rung lasts **one attempt**: the next request restores the original
   effort, so a collapse cannot leave the session permanently degraded.
4. **Wrap up** — once the retry budget is spent, the stream is cut at the estimated onset and
   the model is asked to conclude, so the turn still finishes instead of failing.

## Install

```bash
npm install dsh-guard-repeat-output
```

Then mount it in your DSH profile. The package ships a Cordis patch layer:

```yaml
- insert:
    - id: guard-repeat-output
      name: 'dsh-guard-repeat-output'
      config:
        # see cordis.patch.yml for the full annotated default set
        truncateChannels: ['reasoning']
        maxDegenerationRetries: 2
```

## Configuration

Every option is documented inline in [`cordis.patch.yml`](./cordis.patch.yml), including the
measured basis for each default. The ones that matter most:

| Option | Default | Meaning |
|---|---|---|
| `truncateChannels` | `['reasoning']` | Channels the guard may act on. Everything else is observe-only. |
| `modelIncludes` | `['deepseek']` | Substring scope for model ids; empty list means every model. |
| `maxDegenerationRetries` | `2` | Discard-and-retry attempts before falling back to truncation. |
| `perturbEfforts` | `['max','high','low','off']` | **Fallback** effort ladder. Normally the ladder is derived from the adapter's own declaration for the exact model; this is used only when that query is unavailable. |
| `holdbackChars` | `4096` | How far before release text is held, so the cut can land at the true onset. |
| `copyDir` | `null` | Optional sidecar copies of discarded text, for after-the-fact false-positive analysis. Never read back into a request. |
| `logPath` | `null` | Optional JSONL log of every conviction, for after-the-fact diagnosis. |

### Portable paths

`copyDir` and `logPath` are resolved identically on every platform, so the package makes no
assumption about a Linux layout:

| Configured value | Resolves to |
|---|---|
| `logs/guard.log` (relative) | `$DSH_HOME/logs/guard.log`, else `~/.dsh/logs/guard.log` |
| `$DSH_HOME/logs/guard.log` | the harness home |
| `~/logs/guard.log` | the OS home directory |
| `/var/log/guard.log` | used as-is (POSIX absolute) |
| `C:\logs\guard.log` | used as-is (Windows absolute) |
| `null` | feature disabled |

Relative paths resolve under the harness home rather than the process CWD, which differs per
launch. Paths are never assembled by string concatenation, so a Windows path is not given mixed
separators, and sidecar file names are sanitized of characters that are illegal on some
platforms (including reserved device names), so the sidecar cannot fail silently on one OS only.

### Design notes

- **Perturbation asks the adapter**, not the config, which reasoning efforts the exact model
  supports. A hard-coded ladder is a trap: stepping `high` down to an undeclared `medium`
  throws `UNSUPPORTED_REASONING_EFFORT` and turns a caught collapse into a dead turn.
- **Detection is scoped by model id**, so the guard stays out of the way of models it was not
  calibrated for.
- **Logging and sidecar copies are diagnostics, never control paths.** If the filesystem is
  unwritable the guard keeps working and stays silent.

## Extension points

- `llm/stream` — detection and stream intervention.
- `agent/request-error` — re-issue a request terminated for degeneration.
- `agent/request` — apply the effort perturbation.
- `agent/pre-step` — fallback re-injection when the instruction is not already pending.

## Tests

```bash
node verify/integration.mjs      # end-to-end detection and intervention
node verify/mutations.mjs        # detector controls: each leg must be able to fail
node verify/cross-platform.mjs   # path resolution and filename safety
```

## License

MIT
