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

The guard evaluates a sliding window of the stream as it arrives, and acts on three levels.

**While the stream is live:**

1. **Sanitize** — blacklisted code points (control characters, U+FFFD, zero-width filler, lone
   surrogates) are stripped from every delta before it is forwarded, so they can never reach the
   log. Unlike repetition this needs no statistical judgement. A *dense* burst — a long unbroken
   run, or a high share of one delta — is collapse evidence in its own right: a model that emits
   200 NUL bytes in a row is gone, whether or not it also loops.
2. **Detect** — a sliding window over the reasoning channel, checking phrase repetition,
   low-information density, and segment structure.
3. **Discard** — the collapsed attempt is settled as a log-only event instead of a surfaced
   message, so none of the degenerate text enters derived history.
4. **Retry** — the request is re-issued unchanged, as a clean regeneration. The route is never
   rewritten: see [Why the retry does not lower the effort](#why-the-retry-does-not-lower-the-effort).
5. **Wrap up** — once the retry budget is spent, the stream is cut at the estimated onset and
   the model is asked to conclude, so the turn still finishes instead of failing.

**Retroactively, for a session that was already poisoned:**

6. **Clean up** — the `/guard-cleanup` command scans the session log for degenerate reasoning
   that is already persisted and shadows it with a short note, using the same surface-replacement
   mechanism compaction uses. Those blocks leave the model-visible surface, so the next request no
   longer replays them — while the append-only log keeps the original bytes for audit. Nothing is
   deleted.

   This exists because the live guard cannot repair damage done before it was installed. Measured
   on a real incident *after* the guard went live: the active context still carried **205,942
   characters** of degenerate reasoning (a 113,586-char and a 92,356-char block) that every
   subsequent request replayed — exactly the priming that makes a collapse recur.

   **Safety rule:** an assistant message that owns tool-call blocks is *skipped*, not shadowed.
   Shadowing it would orphan its `tool/result` replies, and providers reject a tool result with
   no matching call — and the real surface fold accepts that orphan silently, so the danger is not
   caught downstream. Runaway reasoning is tool-call free by nature (the incident's 725KB block
   produced zero calls), so the rule costs almost nothing.

### Why the retry does not lower the effort

An earlier version stepped the reasoning effort down one rung on the retry, on the theory that an
identical request reproduces an identical collapse. It was removed after being measured against
real traffic:

| Observation | Result |
|---|---|
| Convictions lowered, which then resolved | 9 of 9 |
| Of those, sessions that collapsed **again** later | **6 of 9 (67%)** |
| Convictions where the adapter **rejected** the proposed rung | 7, of which **3 killed the turn** |

The 67% recurrence is the decisive number: the lowered rung conferred no immunity, so the
discard-and-regenerate is what does the work and the lowering was not earning its place. Meanwhile
every rejection was the same class of failure — an adapter refusing an effort the model does not
declare (`does not support reasoning effort "medium"`) — turning a caught collapse into a dead
turn. A guard whose recovery can kill the turn is worse than one that only discards.

[`verify/effort-necessity.mjs`](./verify/effort-necessity.mjs) is kept so the claim stays
falsifiable rather than becoming folklore.

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
| `maxDegenerationRetries` | `2` | Discard-and-retry attempts before falling back to truncation. The retry does not alter the route. |
| `sanitizeGarbage` | `true` | Strip blacklisted code points from every delta before it is forwarded. |
| `garbageRunChars` | `32` | An unbroken garbage run this long counts as collapse evidence. |
| `garbageRatio` | `0.5` | A garbage share this high within one delta counts as collapse evidence. |
| `cleanupCommand` | `true` | Register `/guard-cleanup` for retroactive decontamination. |
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

- **The retry never touches the route.** A guard's recovery must not be able to fail the turn it
  is rescuing; proposing a reasoning effort the model does not declare does exactly that.
- **Detection is scoped by model id**, so the guard stays out of the way of models it was not
  calibrated for.
- **Logging and sidecar copies are diagnostics, never control paths.** If the filesystem is
  unwritable the guard keeps working and stays silent.

## Extension points

- `llm/stream` — sanitization, detection and stream intervention.
- `agent/request-error` — re-issue a request terminated for degeneration.
- `agent/pre-step` — fallback re-injection when the instruction is not already pending.
- `commands` (via `ctx.inject`) — register `/guard-cleanup` when the service is available.

The guard registers no `agent/request` listener: the re-issued request is deliberately identical
to the one that collapsed.

## Tests

```bash
# The corpus is real captured model output and is NOT shipped: point the first
# argument at any tree containing legit/L00001.txt and unreg/deg1-seq2608.txt.
node verify/integration.mjs <corpusRoot>   # end-to-end detection and intervention
node verify/mutations.mjs                  # detector controls: each leg must be able to fail
node verify/cross-platform.mjs             # path resolution and filename safety
node verify/maintenance.mjs                # sanitization and retroactive cleanup (self-contained)
```

`verify/effort-necessity.mjs` is an operational diagnostic rather than a self-contained test: it
reads a live guard log and a DSH sessions root to re-derive the measurement above.

## License

MIT
