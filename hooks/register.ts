import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelCompleteResult, Register } from 'claude-code'

import {
  EMPTY_SESSION,
  USAGE,
  ZERO,
  addUsage,
  buildPrompt,
  configFrom,
  countRows,
  describeFailure,
  formatResult,
  isActive,
  isRetryable,
  parseArgs,
  parseReply,
  shouldWarm,
  statusOf,
  statusText,
  totalTokens,
  validateClassify,
  validateComplete,
} from './policy'
import type { Failure, Job, Row, Run } from './policy'
import type { Config, Usage } from '../types'

const NAME = 'fanout'
const COMPLETE = 'mcp__fanout__complete'
const CLASSIFY = 'mcp__fanout__classify'

// Change the shape tag when Session's fields change: a value an older version
// stored (it outlives a hot reload) then reads as EMPTY_SESSION instead of breaking.
const sessionAtom = atom({ plugin: 'fanout', key: 'session' } as const, EMPTY_SESSION, { shape: 'session-2' })

// Module variables reset on a hot reload; register and session.start run
// again then, and the engine aborts any completion still running.
let config: Config = configFrom({})
let registered = false

// One limiter for the whole session: every call, main conversation and subagents.
let inFlight = 0
const waiting: (() => void)[] = []

function acquire(): Promise<void> {
  if (inFlight < config.concurrency) {
    inFlight++
    return Promise.resolve()
  }
  return new Promise(resolve => waiting.push(resolve))
}

function release() {
  const nextWaiter = waiting.shift()
  if (nextWaiter) nextWaiter()
  else inFlight--
}

/** Best effort: reporting must never throw out of a hook. */
function log($: EngineInterface, text: string) {
  try {
    $.ui.log(`${NAME}: ${text}`)
  } catch {
    // nothing to do
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

/** Runs every item of `job` through the shared limiter; each item settles to exactly one row. */
async function runJob($: EngineInterface, job: Job, signal: AbortSignal): Promise<Run> {
  const started = Date.now()
  const rows: (Row | undefined)[] = job.items.map(() => undefined)
  const attempts = job.items.map(() => 0)
  const queue = job.items.map((_, i) => i)
  let usage: Usage = ZERO
  let requests = 0

  // `once`: take one item and stop (the warm-up request).
  const worker = async (once = false) => {
    for (let taken = 0; !(once && taken > 0); taken++) {
      const i = queue.shift()
      if (i === undefined) return
      await acquire()
      try {
        if (signal.aborted) {
          rows[i] = { id: job.items[i]!.id, ok: false, error: 'cancelled', attempts: attempts[i]! }
          continue
        }
        const item = job.items[i]!
        const p = buildPrompt(job, item)
        attempts[i]!++
        requests++
        let r: ModelCompleteResult
        try {
          r = await $.model.complete(
            { model: job.model, system: p.system, prompt: p.prompt, maxTokens: job.maxTokens, effort: config.effort, timeoutMs: config.timeoutMs },
            { signal },
          )
        } catch (err) {
          // The engine refused to send it (a blocked model, a bad cap): no retry will help.
          rows[i] = { id: item.id, ok: false, error: `refused: ${err instanceof Error ? err.message : String(err)}`, attempts: attempts[i]! }
          continue
        }
        usage = addUsage(usage, r.usage)
        let failure = failureOf(r, signal.aborted)
        if (r.isAnswered) {
          const parsed = parseReply(job, r.text)
          if (parsed.ok) {
            rows[i] = parsed.reason === undefined
              ? { id: item.id, ok: true, value: parsed.value, attempts: attempts[i]! }
              : { id: item.id, ok: true, value: parsed.value, reason: parsed.reason, attempts: attempts[i]! }
            continue
          }
          failure = { kind: 'invalid', error: parsed.error }
        }
        if (failure && isRetryable(failure) && attempts[i]! < 2 && !signal.aborted) {
          queue.push(i)
          continue
        }
        rows[i] = { id: item.id, ok: false, error: describeFailure(failure ?? { kind: 'cancelled' }), attempts: attempts[i]! }
      } finally {
        release()
      }
    }
  }

  // Parallel cold requests each write the cache; one request first lets the rest read it.
  if (shouldWarm(job)) await worker(true)
  await Promise.all(Array.from({ length: Math.min(config.concurrency, job.items.length) }, () => worker()))
  const done = rows.map((r, i) => r ?? { id: job.items[i]!.id, ok: false as const, error: 'cancelled', attempts: attempts[i]! })
  return { tool: job.tool, model: job.model, ms: Date.now() - started, requests, usage, rows: done }
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

  const run = await runJob($, checked.job, signal)
  const c = countRows(run.rows)
  try {
    await update($, sessionAtom, s => ({
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
  log($, `${tool} ${statusOf(c)}: ${c.items} items, ${c.ok} ok, ${c.failed} failed, ${c.retried} retried; ` +
    `${run.requests} requests, ${totalTokens(run.usage)} tokens (${run.usage.input_tokens} in, ${run.usage.cache_read_input_tokens} cache read, ` +
    `${run.usage.cache_creation_input_tokens} cache write, ${run.usage.output_tokens} out), ${run.model}, ${run.ms}ms`)
  return { result: await finish($, run) }
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
    if (isActive(config, await read($, sessionAtom))) await registerTools($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // /clear starts a new conversation in the same process: its totals start at zero.
    if (e.reason === 'clear') await update($, sessionAtom, s => ({ ...EMPTY_SESSION, mode: s.mode }))
    return next(e)
  })

  on('command.run', { command: 'fanout' }, async ($, e) => {
    const cmd = parseArgs(e.args)
    if (cmd.kind === 'help') return { text: cmd.error ? `${cmd.error}\n${USAGE}` : USAGE }
    if (cmd.kind === 'set') {
      await update($, sessionAtom, s => ({ ...s, mode: cmd.mode }))
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
