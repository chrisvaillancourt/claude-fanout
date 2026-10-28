import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelCompleteResult, Register } from 'claude-code'

import {
  EMPTY_SESSION,
  RUN_FLUSH_MS,
  RUN_PREFIX,
  RUN_TTL_MS,
  SESSION_PREFIX,
  SESSION_TTL_MS,
  USAGE,
  ZERO,
  addUsage,
  buildPrompt,
  configFrom,
  countRows,
  describeFailure,
  formatResult,
  isActive,
  isEmptySession,
  isStale,
  lostRunNotice,
  runsFromRecord,
  sessionFromRecord,
  withLostRuns,
  isRetryable,
  parseArgs,
  canStart,
  parseReply,
  shouldWarm,
  statusOf,
  statusText,
  totalTokens,
  validateClassify,
  validateComplete,
} from './policy'
import type { Failure, Job, Row, Run } from './policy'
import type { Config, RunEntry, RunRecord, Session, SessionRecord, Usage } from '../types'

const COMPLETE = 'mcp__fanout__complete'
const CLASSIFY = 'mcp__fanout__classify'

// Change the shape tag when Session's fields change: a value an older version
// stored (it outlives a hot reload) then reads as EMPTY_SESSION instead of breaking.
const sessionAtom = atom({ plugin: 'fanout', key: 'session' } as const, EMPTY_SESSION, { shape: 'session-2' })
// False until session.start has run in this process for this session: $.state survives a
// hot reload but not a new process, so false at session.start means a new process.
const liveAtom = atom({ plugin: 'fanout', key: 'live' } as const, false)

// Module variables reset on a hot reload; register and session.start run
// again then, and the engine aborts any completion still running.
let config: Config = configFrom({})
let registered = false

// Requests in flight across the session: every call, main conversation and subagents.
// No call ever waits on this: a hook's wait on a local promise is its own time and the
// engine ends a hook after 10 s of it. While a `$.model.complete` of the call is in flight
// the hook's clock is stopped, so each call keeps at least one request going while it has
// work, and the session cap only limits how many more it may add (canStart).
let sessionInFlight = 0
// Each running call's pump, woken when another call's request ends and frees a slot.
const pumps = new Set<() => void>()

// Batches in flight in this process, by run number, with the session each belongs to.
// `run/<session id>` in $.store mirrors them so a new process can report the ones it lost.
const liveRuns = new Map<number, { sid: string; entry: RunEntry }>()
let nextRunId = 0
// When each session's run record was last written, for the once-a-second throttle.
const runFlushedAt = new Map<string, number>()
// Store writes go one at a time, in order, so a late progress write can't land after the delete.
let storeQueue: Promise<void> = Promise.resolve()

/** Best effort: reporting must never throw out of a hook. */
function log($: EngineInterface, text: string) {
  try {
    $.ui.log(text)
  } catch {
    // nothing to do
  }
}

/** Runs `task` after every store write queued before it. Best effort: a failure is swallowed. */
function queueStore(task: () => Promise<void>): Promise<void> {
  storeQueue = storeQueue.then(task).catch(() => undefined)
  return storeQueue
}

async function sessionIdOrNull($: EngineInterface): Promise<string | null> {
  try {
    return await $.session.id()
  } catch {
    return null
  }
}

/** Writes the session's override and totals through to `session/<id>`, or drops the record when there's nothing to keep. */
function saveSession($: EngineInterface, s: Session): Promise<void> {
  return queueStore(async () => {
    const sid = await $.session.id()
    if (isEmptySession(s)) {
      await $.store.delete(SESSION_PREFIX + sid)
      return
    }
    const record: SessionRecord = { ...s, at: await $.clock.now() }
    await $.store.set(SESSION_PREFIX + sid, record)
  })
}

/**
 * Marks this session as running in this process. /clear starts a session id with empty
 * state and no session.start, so session.start alone can't be what sets it.
 */
