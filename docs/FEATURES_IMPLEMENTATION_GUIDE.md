# Feature Implementation Guide (Design + Implementation Notes)

This document explains how to implement the following upgrades in this repo:

1. Persistent permissions (remember “allow this folder/tool always” with an audit log)
2. Better scheduler (cron support, missed-run policy, per-task timezone, `/tasks` UI)
3. Document ingestion pipeline (PDF/DOCX/HTML → chunks → embeddings → “cite page number” answers)
4. Web tool hardening (caching, multi-provider fallback, rate-limit/backoff telemetry)
5. UX improvements (tool-call cards, cancel/stop, dry-run mode)

The guidance below is written for the current code layout:

- Tools: `src/tools/systemTools.ts`, `src/tools/webTools.ts`
- Safety: `src/security/shield.ts`
- Agent loop: `src/agent/agentRunner.ts`
- UI: `src/ui/App.tsx`
- Scheduler storage: `~/.web-scout/pending_tasks.json` (managed in `src/ui/App.tsx`)
- Memory DB: `~/.web-scout/memory.sqlite` (retrieval in `src/memory/retrieval.ts`)

---

## 1) Persistent Permissions + Audit Log

### What problem this solves
Today, when Shield blocks a path/operation, the agent asks “Allow? [y/N]” each time. Users want:

- “Allow once” vs “Always allow this path/tool”
- “Always deny” for sensitive areas
- A transparent audit trail of what ran, when, and why it was allowed

### Desired user experience
When an operation is gated (e.g., `write_to_file` outside workspace), prompt:

- `y` = allow once
- `a` = always allow this (store rule)
- `n` = deny once
- `d` = always deny this (store rule)

Then the agent proceeds (or stops) without repeatedly prompting.

### Data model (simple + effective)
Create a permissions store under `~/.web-scout/`:

- `~/.web-scout/permissions.json` (rules)
- `~/.web-scout/audit.jsonl` (append-only log; one JSON per line)

**Rule example**:
```json
{
  "id": "perm_1700000000000",
  "createdAt": "2026-03-26T12:00:00.000Z",
  "scope": "path",
  "effect": "allow",
  "pattern": "C:\\Users\\relfo\\Documents\\**",
  "tools": ["read_file", "write_to_file", "read_pdf"],
  "expiresAt": null,
  "note": "User-approved for personal docs"
}
```

**Audit log line example**:
```json
{
  "ts": "2026-03-26T12:01:02.000Z",
  "tool": "write_to_file",
  "target": "C:\\Users\\relfo\\Documents\\notes.md",
  "decision": "allow",
  "ruleId": "perm_1700000000000",
  "reason": "Matched allow rule",
  "argsSummary": { "bytes": 1240 }
}
```

### Implementation architecture
Add a new module (recommended):

- `src/security/permissions.ts`
  - `loadRules() / saveRules()`
  - `matchPathRule(toolName, absolutePath) -> {effect, ruleId} | null`
  - `matchToolRule(toolName) -> {effect, ruleId} | null`
  - `appendAudit(entry)`

Then integrate it into `executeSystemTool()`:

- In `src/tools/systemTools.ts`, before prompting:
  1) Run existing Shield checks (fast “is this inside workspace/memory dir?”)
  2) If blocked → consult stored rules
  3) If no rule → ask user (once/always/deny)
  4) Write an audit log entry for allow/deny

### Where to hook it
Most valuable gating points:

- `execute_command` (command allow/deny; still keep “banned patterns” as hard-deny)
- `read_file`, `write_to_file`, `read_pdf`
- `get_project_tree` (directory reads)
- `fetch_url_text` / `research_web` (optional: allowlist domains)

### Security notes (important)
- Keep “banned commands” hard-blocked (no “allow always” for `rm -rf /` patterns).
- Store rules in user profile, not repo.
- Prefer path-glob patterns over raw regex (simpler + safer).
- Support TTL (`expiresAt`) for temporary permissions.

---

## 2) Better Scheduler (Cron + Missed Run + Timezone + `/tasks` UI)

### What problem this solves
Current scheduler:

- Stores tasks in `~/.web-scout/pending_tasks.json`
- Polls every ~15s in `src/ui/App.tsx`
- Handles basic recurring intervals (hourly/daily/weekly/monthly) and “catch-up” by advancing to the next future time

Desired improvements:

