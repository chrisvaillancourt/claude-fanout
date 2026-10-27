# fanout

A Claude Code mod that gives the model two tools for bulk, independent, tool-free jobs: run the same instruction over many items, or pick a label for each item from a fixed set. Each item is one small completion on a cheap model (Haiku 5.5 by default), run in parallel inside a single tool call, instead of one subagent per item.

A subagent starts by loading a system prompt, tool schemas, CLAUDE.md and memory before it reads the item: tens of thousands of tokens for a default Haiku subagent, several thousand for a stripped-down one. A completion here carries only the shared instructions and one item, so a classification costs a few hundred tokens. The tool result reports the tokens it used, so you can check that against your own numbers.

## Behavior

- **`mcp__fanout__complete`**: one instruction applied to each item. Replies are free text, or JSON checked against a small JSON Schema subset you pass in.
- **`mcp__fanout__classify`**: one label per item from a fixed list (2 to 50 labels), with an optional one-sentence reason (cut to 300 characters, marked with …). The reply's first line must name a label: an exact match wins, then a match ignoring case, then one ignoring markdown and punctuation; a loose match that fits two labels fails the item. With `reason: true`, a reply that gives a label but no reason is invalid and is retried once.
- Both are for items that are independent and self-contained, get the same instructions, and need no tools, files or knowledge of the other items. They are not for work that needs repository access, multi-step reasoning, or comparing items with each other.
- Every request opens with the same text (framing, your instructions, the output format), marked for the prompt cache; the item follows. Item text is framed as data to work on, never instructions to follow.
- Up to `concurrency` requests run at once, shared across every call in the session, main conversation and subagents alike. A call never waits for a free slot: it always keeps one request of its own going, so when several calls run together the session can briefly have one request per extra call above the cap. (Waiting would count against the engine's 10-second hook budget and get the call refused.)
- A failed item (API error, timeout, empty reply, a label not in the list, JSON that fails the schema) is reported as failed for that item; the rest of the call goes on. Each item is retried at most once. Errors that won't clear on retry (authentication, billing, invalid request, unknown model) are not retried. Pressing Esc cancels the call: running requests are cut, unstarted items are reported as `cancelled`.
- Above the limits (`maxItems`, `maxItemChars`, a model not in `models`, an unsupported schema keyword, duplicate ids or labels) the call is refused before any request is made. Nothing is truncated silently.
- The result is a compact list: one line per item. JSON results are always shown serialized, so the string `"null"` and the value `null` stay distinct; text results are shown raw unless a newline, tab or leading quote makes them ambiguous, in which case they are shown as a JSON string. If it would exceed `inlineResultChars`, the full results go to a JSONL file under `$TMPDIR/claude-fanout/<session id>/` and the result gives the path, the counts and the failed items. Reading that file may raise a permission prompt, since it is outside the project.
- Every result ends with the counts (ok, failed, retried), the model, the time taken and the token usage from every attempt, failed ones included: input, cache read, cache write, output, and tokens per item.

### What it costs

Every item is at least one request to the configured model, billed to your Claude Code credentials: up to `maxItems × 2` requests per call when every item is retried. Each request is the shared block plus one item plus the reply (`maxTokens` caps it; classify uses a smaller cap). These completions are not part of the session's own cost total in `/cost`; `/fanout` shows what they used.

Measured on Claude Code 2.1.310 with Haiku 5.5: classifying 10 short messages with reasons took 10 requests and 3,562 tokens (356 per item, 1.6 s); extracting JSON from 3 sentences took 281 tokens per item.

The prompt cache. The shared block is marked for caching, so later items can read it at a tenth of the input price, but only when the block is longer than the model's cache minimum (on the order of a thousand tokens); short instructions are not cached and are paid in full on every item, as in the numbers above. Requests that start at the same time can't read each other's cache: in a live check, three parallel requests over a 13.6K-token block each wrote it, and only the requests after them read it. So when the shared block is 4,000 characters or longer, the first item runs alone and the rest start once it has answered, at the cost of one request's latency.

Tool loading. The two tools are deferred behind ToolSearch by default, so each request carries only their names until the model loads them (one ToolSearch call). Set `alwaysLoaded` to put both full schemas in every request instead: about 1,000 more input tokens per request (34,647 vs 35,643 on a one-word headless run), which makes the model more likely to reach for them unprompted. Deferred is the default because most sessions never call them, and those tokens would ride along on every request in the main conversation.

### What it never does

- Spawn subagents, fork the conversation, or change the session's model, system prompt or tool list per turn.
- Read files: items are passed inline in the tool call.
- Retry an item more than once, or retry errors that won't clear.

## Command

`/fanout [status|on|off]`: show this session's totals (calls, items, ok, failed, retried, tokens), or turn the tools on or off for this session. Off, calls are refused with a message saying so; on, the tools are registered if they weren't.

### Across a restart

Claude Code can move a session to a new process mid-turn (a background session does when the daemon upgrades Claude Code). The mod keeps two small records per session in its own store so that move doesn't undo it:

- The `/fanout on|off` override and the session totals are written to the store on every change. In the new process they're restored before the tools are registered, so `/fanout off` still holds and `/fanout status` keeps counting. `/clear` resets the totals as before (the override stays), and the record follows.
- While a call runs, its tool, item count, start time and the spend of its finished requests are recorded (the spend at most once a second) and removed when it ends. If the new process finds such a record, the call was cut off: its results are gone and it is not rerun. The log says so (`a restart cut off a fanout classify batch of 40 items after ~1200 tokens; its results were lost`), a toast points to the log, and its requests and tokens are added to the totals.

Records are pruned at session start: totals and overrides untouched for 30 days, call records older than 7 days.

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `enabled` | `true` | Register the tools in new sessions. Off, nothing is registered and nothing is added to the prompt. `/fanout on` registers them for one session. |
| `model` | `claude-haiku-5-5` | Model for each item, as a full model id. |
| `models` | `claude-haiku-5-5,claude-sonnet-5-5` | Comma-separated models a call may choose with its `model` field. The default `model` is always allowed. |
| `effort` | `low` | Effort for each request: `low`, `medium` or `high`. Dropped for models that take none. |
| `concurrency` | `8` | Requests in flight at once across the session (1 to 16), and at most this many for one call. Each running call may still keep one request going above the cap. |
| `maxItems` | `200` | Most items one call may carry (1 to 1000). |
| `maxItemChars` | `8000` | Longest item, in characters (100 to 100000). |
| `maxInstructionChars` | `8000` | Longest shared block, in characters: the instructions plus the output format (the JSON schema or the label list), which every request repeats. |
| `maxTokens` | `1024` | Reply cap for `complete` items (16 to 8192). Classify uses 128, or 256 with reasons. |
| `timeoutSeconds` | `60` | Time limit for each request (5 to 600). |
| `inlineResultChars` | `12000` | Largest result returned inline; above it the results are written to a file. |
| `alwaysLoaded` | `false` | Put the tools' schemas in every request instead of behind ToolSearch. |

## Limitations

- Items are passed inline, so their text enters the conversation once, as the tool call's input. There is no file input: a tool that reads files on the model's behalf would sidestep the session's Read permissions. A later version could add it, gated on the session allowing a Read of the same path (`$.tool.check`).
- JSON output is prompted and then checked locally against a schema subset (`type`, `properties`, `required`, `items`, `enum`, `additionalProperties: false`, `description`); other keywords are refused. Object members are checked as own JSON members (`constructor` or `__proto__` keys get no special treatment) and `enum` compares JSON structurally (object member order doesn't matter). There is no forced-tool structured output.
- No per-label confidence: the model names a label, it doesn't give probabilities.
- No background runs or resume: a call runs to the end inside its tool call, and Esc cancels it. A restart that moves the session to a new process loses the call's results (they're reported, not rerun), and up to a second of its spend may be missing from the totals. A hot reload taken after `/clear` in the same process may misread a call still running as cut off. On Claude Code 2.1.310 a hot reload (saving a file in a `--plugin-dir` folder) was held until the turn ended, so the running call completed; `/reload-plugins` typed during the call ran after the turn.
- No `jevify`-style keyword or frozen-rubric workflow; the tool descriptions carry the guidance.
- Retries are immediate (queued behind the remaining items), with no backoff, so a sustained rate limit fails items rather than waiting.
- The spill file is written with default permissions under the temp directory and is not cleaned up by the mod. One file holds at most 4 MiB (the engine's write limit); a bigger result is reported as a failed spill with the rows that fit inline.
- Cancelling with Esc was checked in a live interactive session on 2.1.310: Esc 10 s into a 40-item call aborted the eight running requests, the 32 unstarted or cut items came back as `cancelled` (counted under failed in the summary line), and the session went on normally. Esc pressed while the model is still writing the call's input cancels the call before the tool runs.

## Install

```sh
claude plugin marketplace add chrisvaillancourt/claude-fanout
claude plugin install fanout@fanout --scope user
```

Or from inside Claude Code: `/plugin install fanout --marketplace chrisvaillancourt/claude-fanout`.

To work on it locally, add your clone as the marketplace instead (`claude plugin marketplace add <path to clone>`). The plugin is read from that folder; after editing, run `/reload-plugins`.

## Update

```sh
claude plugin marketplace update fanout
claude plugin update fanout@fanout
```

Then restart Claude Code.

## Develop

```sh
scripts/check.sh
```

It runs `claude plugin validate .`, `claude plugin test .` and a TypeScript check. Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/).

## License

MIT. See [LICENSE](LICENSE).