async function markLive($: EngineInterface) {
  try {
    await update($, liveAtom, () => true)
  } catch {
    // Best effort.
  }
}

/** Updates the session atom, marks the session live, and writes the result through. */
async function changeSession($: EngineInterface, change: (s: Session) => Session): Promise<void> {
  const next = await update($, sessionAtom, change)
  await markLive($)
  await saveSession($, next)
}

/** Writes `run/<sid>` from this process's batches in flight for `sid`; deletes it when none are left. */
async function writeRuns($: EngineInterface, sid: string) {
  const runs = [...liveRuns.values()].filter(r => r.sid === sid).map(r => r.entry)
  if (runs.length === 0) {
    runFlushedAt.delete(sid)
    await $.store.delete(RUN_PREFIX + sid)
    return
  }
  const at = await $.clock.now()
  runFlushedAt.set(sid, at)
  const record: RunRecord = { at, runs }
  await $.store.set(RUN_PREFIX + sid, record)
}

function flushRuns($: EngineInterface, sid: string): Promise<void> {
  return queueStore(() => writeRuns($, sid))
}

/** A request of a batch finished: write its progress, at most once every RUN_FLUSH_MS. */
function flushRunsThrottled($: EngineInterface, sid: string): void {
  void queueStore(async () => {
    const last = runFlushedAt.get(sid)
    if (last !== undefined && (await $.clock.now()) - last < RUN_FLUSH_MS) return
    await writeRuns($, sid)
  })
}

/**
 * In a new process (session.start with `live` unset): restore the override and totals the
 * old process wrote, and report any batch it was running, whose results are gone. Its spend
 * is added to the totals; it is not rerun.
 */
async function recover($: EngineInterface) {
  const sid = await sessionIdOrNull($)
  if (sid === null) return
  let saved: Session | null = null
  let lost: RunEntry[] = []
  try {
    saved = sessionFromRecord(await $.store.get(SESSION_PREFIX + sid))
    const runRecord = await $.store.get(RUN_PREFIX + sid)
    if (runRecord !== undefined) {
      lost = runsFromRecord(runRecord) ?? []
      await $.store.delete(RUN_PREFIX + sid)
    }
  } catch {
    // Best effort: a broken store leaves the session as a fresh one.
  }
  if (!saved && lost.length === 0) return
  try {
    await changeSession($, s => withLostRuns(isEmptySession(s) && saved ? saved : s, lost))
  } catch {
    // Totals are reporting.
  }
  if (lost.length === 0) return
  for (const r of lost) log($, lostRunNotice(r))
  try {
    $.ui.toast(lost.length === 1 ? 'a restart cut off a fanout batch; see the log' : `a restart cut off ${lost.length} fanout batches; see the log`)
  } catch {
    // Best effort.
  }
}

/** Drops this plugin's session and run records past their TTL (or unreadable), whatever session left them. */
async function pruneRecords($: EngineInterface) {
  try {
    const now = await $.clock.now()
    for (const key of await $.store.keys()) {
      const ttl = key.startsWith(SESSION_PREFIX) ? SESSION_TTL_MS : key.startsWith(RUN_PREFIX) ? RUN_TTL_MS : null
      if (ttl === null) continue
      const v = await $.store.get(key)
      const readable = key.startsWith(SESSION_PREFIX) ? sessionFromRecord(v) !== null : runsFromRecord(v) !== null
      if (!readable || isStale(v, now, ttl)) await $.store.delete(key)
    }
  } catch {
    // Best effort.
  }
}

const DESCRIBE_COMPLETE =
  'Run one instruction over many independent text items in parallel on a cheap model: one short completion per item, ' +
  'with no tools, files or conversation history. Use when every item is self-contained, gets the same instructions, ' +
  'and needs nothing from the others (summarize, extract, rewrite, tag). Not for work that needs files, commands or ' +
  'comparing items. Returns one line per item and the tokens used; failed items are listed, never dropped. ' +
  'For picking a label per item, use classify.'

