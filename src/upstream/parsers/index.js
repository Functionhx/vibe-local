// ─────────────────────────────────────────────────────────────────────────────
// MODIFIED FROM UPSTREAM — see src/upstream/UPSTREAM.md §差异 2
//
// Upstream registers 34 parsers. This build keeps only the 3 tools we support.
//
// Two are deliberately excluded, not merely absent:
//   - 'cursor'     — the one upstream parser that cannot work offline (it fetches
//                    cursor.com/api/dashboard/... with a token read from the
//                    local Cursor state DB). See UPSTREAM.md §差异 3.
//   - 'gemini-cli' — measured zero sessions on every machine we track, and its
//                    data path is hardcoded (~/.gemini/tmp) with no env or
//                    parameter override, so it cannot be redirected for the
//                    remote mirror at all. See UPSTREAM.md §差异 4.
//
// To re-add a tool: restore its `import` line, add it to `parsers`, and copy
// the parser file plus any roots file it imports.
// ─────────────────────────────────────────────────────────────────────────────

import { parse as parseClaudeCode } from './claude-code.js';
import { parse as parseCodex } from './codex.js';
import { parse as parseOpencode } from './opencode.js';

export const parsers = {
  'claude-code': parseClaudeCode,
  'codex': parseCodex,
  'opencode': parseOpencode,
};

export { roundToHalfHour, aggregateToBuckets, extractSessions } from './aggregate.js';