- Cron expressions (e.g., “Every weekday at 9:00”)
- Explicit missed-run policy (skip, catch-up once, catch-up all)
- Per-task timezone (so “9am IST” stays 9am IST even if system TZ changes)
- `/tasks` UI to list/edit/disable tasks without asking the LLM

### Data model upgrade
Extend each task entry to support either a one-time schedule or cron schedule:

```json
{
  "id": 1700000000000,
  "prompt": "Summarize headlines",
  "enabled": true,

  "schedule": {
    "type": "cron",
    "cron": "0 9 * * 1-5",
    "timezone": "Asia/Calcutta"
  },

  "missedRunPolicy": "catch_up_once",
  "lastRunAt": "2026-03-25T03:30:00.000Z",
  "nextRunAt": "2026-03-26T03:30:00.000Z"
}
```

For one-time tasks:
```json
{ "schedule": { "type": "once", "executeAt": "2026-03-26T10:00:00.000Z" } }
```

### Cron parsing + timezone
Recommended approach:

- Add deps:
  - `cron-parser` (compute next occurrences)
  - `luxon` (timezone-aware conversions)

High-level algorithm:
1. On load, compute `nextRunAt` for each enabled task
2. Each poll, run tasks where `nextRunAt <= now`
3. After a run, recompute next time based on cron + timezone

### Missed-run policies
When the app was closed or machine asleep, multiple runs might have been missed:

- `skip`: jump straight to the next future `nextRunAt`
- `catch_up_once`: run once now, then jump to the next future
- `catch_up_all`: run repeatedly until caught up (cap this to avoid runaway)

### `/tasks` UI commands (no LLM needed)
Implement in `src/ui/App.tsx` inside `handleSubmit` (before calling `runAgentTurn`):

- `/tasks` or `/tasks list`
- `/tasks disable <id>`
- `/tasks enable <id>`
- `/tasks delete <id>`
- `/tasks show <id>`

This is purely local logic:
1) Read `pending_tasks.json`
2) Apply edit
3) Write back
4) Render a friendly table in chat

### Recommended file layout
Extract scheduler logic out of UI:

- `src/scheduler/store.ts` (read/write tasks, atomic writes)
- `src/scheduler/computeNext.ts` (cron/interval next-run)
- `src/scheduler/runner.ts` (polling + execution trigger)

Then `App.tsx` calls the runner and only renders updates.

---

## 3) Document Ingestion Pipeline (PDF/DOCX/HTML + Chunking + Embeddings + Citations)

### What problem this solves
You already have:

- `write_to_file` and `read_pdf`
- Memory DB + embeddings retrieval (`src/memory/retrieval.ts`)

But you don’t have a unified “ingest documents” workflow that:

- Parses source formats
- Chunks consistently
- Stores metadata (doc name, page numbers, section headers)
- Returns answers with citations (e.g., “page 12”)

### Target capabilities
1. Ingest files:
   - PDF (with page-aware extraction)
   - DOCX (paragraph extraction)
   - HTML (clean text extraction)
2. Chunk into ~500–1,000 tokens (or char-based fallback)
3. Embed chunks (`text-embedding-3-small` already used)
4. Store chunks + metadata in sqlite
5. Retrieval returns:
   - chunk text
   - doc id
   - page range
6. Answer generator cites “(DocName p.12)” or “(DocName p.12–13)”

### Storage schema changes (sqlite)
Current table (implied by retrieval code):
- `memory_chunks(file_path, chunk_index, text_content, embedding)`

Extend it:
```sql
ALTER TABLE memory_chunks ADD COLUMN doc_id TEXT;
ALTER TABLE memory_chunks ADD COLUMN source_type TEXT; -- pdf|docx|html|note
ALTER TABLE memory_chunks ADD COLUMN page_start INTEGER;
ALTER TABLE memory_chunks ADD COLUMN page_end INTEGER;
ALTER TABLE memory_chunks ADD COLUMN title TEXT;
ALTER TABLE memory_chunks ADD COLUMN created_at TEXT;
```

### Ingestion steps
**1) Parse**
- PDF: use `pdf-parse` page-wise (you’re already using `PDFParse().getText()`; extend to per-page text)
- DOCX: recommend `mammoth` (extract raw text)
- HTML: reuse the `fetch_url_text` HTML → plain text logic