const DESCRIBE_CLASSIFY =
  'Pick one label per item from a fixed list, in parallel on a cheap model: one short completion per item, with no ' +
  'tools, files or conversation history. Use for bulk yes/no or category sorting of self-contained text items under ' +
  'one rubric. Not for judgments that need files, commands or comparing items; spot-check a sample of the labels. ' +
  'Returns id<TAB>label lines and the tokens used.'

function baseProperties(c: Config): Record<string, unknown> {
  return {
    instructions: { type: 'string', description: 'The task, the same for every item. Say exactly what to produce.' },
    items: { type: 'array', items: { type: 'string' }, description: `One self-contained text per job, with all the context it needs. At most ${c.maxItems}, each up to ${c.maxItemChars} characters.` },
    ids: { type: 'array', items: { type: 'string' }, description: 'Optional id for each item, in the same order. Default 1..n.' },
    model: { type: 'string', enum: c.models, description: `Default ${c.model}.` },
  }
}

function completeSchema(c: Config): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      ...baseProperties(c),
      format: { type: 'string', enum: ['text', 'json'], description: 'text (default), or json to get one JSON value per item.' },
      schema: { type: 'object', description: 'With format json: a JSON Schema each reply must match (type, properties, required, items, enum, additionalProperties).' },
    },
    required: ['instructions', 'items'],
    additionalProperties: false,
  }
}

function classifySchema(c: Config): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      ...baseProperties(c),
      labels: { type: 'array', items: { type: 'string' }, description: 'The labels to choose from (2 to 50). Define each one in instructions.' },
      reason: { type: 'boolean', description: 'Also return a one-sentence reason per item. Default false.' },
    },
    required: ['instructions', 'labels', 'items'],
    additionalProperties: false,
  }
}

async function registerTools($: EngineInterface) {
  const isDeferred = !config.alwaysLoaded
  await $.tool.register({ name: 'complete', description: DESCRIBE_COMPLETE, inputSchema: completeSchema(config), isDeferred })
  await $.tool.register({ name: 'classify', description: DESCRIBE_CLASSIFY, inputSchema: classifySchema(config), isDeferred })
  registered = true
}

function failureOf(r: ModelCompleteResult, cancelled: boolean): Failure | null {
  if (r.isAnswered) return null
  if (r.reason === 'api-error') return { kind: 'api-error', error: r.error, status: r.status }
  if (r.reason === 'empty-reply') return { kind: 'empty-reply' }
  return cancelled ? { kind: 'cancelled' } : { kind: 'timeout' }
}

type Outcome = { row: Row } | { retry: true }

/** One attempt at item `i`: a row when the item is settled, or `retry` to queue it again. */
async function attempt($: EngineInterface, job: Job, i: number, tries: number, signal: AbortSignal, spend: (u: Usage) => void): Promise<Outcome> {
  const item = job.items[i]!
  const p = buildPrompt(job, item)
  let r: ModelCompleteResult
  try {
    r = await $.model.complete(
      { model: job.model, system: p.system, prompt: p.prompt, maxTokens: job.maxTokens, effort: config.effort, timeoutMs: config.timeoutMs },
      { signal },
    )
  } catch (err) {
    // The engine refused to send it (a blocked model, a bad cap): no retry will help.
    return { row: { id: item.id, ok: false, error: `refused: ${err instanceof Error ? err.message : String(err)}`, attempts: tries } }
  }
  spend(r.usage)
  let failure = failureOf(r, signal.aborted)
  if (r.isAnswered) {
    const parsed = parseReply(job, r.text)
    if (parsed.ok) {
      return {
        row: parsed.reason === undefined
          ? { id: item.id, ok: true, value: parsed.value, attempts: tries }
          : { id: item.id, ok: true, value: parsed.value, reason: parsed.reason, attempts: tries },
      }
    }
    failure = { kind: 'invalid', error: parsed.error }
  }
  if (failure && isRetryable(failure) && tries < 2 && !signal.aborted) return { retry: true }
  return { row: { id: item.id, ok: false, error: describeFailure(failure ?? { kind: 'cancelled' }), attempts: tries } }
}

