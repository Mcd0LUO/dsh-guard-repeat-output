// Retroactive context decontamination — purging residue the live guard never saw.
//
// WHY THIS EXISTS
// The stream guard prevents NEW pollution, but it cannot help a session that was
// already poisoned before it was installed. Measured on a real incident after the
// guard went live: the active context still carried 205,942 characters of
// degenerate reasoning (a 113,586-char and a 92,356-char block) that every
// subsequent request replayed. Those blocks are exactly the priming that makes a
// collapse recur.
//
// WHAT IT DOES
// Scans a session log for assistant messages whose reasoning is degenerate and
// shadows them with a short replacement note, using the same surface-replacement
// mechanism compaction uses. Shadowed nodes leave the model-visible surface, so
// the next request no longer replays them — while the append-only log keeps the
// original bytes for audit. Nothing is deleted.
//
// THE SAFETY RULE THAT MATTERS
// An assistant message that contains tool-call blocks must NOT be shadowed on its
// own: its `tool/result` replies would survive as orphans, and providers reject a
// tool result with no matching call. This was verified against the real surface
// fold, which accepts the orphan silently — so the danger is real and not caught
// downstream. This module therefore skips any message containing a tool call and
// reports it instead. Runaway reasoning is by nature tool-call free (the
// incident's 725KB block produced zero calls), so the rule costs almost nothing.

import { evaluateRepetitionWindow } from '../index.js'

/**
 * Whether one block of reasoning text looks degenerate.
 *
 * Reuses the LIVE detector rather than a second implementation, so the offline
 * scan and the live guard can never disagree about what "degenerate" means. The
 * text is fed forward in check-sized slices and the accumulating tail window is
 * evaluated at each step, exactly as the live stream does as it grows.
 *
 * @param {string} text - concatenated reasoning text of one message.
 * @param {object} thresholds - resolved guard thresholds (same shape the live guard uses).
 * @returns {object|null} the detector's evidence, or null when healthy.
 */
export function reasoningVerdict(text, thresholds) {
  if (typeof text !== 'string' || text.length < thresholds.minWindowChars) return null
  const step = Math.max(1, thresholds.evalEveryChars)
  // Evaluate the growing tail. The first slices are below minWindowChars and
  // return null, which is the same "not enough evidence yet" the live guard sees.
  for (let end = step; end < text.length + step; end += step) {
    const evidence = evaluateRepetitionWindow(text.slice(0, end), thresholds, 'reasoning')
    if (evidence !== null) return evidence
  }
  return null
}

/**
 * Find degenerate assistant messages in one session's events.
 *
 * @param {readonly object[]} events - contiguous session events.
 * @param {object} thresholds - resolved guard thresholds.
 * @returns {Array<{seq: number, turn: number, step: number, chars: number, hasToolCall: boolean, evidence: object}>}
 *   one entry per degenerate message, oldest first.
 */
export function findDegenerateMessages(events, thresholds) {
  const found = []
  for (const event of events) {
    if (event?.type !== 'assistant/message') continue
    const content = event.data?.message?.content
    if (!Array.isArray(content)) continue
    let reasoning = ''
    let hasToolCall = false
    for (const block of content) {
      if (block?.type === 'reasoning' && typeof block.text === 'string') reasoning += block.text
      else if (block?.type === 'tool-call') hasToolCall = true
    }
    if (reasoning.length === 0) continue
    const evidence = reasoningVerdict(reasoning, thresholds)
    if (evidence === null) continue
    found.push({
      seq: event.seq,
      turn: event.data.turn,
      step: event.data.step,
      chars: reasoning.length,
      hasToolCall,
      evidence,
    })
  }
  return found
}

/**
 * Build the replacement note that shadows one degenerate message.
 * @param {object} entry - one entry from {@link findDegenerateMessages}.
 * @returns {string} model-facing replacement text.
 */
export function cleanupNote(entry) {
  return [
    '[guard-repeat-output] Removed a degenerate reasoning block from this conversation:',
    `- ${entry.chars} characters of repeating text at turn ${entry.turn}, step ${entry.step}`,
    `- measured repetition ${(entry.evidence.duplicateShare * 100).toFixed(1)}%, new-material ratio ${(entry.evidence.uniqueGramRatio * 100).toFixed(1)}%`,
    'The block produced no work and is not shown again. Continue from the surrounding conversation.',
  ].join('\n')
}