**2) Normalize**
- Normalize whitespace
- Preserve page boundaries and headings where possible

**3) Chunk**
Chunking strategy:
- Split by paragraphs/sentences until a target size (chars or tokens)
- Keep metadata for each chunk:
  - `chunk_index`
  - `page_start/page_end` (for PDF)
  - `title/section` if available

**4) Embed + store**
- For each chunk:
  - compute embedding
  - store `{doc_id, file_path/url, chunk_index, text_content, embedding, page_start/page_end, ...}`

### Citation strategy (how “cite page number” works)
- Retrieval returns top chunks with page metadata
- Final answer prompt instructs:
  - every factual claim must cite one chunk
  - citations reference `(DocName p.X)` using `page_start/page_end`

This is mostly a prompting + metadata problem; the DB enables it.

### New tools to add (recommended)
- `ingest_document` (file path or URL; returns doc_id + stats)
- `list_documents` (doc library)
- `forget_document` (delete by doc_id)

---

## 4) Web Tool Hardening (Caching + Provider Fallback + Backoff Telemetry)

### What problem this solves
Web research is inherently flaky:

- rate limits
- transient network errors
- bot detection
- provider blocks

You want predictable behavior and observability.

### Caching
Cache these layers:
- Search results (query → results)
- Fetched article text (url → extracted text)

Implementation:
- `~/.web-scout/cache/`
  - `search/<sha>.json`
  - `pages/<sha>.txt`

Cache entry fields:
- `key`, `createdAt`, `ttlSeconds`, `value`

Policy:
- Search: TTL 6–24 hours
- Page text: TTL 1–7 days

### Multi-provider fallback
Create a provider interface:
```ts
interface SearchProvider {
  name: string;
  search(query: string): Promise<WebSearchResult[]>;
}
```

Implement providers:
- DuckDuckGo HTML (current)
- Brave Search API / SerpAPI (optional, requires keys)
- Wikipedia API (specialized fallback)

Router logic:
- try providers in order
- if fail → next
- log failures in telemetry

### Rate-limit / backoff telemetry
Wrap all fetch calls:
- track:
  - status codes
  - latency
  - retries
  - provider used
  - bytes read

Write metrics as JSONL:
- `~/.web-scout/telemetry.jsonl`

This makes it easy to later build a dashboard.

---

## 5) UX: Tool-call Cards, Cancel/Stop, Dry-run Mode

### Tool-call cards
Goal: show *useful* tool transparency without dumping raw tool output.

Approach:
- In `runAgentTurn`, emit events:
  - `onToolStart(name, argsSummary)`
  - `onToolEnd(name, resultSummary, ok)`
- In `App.tsx`, render a compact card line:
  - `[Tool] search_web("...") → 6 results`
  - expand on demand (optional)

This is better than showing raw HTML/text dumps.

### Cancel/Stop
Add an abort signal:
- UI:
  - user can type `/stop` while agent is processing
  - or handle Ctrl+C once to cancel the current turn (not exit)
- Runner:
  - `runAgentTurn(messages, { signal })`
  - propagate to:
    - fetch tools (AbortController)
    - Playwright navigation timeouts
    - child_process exec (kill)

### Dry-run mode (safety + trust building)
When enabled (CLI flag `--dry-run` or `/dry-run on`):
- `execute_command`: do not run; print planned command + why it’s needed; ask confirm
- `write_to_file`: show file diff/preview; ask confirm

Implementation:
- store dry-run state in UI
- pass it into system tool executor
- allow “approve all for this session” toggle

---

## Suggested implementation order
If you want this to land smoothly:

1) Persistent permissions + audit log (improves safety + UX immediately)
2) Scheduler refactor into `src/scheduler/*` + `/tasks` UI (big reliability win)
3) Document ingestion pipeline (unlocks “cite page” and real knowledge base)
4) Web caching + fallback providers (stability + speed)
5) Tool cards + stop/dry-run (polish + trust)

---

## Notes specific to this repo
- You already have a Shield check pattern in `src/tools/systemTools.ts`; persistent permissions should plug into that same decision point.
- Your memory DB and embeddings model are already in place (`src/memory/retrieval.ts` uses `text-embedding-3-small`), so ingestion is mostly parsing + chunking + metadata + schema upgrade.
- The scheduler currently lives in the UI polling loop; extracting it into a module will make cron + timezone + missed-run policy much easier to reason about and test.