/** Runs every item of `job`; each item settles to exactly one row. Never waits outside a `$` call. */
function runJob($: EngineInterface, job: Job, signal: AbortSignal, onRequest: (u: Usage) => void = () => undefined): Promise<Run> {
  return new Promise(resolve => {
    const started = Date.now()
    const rows: (Row | undefined)[] = job.items.map(() => undefined)
    const attempts = job.items.map(() => 0)
    const queue = job.items.map((_, i) => i)
    let usage: Usage = ZERO
    let requests = 0
    let callInFlight = 0
    // Parallel cold requests each write the cache; one request first lets the rest read it.
    let warming = shouldWarm(job)
    let settled = false

    const spend = (u: Usage) => {
      usage = addUsage(usage, u)
      onRequest(u)
    }

    const pump = () => {
      if (settled) return
      if (signal.aborted) {
        for (const i of queue) rows[i] = { id: job.items[i]!.id, ok: false, error: 'cancelled', attempts: attempts[i]! }
        queue.length = 0
      }
      while (queue.length > 0 && canStart(callInFlight, sessionInFlight, warming ? 1 : config.concurrency, config.concurrency)) {
        const i = queue.shift()!
        attempts[i]!++
        requests++
        callInFlight++
        sessionInFlight++
        void attempt($, job, i, attempts[i]!, signal, spend)
          .then(
            o => {
              if ('row' in o) rows[i] = o.row
              else queue.push(i)
            },
            err => {
              rows[i] = { id: job.items[i]!.id, ok: false, error: `failed: ${err instanceof Error ? err.message : String(err)}`, attempts: attempts[i]! }
            },
          )
          .finally(() => {
            callInFlight--
            sessionInFlight--
            warming = false
            pump()
            for (const other of [...pumps]) if (other !== pump) other()
          })
      }
      if (queue.length === 0 && callInFlight === 0) {
        settled = true
        pumps.delete(pump)
        const done = rows.map((r, i) => r ?? { id: job.items[i]!.id, ok: false as const, error: 'cancelled', attempts: attempts[i]! })
        resolve({ tool: job.tool, format: job.format, model: job.model, ms: Date.now() - started, requests, usage, rows: done })
      }
    }

    pumps.add(pump)
    pump()
  })
}

/** The result text, spilling the full rows to a file when they don't fit. */
async function finish($: EngineInterface, run: Run): Promise<string> {
  const f = formatResult(run, config.inlineResultChars)
  if (!f.spill) return f.text
  let path = ''
  try {
    const tmp = ((await $.env.get('TMPDIR')) || '/tmp').replace(/\/+$/, '')
    const sid = (await $.session.id()).replace(/[^\w-]/g, '_')
    const runId = `${run.tool}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    path = `${tmp}/claude-fanout/${sid}/${runId}.jsonl`
    await $.fs.write(path, f.jsonl)
  } catch (err) {
    return f.unspilledText(err instanceof Error ? err.message : String(err))
  }
  return f.spilledText(path)
}

async function serve($: EngineInterface, e: Record<string, unknown>, signal: AbortSignal, tool: 'complete' | 'classify') {
  const session = await read($, sessionAtom)
  if (!isActive(config, session)) return { deny: 'fanout is off for this session (/fanout on turns it back on).' }
  const checked = tool === 'complete' ? validateComplete(e, config) : validateClassify(e, config)
  if (!checked.ok) return { deny: `fanout ${tool} refused, nothing was sent: ${checked.error}` }

  const job = checked.job
  const sid = await sessionIdOrNull($)
  const runId = ++nextRunId
  const entry: RunEntry = { tool, items: job.items.length, startedAt: 0, requests: 0, usage: ZERO }
  let run: Run
  try {
    if (sid !== null) {
      try {
        entry.startedAt = await $.clock.now()
      } catch {
        // Best effort: the record is still useful without its start time.
      }
      await markLive($)
      liveRuns.set(runId, { sid, entry })
      await flushRuns($, sid)
    }
    run = await runJob($, job, signal, u => {
      entry.requests++
      entry.usage = addUsage(entry.usage, u)
      if (sid !== null) flushRunsThrottled($, sid)
    })
    await countRun($, run)
  } finally {
    // Forgotten after the totals are written: a restart in between counts the spend twice rather than not at all.
    liveRuns.delete(runId)
    if (sid !== null) await flushRuns($, sid)
  }
  const c = countRows(run.rows)
  log($, `${tool} ${statusOf(c)}: ${c.items} items, ${c.ok} ok, ${c.failed} failed, ${c.retried} retried; ` +
    `${run.requests} requests, ${totalTokens(run.usage)} tokens (${run.usage.input_tokens} in, ${run.usage.cache_read_input_tokens} cache read, ` +
    `${run.usage.cache_creation_input_tokens} cache write, ${run.usage.output_tokens} out), ${run.model}, ${run.ms}ms`)
  return { result: await finish($, run) }
}

/** Adds a finished call to the session totals. */
async function countRun($: EngineInterface, run: Run) {
  const c = countRows(run.rows)
  try {
    await changeSession($, s => ({
      ...s,
      calls: s.calls + 1,
      items: s.items + c.items,
      ok: s.ok + c.ok,
      failed: s.failed + c.failed,
      retried: s.retried + c.retried,
      requests: s.requests + run.requests,
      usage: addUsage(s.usage, run.usage),
    }))
  } catch {
    // Totals are reporting; the result still goes back.
  }
}

export const register: Register = (on, options) => {
  config = configFrom(options)
  registered = false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'fanout',
      description: 'Show fanout totals for this session, or turn its tools on or off',
      argumentHint: '[status|on|off]',
    })
    // A new process: put back what the old one kept, before deciding on the tools.
    let isLive = true
    try {
      isLive = await read($, liveAtom)
    } catch {
      // Unknown: treat as a hot reload, which never reports.
    }
    if (!isLive) {
      await recover($)
      await markLive($)
    }
    await pruneRecords($)
    if (isActive(config, await read($, sessionAtom))) await registerTools($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // /clear starts a new conversation in the same process: its totals start at zero.
    // Not written to the store: here $.session.id() is the ending session's, whose record
    // should stay as it was; the new session id writes its own record on its first change.
    if (e.reason === 'clear') await update($, sessionAtom, s => ({ ...EMPTY_SESSION, mode: s.mode }))
    return next(e)
  })

  on('command.run', { command: 'fanout' }, async ($, e) => {
    const cmd = parseArgs(e.args)
    if (cmd.kind === 'help') return { text: cmd.error ? `${cmd.error}\n${USAGE}` : USAGE }
    if (cmd.kind === 'set') {
      await changeSession($, s => ({ ...s, mode: cmd.mode }))
      if (cmd.mode === 'on' && !registered) await registerTools($)
    }
    return { text: statusText(config, await read($, sessionAtom)) }
  })

  // The tools are this plugin's own: nothing beneath answers them, so a failure here
  // answers with a refusal rather than falling through.
  on('tool.call', { tool: COMPLETE }, ($, e, next) => serve($, e, next.signal, 'complete'))
    .catch(() => ({ deny: 'fanout complete failed inside the plugin; no result.' }))
  on('tool.call', { tool: CLASSIFY }, ($, e, next) => serve($, e, next.signal, 'classify'))
    .catch(() => ({ deny: 'fanout classify failed inside the plugin; no result.' }))
}
