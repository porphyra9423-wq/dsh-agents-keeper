/**
 * `dsh-agents-keeper` — keeps a workspace `AGENTS.md` trustworthy.
 *
 * The built-in `agent-instructions` loader already *reads* AGENTS.md into every
 * session (and bounds it by bytes, without ever summarizing it). This plugin
 * covers the half that loader deliberately leaves out:
 *
 *  1. **Detect** — a cheap fingerprint of the working tree (git porcelain, or
 *     mtimes without git) plus the last analysed state, so "the project changed"
 *     is a fact rather than a guess.
 *  2. **Draft** — an update or a compact rewrite is produced by a *subagent*
 *     into `$DSH_HOME/agents-keeper/.../pending.md`. The main conversation only
 *     pays for one line in and one report out, and AGENTS.md is never touched.
 *  3. **Preview + apply** — `agents_md_apply` shows a unified diff, backs the old
 *     file up first, then writes atomically. `agents_md_revert` restores a
 *     backup.
 *
 * Everything the plugin owns lives under `$DSH_HOME/agents-keeper/`, keyed by the
 * project root, so the user's repository stays clean.
 *
 * @module dsh-agents-keeper
 */

import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

/** Cordis plugin identity used in diagnostics. */
export const name = 'agents-keeper'

/** Services that must exist before this plugin activates. */
export const inject = ['tools', 'commands']

const run = promisify(execFile)

const METHOD_FILE = fileURLToPath(new URL('./references/methodology.md', import.meta.url))

/** Directories never worth fingerprinting or diffing. */
const NOISE = new Set(['.git', '.svn', '.hg', 'node_modules', 'dist', 'build', 'out', 'target', '.venv', 'venv', '__pycache__', '.next', '.turbo', '.cache', 'coverage'])

/** User-facing config with types; the types double as the validator. */
const DEFAULTS = {
  /** Byte budget shared with the built-in loader; a bigger AGENTS.md is "too long". */
  maxBytes: 65536,
  /** Never propose more often than this. */
  minIntervalMinutes: 30,
  /** Fewer changed files than this is noise, not a reason to rewrite docs. */
  minChangedFiles: 3,
  /** Managed file name, relative to the project root. */
  targetFile: 'AGENTS.md',
  /** Subagent provider (the in-process `spawn` backend dsh-base mounts). */
  provider: 'spawn',
  /** Optional agent preset for the child; empty inherits the parent's. */
  agentPreset: '',
  /** Extra guidance appended to every child prompt. */
  note: '',
}

/**
 * Validate the row's config without a schema library.
 * @param raw - the loader-supplied config, possibly absent.
 * @returns the resolved config.
 */
function resolveConfig(raw) {
  if (raw === undefined || raw === null) return { ...DEFAULTS }
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('agents-keeper: config must be an object')
  const config = { ...DEFAULTS }
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(DEFAULTS, key)) throw new Error(`agents-keeper: unknown config field "${key}"`)
    if (typeof value !== typeof DEFAULTS[key]) {
      throw new Error(`agents-keeper: config field "${key}" must be a ${typeof DEFAULTS[key]}`)
    }
    config[key] = value
  }
  if (!Number.isFinite(config.maxBytes) || config.maxBytes < 1024) throw new Error('agents-keeper: maxBytes must be >= 1024')
  if (!Number.isFinite(config.minChangedFiles) || config.minChangedFiles < 1) throw new Error('agents-keeper: minChangedFiles must be >= 1')
  if (!Number.isFinite(config.minIntervalMinutes) || config.minIntervalMinutes < 0) throw new Error('agents-keeper: minIntervalMinutes must be >= 0')
  return config
}

/** Root of everything this plugin persists. */
function keeperHome() {
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'agents-keeper')
}

/** Stable per-project directory name. */
function projectKey(root) {
  return createHash('sha1').update(root.toLowerCase().split(sep).join('/')).digest('hex').slice(0, 16)
}

/**
 * Resolve the project root: the nearest ancestor holding `.git`, else the
 * directory itself. Mirrors the loader's default `projectRootMarkers`.
 * @param start - an absolute directory.
 * @returns the project root.
 */
function findProjectRoot(start) {
  let current = resolve(start)
  for (let depth = 0; depth < 40; depth++) {
    if (existsSync(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return resolve(start)
}

/** The managed file for a project root. */
function agentsFileFor(root, config) {
  return join(root, config.targetFile)
}

async function pathExists(p) {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

async function readTextFile(p) {
  return readFile(p, 'utf8')
}

/** Atomic replacement: write a sibling temp file, then rename over the target. */
async function writeFileAtomic(target, text) {
  await mkdir(dirname(target), { recursive: true })
  const tmp = `${target}.${randomUUID().slice(0, 8)}.tmp`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, target)
}

async function readJson(p, fallback) {
  try {
    return JSON.parse(await readFile(p, 'utf8'))
  } catch {
    return fallback
  }
}

async function writeJson(p, value) {
  await writeFileAtomic(p, `${JSON.stringify(value, null, 2)}\n`)
}

/** Everything the plugin keeps for one project. */
function projectPaths(root) {
  const dir = join(keeperHome(), 'projects', projectKey(root))
  return {
    dir,
    state: join(dir, 'state.json'),
    pending: join(dir, 'pending.md'),
    pendingMeta: join(dir, 'pending.json'),
    backups: join(dir, 'backups'),
    history: join(dir, 'history'),
  }
}

async function gitChangedFiles(root) {
  try {
    const inside = await run('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], { timeout: 8000, windowsHide: true })
    if (inside.stdout.trim() !== 'true') return undefined
    const status = await run('git', ['-C', root, 'status', '--porcelain=v1', '--untracked-files=normal'], { timeout: 12000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
    const files = []
    for (const line of status.stdout.split(/\r?\n/)) {
      if (line.trim().length === 0) continue
      const path = line.slice(3).trim()
      if (path.length === 0) continue
      // A rename shows as "old -> new"; keep the destination.
      const arrow = path.lastIndexOf(' -> ')
      files.push(arrow === -1 ? path : path.slice(arrow + 4))
    }
    return files
  } catch {
    return undefined
  }
}

/**
 * Fingerprint by mtime for repositories without git.
 * @param root - project root.
 * @param since - epoch ms; files newer than this count as changed.
 */
async function mtimeChangedFiles(root, since) {
  const changed = []
  const walk = async (dir, depth) => {
    if (depth > 6 || changed.length > 400) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (changed.length > 400) return
      if (NOISE.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      try {
        const info = await stat(full)
        if (info.mtimeMs > since) changed.push(relative(root, full).split(sep).join('/'))
      } catch {
        // A file that vanished mid-walk is simply not a change we can describe.
      }
    }
  }
  await walk(root, 0)
  return changed
}

/**
 * Collect the current fingerprint of a project.
 * @returns {{ source: 'git'|'mtime', files: string[] }}
 */
async function fingerprint(root, lastSyncAt) {
  const git = await gitChangedFiles(root)
  if (git !== undefined) return { source: 'git', files: git }
  const since = typeof lastSyncAt === 'number' ? lastSyncAt : Date.now() - 24 * 60 * 60 * 1000
  return { source: 'mtime', files: await mtimeChangedFiles(root, since) }
}

/** The state + status snapshot shared by the tools, the commands and the HTTP API. */
async function describe(root, config) {
  const paths = projectPaths(root)
  const file = agentsFileFor(root, config)
  const state = await readJson(paths.state, {})
  let text = ''
  let bytes = 0
  let mtimeMs = 0
  let exists = false
  try {
    const info = await stat(file)
    exists = info.isFile()
    mtimeMs = info.mtimeMs
    if (exists) {
      text = await readTextFile(file)
      bytes = Buffer.byteLength(text, 'utf8')
    }
  } catch {
    exists = false
  }

  const seen = await fingerprint(root, typeof state.lastSyncAt === 'number' ? state.lastSyncAt : undefined)
  const pendingMeta = await readJson(paths.pendingMeta, undefined)
  const pendingExists = await pathExists(paths.pending)
  const now = Date.now()
  const lastSyncAt = typeof state.lastSyncAt === 'number' ? state.lastSyncAt : undefined

  const reasons = []
  if (!exists) reasons.push('no-agents-file')
  if (seen.files.length >= config.minChangedFiles) reasons.push('working-tree-changed')
  if (lastSyncAt !== undefined && now - lastSyncAt < config.minIntervalMinutes * 60_000) reasons.push('recently-synced')
  if (lastSyncAt === undefined) reasons.push('never-synced')

  const stale = exists
    && seen.files.length >= config.minChangedFiles
    && (lastSyncAt === undefined || now - lastSyncAt >= config.minIntervalMinutes * 60_000)

  const backups = await listBackups(paths)

  return {
    projectRoot: root,
    agentsFile: file,
    exists,
    bytes,
    budgetBytes: config.maxBytes,
    overBudget: exists && bytes > config.maxBytes,
    hash: exists ? createHash('sha1').update(text).digest('hex').slice(0, 12) : '',
    mtimeMs: Math.round(mtimeMs),
    lastSyncAt: lastSyncAt === undefined ? 0 : lastSyncAt,
    lastSyncIso: lastSyncAt === undefined ? '' : new Date(lastSyncAt).toISOString(),
    changes: { source: seen.source, count: seen.files.length, files: seen.files.slice(0, 40), truncated: seen.files.length > 40 },
    stale,
    reasons,
    pending: pendingExists
      ? {
        exists: true,
        mode: typeof pendingMeta?.mode === 'string' ? pendingMeta.mode : 'update',
        createdAt: typeof pendingMeta?.createdAt === 'number' ? pendingMeta.createdAt : 0,
        childId: typeof pendingMeta?.childId === 'string' ? pendingMeta.childId : '',
      }
      : { exists: false },
    backups,
    stateDir: paths.dir,
    text,
  }
}

async function listBackups(paths) {
  try {
    const names = await readdir(paths.backups)
    return names.filter(entry => entry.endsWith('.md')).sort().reverse().slice(0, 20)
  } catch {
    return []
  }
}

/**
 * Line diff (LCS) with unified-style hunks.
 * @param before - old text.
 * @param after - new text.
 * @param context - context lines per hunk.
 * @returns a printable diff, or '' when identical.
 */
function unifiedDiff(before, after, context = 3) {
  if (before === after) return ''
  const a = before.split('\n')
  const b = after.split('\n')
  const n = a.length
  const m = b.length
  if (n * m > 6_000_000) {
    return `--- AGENTS.md (${n} lines)\n+++ proposal (${m} lines)\n(too large for a line diff: ${n} -> ${m} lines)`
  }
  const table = new Uint32Array((n + 1) * (m + 1))
  const at = (i, j) => i * (m + 1) + j
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[at(i, j)] = a[i] === b[j]
        ? table[at(i + 1, j + 1)] + 1
        : Math.max(table[at(i + 1, j)], table[at(i, j + 1)])
    }
  }
  const ops = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: ' ', text: a[i] })
      i++
      j++
    } else if (table[at(i + 1, j)] >= table[at(i, j + 1)]) {
      ops.push({ kind: '-', text: a[i] })
      i++
    } else {
      ops.push({ kind: '+', text: b[j] })
      j++
    }
  }
  while (i < n) ops.push({ kind: '-', text: a[i++] })
  while (j < m) ops.push({ kind: '+', text: b[j++] })

  const keep = new Set()
  ops.forEach((op, index) => {
    if (op.kind === ' ') return
    for (let k = Math.max(0, index - context); k <= Math.min(ops.length - 1, index + context); k++) keep.add(k)
  })
  const lines = []
  let previous = -2
  ops.forEach((op, index) => {
    if (!keep.has(index)) return
    if (index !== previous + 1) lines.push('@@')
    lines.push(`${op.kind}${op.text}`)
    previous = index
  })
  const head = `--- AGENTS.md\n+++ proposal\n`
  const body = lines.join('\n')
  return head + (lines.length > 400 ? `${lines.slice(0, 400).join('\n')}\n... (diff truncated)` : body)
}

/**
 * Resolve the project root for a tool/command invocation.
 * @returns {Promise<{root: string, cwd: string}>}
 */
async function resolveProject(ctx, agent, signal) {
  const workingDirectory = ctx.get('workingDirectory')
  let cwd
  if (workingDirectory !== undefined && agent !== undefined) {
    cwd = await workingDirectory.ensure(agent, signal)
  } else {
    cwd = agent?.session?.header?.cwd ?? process.cwd()
  }
  const root = findProjectRoot(cwd)
  return { root, cwd }
}

/** Mark a project as analysed now. */
async function recordSync(paths, file) {
  let hash = ''
  let bytes = 0
  try {
    const text = await readTextFile(file)
    hash = createHash('sha1').update(text).digest('hex').slice(0, 12)
    bytes = Buffer.byteLength(text, 'utf8')
  } catch {
    // Recording a sync for a missing file is harmless: the next status reports it.
  }
  const state = await readJson(paths.state, {})
  await writeJson(paths.state, {
    ...state,
    lastSyncAt: Date.now(),
    lastHash: hash,
    lastBytes: bytes,
  })
}

/**
 * Back up the current AGENTS.md, keeping the newest 20.
 * @returns the backup path, or '' when there was nothing to copy.
 */
async function backupFile(paths, file) {
  if (!(await pathExists(file))) return ''
  await mkdir(paths.backups, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = join(paths.backups, `${basename(file)}.${stamp}.md`)
  await copyFile(file, target)
  const names = (await readdir(paths.backups)).filter(entry => entry.endsWith('.md')).sort()
  for (const name of names.slice(0, Math.max(0, names.length - 20))) {
    await unlink(join(paths.backups, name)).catch(() => {})
  }
  return target
}

/**
 * Build the child's prompt. The method is referenced by path, never inlined:
 * the child reads it in its own context.
 */
function buildPrompt({ mode, root, file, pendingPath, budgetBytes, changes, note }) {
  const lines = [
    `You are maintaining the workspace guide AGENTS.md for the project at ${root}.`,
    '',
    `Read ${METHOD_FILE.split(sep).join('/')} first and follow it exactly. It defines the skeleton, the filter every line must pass, the line ceiling and how to report.`,
    '',
    `Mode: ${mode === 'compact' ? 'compact (rewrite from scratch, keep only durable facts)' : 'update (merge new facts, never delete what is still true)'}.`,
    `Current file: ${file}`,
    `Write the COMPLETE new file to: ${pendingPath}`,
    `Byte budget for the result: ${budgetBytes} bytes. Stay comfortably under it.`,
    '',
  ]
  if (changes.length > 0) {
    lines.push(`Files changed since the last sync (${changes.length}):`, ...changes.slice(0, 60).map(entry => `- ${entry}`), '')
  }
  lines.push(
    'Rules:',
    '- Never write AGENTS.md itself, and never edit any other project file. The only file you write is the pending path above.',
    '- Verify claims against the repository; never invent a command, path or module. Anything unverifiable becomes a TODO line.',
    '- Keep human-written facts that are still true. Remove only what the changes made false.',
    '- Write in the language the existing AGENTS.md uses; if it is empty or missing, write in Simplified Chinese.',
  )
  if (note.length > 0) lines.push('', note)
  lines.push('', 'Report back: what you changed and why, what you removed, what you could not verify, and the final line/byte count.')
  return lines.join('\n')
}

/**
 * Start the subagent that drafts a proposal.
 * @returns the activation result with its child id.
 */
async function startProposal(ctx, config, agent, signal, { mode, note }) {
  const subagents = ctx.get('subagents')
  if (subagents === undefined) throw new Error('subagent service is not mounted in this profile')
  const provider = config.provider
  if (subagents.getProvider(provider) === undefined) {
    const available = subagents.list()
    throw new Error(`no subagent provider named "${provider}" is mounted; available: ${available.length > 0 ? available.join(', ') : 'none'}`)
  }
  try {
    readFileSync(METHOD_FILE, 'utf8')
  } catch {
    throw new Error(`method file is unreadable: ${METHOD_FILE}`)
  }

  const { root, cwd } = await resolveProject(ctx, agent, signal)
  const paths = projectPaths(root)
  const file = agentsFileFor(root, config)
  if (!(await pathExists(file))) throw new Error(`no ${config.targetFile} in ${root}; nothing to maintain`)

  const snapshot = await describe(root, config)
  const prompt = buildPrompt({
    mode,
    root,
    file,
    pendingPath: paths.pending,
    budgetBytes: config.maxBytes,
    changes: snapshot.changes.files,
    note: [config.note, note ?? ''].filter(part => part.length > 0).join('\n'),
  })

  // Clear any previous proposal BEFORE the child runs: a fast child must not
  // have its output deleted by our own bookkeeping.
  await mkdir(paths.dir, { recursive: true })
  await unlink(paths.pending).catch(() => {})
  await unlink(paths.pendingMeta).catch(() => {})

  const activation = await subagents.startActivation({
    provider,
    label: `AGENTS.md ${mode}`,
    prompt: [{ type: 'text', text: prompt }],
    parent: agent,
    signal,
    cwd,
    delivery: 'parent',
    ...config.agentPreset.length === 0 ? {} : { agentPreset: config.agentPreset },
  })

  await writeJson(paths.pendingMeta, {
    mode,
    createdAt: Date.now(),
    childId: String(activation.childId),
    changedCount: snapshot.changes.count,
    changeSource: snapshot.changes.source,
  })
  return { root, childId: String(activation.childId), pendingPath: paths.pending }
}

/** Apply the pending proposal: diff, backup, write, record. */
async function applyPending(config, root) {
  const paths = projectPaths(root)
  const file = agentsFileFor(root, config)
  if (!(await pathExists(paths.pending))) throw new Error('no pending proposal; run agents_md_propose or /agents-sync first')
  const proposed = await readTextFile(paths.pending)
  if (proposed.trim().length === 0) throw new Error('the pending proposal is empty; refusing to overwrite AGENTS.md')

  let current = ''
  if (await pathExists(file)) current = await readTextFile(file)
  const diff = unifiedDiff(current, proposed)
  if (diff === '') {
    await recordSync(paths, paths.pending)
    await unlink(paths.pending).catch(() => {})
    await unlink(paths.pendingMeta).catch(() => {})
    return { applied: false, reason: 'no-change', bytes: Buffer.byteLength(proposed, 'utf8') }
  }

  const backup = await backupFile(paths, file)
  await writeFileAtomic(file, proposed)
  await recordSync(paths, file)

  await mkdir(paths.history, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  await copyFile(paths.pending, join(paths.history, `proposal.${stamp}.md`)).catch(() => {})
  await unlink(paths.pending).catch(() => {})
  await unlink(paths.pendingMeta).catch(() => {})

  return {
    applied: true,
    file,
    backup,
    bytes: Buffer.byteLength(proposed, 'utf8'),
    budgetBytes: config.maxBytes,
    diff,
  }
}

/** Restore the newest (or nth-newest) backup. */
async function revertToBackup(config, root, index) {
  const paths = projectPaths(root)
  const file = agentsFileFor(root, config)
  const backups = await listBackups(paths)
  const picked = backups[index]
  if (picked === undefined) throw new Error(`no backup #${index} available (have ${backups.length})`)
  const source = join(paths.backups, picked)
  const text = await readTextFile(source)
  const before = (await pathExists(file)) ? await readTextFile(file) : ''
  await backupFile(paths, file)
  await writeFileAtomic(file, text)
  await recordSync(paths, file)
  return {
    reverted: true,
    file,
    from: picked,
    diff: unifiedDiff(before, text),
    backups,
  }
}

/** Working directory last seen for a project, used by the HTTP routes. */
const lastSeen = new Map()

function remember(agent) {
  if (agent === undefined || agent === null) return
  const cwd = agent?.session?.header?.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) return
  lastSeen.set(agent.id, cwd)
  lastSeen.set('*', cwd)
}

/** Read a JSON request body, bounded. */
async function readBody(req, limit = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Register the four model tools.
 * @param ctx - Cordis context carrying the tool registry.
 */
function registerTools(ctx, config) {
  const text = (value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

  ctx.tools.register({
    name: 'agents_md_status',
    description: 'Report the workspace AGENTS.md state: path, size against its byte budget, the last analysed time, which files changed since then, whether an update is worth proposing, and whether a pending proposal is waiting for review. Call this before proposing anything.',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: {
        type: 'object',
        properties: {
          exists: { type: 'boolean' },
          agentsFile: { type: 'string' },
          projectRoot: { type: 'string' },
          bytes: { type: 'integer' },
          budgetBytes: { type: 'integer' },
          overBudget: { type: 'boolean' },
          stale: { type: 'boolean' },
          changedCount: { type: 'integer' },
          changedFiles: { type: 'array', items: { type: 'string' } },
          lastSyncIso: { type: 'string' },
          pendingMode: { type: 'string' },
          backups: { type: 'array', items: { type: 'string' } },
          summary: { type: 'string' },
        },
      },
      render: (args, value) => text(value),
    },
    async execute(_args, exec) {
      remember(exec.agent)
      if (exec.agent === undefined) throw new Error('agents_md_status needs an agent context')
      const { root } = await resolveProject(ctx, exec.agent, exec.signal)
      const snapshot = await describe(root, config)
      const { text: _content, ...rest } = snapshot
      const summary = snapshot.exists
        ? `${snapshot.agentsFile}: ${snapshot.bytes}/${snapshot.budgetBytes} bytes, ${snapshot.changes.count} changed file(s), ${snapshot.stale ? 'an update is worth proposing' : 'nothing urgent'}${snapshot.pending.exists ? ', a pending proposal is waiting for review' : ''}`
        : `no ${config.targetFile} at ${root}: nothing to maintain`
      return {
        ...rest,
        changedCount: snapshot.changes.count,
        changedFiles: snapshot.changes.files,
        pendingMode: snapshot.pending.exists ? snapshot.pending.mode : '',
        summary,
      }
    },
    timeoutMs: 30000,
  })

  ctx.tools.register({
    name: 'agents_md_propose',
    description: 'Draft an updated or compacted AGENTS.md in a background subagent. The subagent writes a complete proposal to a pending file; AGENTS.md is NOT modified. Review the result with agents_md_apply (it prints the diff and only writes after the user agrees in conversation).',
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['update', 'compact'], description: 'update = merge new facts; compact = rewrite shorter, keeping the skeleton.' },
        note: { type: 'string', description: 'Optional extra instruction for this run.' },
      },
      required: ['mode'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          started: { type: 'boolean' },
          childId: { type: 'string' },
          mode: { type: 'string' },
          pendingPath: { type: 'string' },
          summary: { type: 'string' },
        },
      },
      render: (args, value) => text(value),
    },
    async execute(args, exec) {
      remember(exec.agent)
      const mode = args?.mode === 'compact' ? 'compact' : 'update'
      if (exec.agent === undefined) throw new Error('agents_md_propose needs an agent context')
      const result = await startProposal(ctx, config, exec.agent, exec.signal, { mode, note: typeof args?.note === 'string' ? args.note : '' })
      return {
        started: true,
        childId: result.childId,
        mode,
        pendingPath: result.pendingPath,
        summary: `subagent ${result.childId.slice(0, 8)} is drafting a ${mode} proposal; its report arrives when it finishes. Then call agents_md_apply to preview the diff.`,
      }
    },
  })

  ctx.tools.register({
    name: 'agents_md_apply',
    description: 'Apply the pending AGENTS.md proposal: prints a unified diff, backs the current file up under the plugin state directory, then writes atomically and records the sync. Only call it after the user agreed to the proposal in conversation.',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: {
        type: 'object',
        properties: {
          applied: { type: 'boolean' },
          file: { type: 'string' },
          backup: { type: 'string' },
          bytes: { type: 'integer' },
          summary: { type: 'string' },
          diff: { type: 'string' },
        },
      },
      render: (args, value) => text(value),
    },
    async execute(_args, exec) {
      remember(exec.agent)
      if (exec.agent === undefined) throw new Error('agents_md_apply needs an agent context')
      const { root } = await resolveProject(ctx, exec.agent, exec.signal)
      const result = await applyPending(config, root)
      return {
        ...result,
        summary: result.applied
          ? `AGENTS.md updated (${result.bytes} bytes); previous version backed up to ${result.backup}`
          : 'the proposal was identical to the current file; nothing written',
      }
    },
  })

  ctx.tools.register({
    name: 'agents_md_revert',
    description: 'Restore an earlier AGENTS.md from the plugin backups (default: the most recent write). Prints the diff against the current file.',
    parameters: {
      type: 'object',
      properties: {
        index: { type: 'integer', description: '0 = most recent backup, 1 = the one before it, ...' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          reverted: { type: 'boolean' },
          file: { type: 'string' },
          from: { type: 'string' },
          summary: { type: 'string' },
          diff: { type: 'string' },
        },
      },
      render: (args, value) => text(value),
    },
    async execute(args, exec) {
      remember(exec.agent)
      if (exec.agent === undefined) throw new Error('agents_md_revert needs an agent context')
      const index = Number.isInteger(args?.index) && args.index >= 0 ? args.index : 0
      const { root } = await resolveProject(ctx, exec.agent, exec.signal)
      const result = await revertToBackup(config, root, index)
      return { ...result, summary: `restored ${result.from}` }
    },
  })
}

/**
 * Register `/agents-status`, `/agents-sync`, `/agents-compact` and `/agents-revert`.
 * @param ctx - Cordis context carrying the command registry.
 */
function registerCommands(ctx, config) {
  ctx.commands.register({
    name: 'agents-status',
    description: 'Show the workspace AGENTS.md state and pending proposal',
    input: { hint: '[无需参数]', attachments: false },
    async handler({ agent, signal }) {
      remember(agent)
      const { root } = await resolveProject(ctx, agent, signal)
      const snapshot = await describe(root, config)
      const { text, ...rest } = snapshot
      const lines = [snapshot.exists
        ? `${snapshot.agentsFile} — ${snapshot.bytes}/${snapshot.budgetBytes} bytes${snapshot.overBudget ? ' (over budget)' : ''}`
        : `No ${config.targetFile} in ${snapshot.projectRoot} — nothing to maintain.`]
      if (snapshot.exists) {
        lines.push(`Changed since last sync: ${snapshot.changes.count} file(s) via ${snapshot.changes.source}`)
        if (snapshot.changes.files.length > 0) lines.push(...snapshot.changes.files.slice(0, 10).map(file => `  · ${file}`))
        lines.push(`Last sync: ${snapshot.lastSyncIso.length > 0 ? snapshot.lastSyncIso : 'never'}`)
        lines.push(snapshot.stale ? 'Status: stale — /agents-sync would be useful' : 'Status: up to date enough')
      }
      if (snapshot.pending.exists) lines.push(`Pending ${snapshot.pending.mode} proposal from ${new Date(snapshot.pending.createdAt).toLocaleString()} — apply with agents_md_apply`)
      if (snapshot.backups.length > 0) lines.push(`Backups: ${snapshot.backups.length}`)
      lines.push(`State: ${snapshot.stateDir}`)
      return { kind: 'success', text: lines.join('\n') }
    },
  })

  const syncHandler = (mode) => async ({ agent, rawInput, signal }) => {
    remember(agent)
    try {
      const result = await startProposal(ctx, config, agent, signal, { mode, note: rawInput.trim() })
      return {
        kind: 'success',
        text: `Started a ${mode} subagent (${result.childId.slice(0, 8)}). It writes a proposal to a pending file and never touches AGENTS.md; when it reports back, review with agents_md_apply (diff + backup) or /agents-status.`,
      }
    } catch (error) {
      return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
    }
  }

  ctx.commands.register({
    name: 'agents-sync',
    description: 'Draft an AGENTS.md update in a subagent (proposal only, no write)',
    input: { hint: '[what changed / what to focus on]', attachments: false },
    handler: syncHandler('update'),
  })
  ctx.commands.register({
    name: 'agents-compact',
    description: 'Draft a shorter AGENTS.md in a subagent (proposal only, no write)',
    input: { hint: '[what to keep]', attachments: false },
    handler: syncHandler('compact'),
  })

  ctx.commands.register({
    name: 'agents-revert',
    description: 'Restore the previous AGENTS.md from the plugin backup',
    input: { hint: '[backup index, default 0]', attachments: false },
    async handler({ agent, rawInput, signal }) {
      remember(agent)
      const index = Number.parseInt(rawInput.trim(), 10)
      try {
        const { root } = await resolveProject(ctx, agent, signal)
        const result = await revertToBackup(config, root, Number.isFinite(index) && index >= 0 ? index : 0)
        return { kind: 'success', text: `Restored ${result.from}\n\n${result.diff.slice(0, 2000)}` }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  })
}

/**
 * Register the HTTP routes the settings card uses. They run without an agent,
 * so a directory is resolved from the query (preferred), then from the working
 * directory of the most recent turn.
 */
function registerRoutes(ctx, config) {
  ctx.inject(['webServer'], (webCtx) => {
    const send = (res, status, body) => {
      res.statusCode = status
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(JSON.stringify(body))
    }

    // The HTTP plane is reachable by any page the user's browser loads, so every
    // route runs behind the same trust checks the host uses: the connection
    // service rejects forged Host/Origin and unauthenticated requests, and the
    // local fence below fails closed when that service is missing.
    const TRUSTED = String(process.env.AGENTS_KEEPER_TRUSTED_HOSTS ?? '')
      .split(',').map(part => part.trim().toLowerCase()).filter(part => part.length > 0)
    const isLoopback = (hostname) => {
      const host = String(hostname).toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
      if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true
      const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
      return match !== null && Number(match[1]) === 127 && [match[2], match[3], match[4]].every(part => Number(part) <= 255)
    }
    const localRejection = (req) => {
      let host
      try {
        host = new URL(`http://${String(req.headers.host ?? '')}`)
      } catch {
        return 403
      }
      if (!isLoopback(host.hostname) && !TRUSTED.includes(host.host.toLowerCase()) && !TRUSTED.includes(host.hostname.toLowerCase())) return 403
      if (String(req.headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') return 403
      const origin = req.headers.origin
      if (typeof origin === 'string' && origin.length > 0 && origin !== 'null') {
        let originHost
        try {
          originHost = new URL(origin).host.toLowerCase()
        } catch {
          return 403
        }
        if (originHost !== host.host.toLowerCase()) return 403
      }
      return null
    }
    const rejection = (req) => {
      const local = localRejection(req)
      if (local !== null) return local
      const connection = ctx.get('connection')
      if (connection === undefined || typeof connection.requestRejection !== 'function') return 0
      try {
        return connection.requestRejection(req) ?? 0
      } catch {
        return 403
      }
    }

    const resolveDir = (url) => {
      const param = url.searchParams.get('dir')
      if (typeof param === 'string' && isAbsolute(param) && existsSync(param)) return param
      const remembered = lastSeen.get('*')
      if (typeof remembered === 'string' && existsSync(remembered)) return remembered
      return undefined
    }

    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: '/agents-keeper/api',
      async handler(req, res) {
        const denied = rejection(req)
        if (denied !== 0) {
          res.statusCode = denied
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ ok: false, code: 'denied' }))
          return
        }
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const route = url.pathname.slice('/agents-keeper/api/'.length)
        try {
          if (route === 'status' && req.method === 'GET') {
            const dir = resolveDir(url)
            if (dir === undefined) {
              send(res, 409, { ok: false, code: 'no-workspace', message: '打开一个项目会话后再刷新状态（尚未观察到工作目录）。' })
              return
            }
            const root = findProjectRoot(dir)
            const snapshot = await describe(root, config)
            const { text, ...rest } = snapshot
            send(res, 200, { ok: true, ...rest })
            return
          }

          if (route === 'pending' && req.method === 'GET') {
            const dir = resolveDir(url)
            if (dir === undefined) {
              send(res, 409, { ok: false, code: 'no-workspace' })
              return
            }
            const root = findProjectRoot(dir)
            const paths = projectPaths(root)
            const file = agentsFileFor(root, config)
            const proposed = (await pathExists(paths.pending)) ? await readTextFile(paths.pending) : ''
            const current = (await pathExists(file)) ? await readTextFile(file) : ''
            send(res, 200, {
              ok: true,
              pending: proposed.length > 0,
              diff: proposed.length > 0 ? unifiedDiff(current, proposed) : '',
              bytes: Buffer.byteLength(proposed, 'utf8'),
            })
            return
          }

          if (route === 'apply' && req.method === 'POST') {
            const dir = resolveDir(url)
            if (dir === undefined) {
              send(res, 409, { ok: false, code: 'no-workspace' })
              return
            }
            const root = findProjectRoot(dir)
            const result = await applyPending(config, root)
            send(res, 200, { ok: true, ...result })
            return
          }

          if (route === 'revert' && req.method === 'POST') {
            const dir = resolveDir(url)
            if (dir === undefined) {
              send(res, 409, { ok: false, code: 'no-workspace' })
              return
            }
            const body = await readBody(req)
            const index = Number.isInteger(body.index) && body.index >= 0 ? body.index : 0
            const root = findProjectRoot(dir)
            const result = await revertToBackup(config, root, index)
            send(res, 200, { ok: true, ...result })
            return
          }

          if (route === 'propose' && req.method === 'POST') {
            const dir = resolveDir(url)
            if (dir === undefined) {
              send(res, 409, { ok: false, code: 'no-workspace', message: '设置页无法自己起子代理：请先在对话里发一条消息，或直接用 /agents-sync。' })
              return
            }
            // A proposal needs a live parent agent; the HTTP plane has none.
            send(res, 409, {
              ok: false,
              code: 'needs-conversation',
              message: '生成预览需要子代理，只能在对话里触发：请发送 /agents-sync（更新）或 /agents-compact（精简）。',
            })
            return
          }

          send(res, 404, { ok: false, code: 'not-found' })
        } catch (error) {
          send(res, 500, { ok: false, code: 'failed', message: error instanceof Error ? error.message : String(error) })
        }
      },
    }))
  })
}

/**
 * Register the plugin.
 * @param ctx - Cordis context.
 * @param rawConfig - the row's `config`.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)

  registerTools(ctx, config)
  registerCommands(ctx, config)
  registerRoutes(ctx, config)

  // Keep the last working directory in view so the settings card has something
  // to read before the user runs any plugin tool. The handler is defensive: it
  // must never throw into the turn it observes.
  try {
    ctx.on('turn/end', (event) => {
      try {
        const agent = event?.agent
        if (agent !== undefined && agent !== null) {
          const live = ctx.get('agents')?.get?.(agent.id)
          if (live === agent) remember(agent)
          return
        }
        const sessionId = event?.session?.id ?? event?.sessionId
        if (typeof sessionId === 'string') {
          const live = ctx.get('agents')?.get?.(sessionId)
          if (live !== undefined) remember(live)
        }
      } catch {
        // Observation only.
      }
    })
  } catch (error) {
    ctx.logger?.warn?.(`agents-keeper: turn/end listener unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }

  ctx.logger?.info?.(`agents-keeper: maintaining ${config.targetFile}, budget ${config.maxBytes} bytes, state in ${keeperHome()}`)
}

export { buildPrompt, describe, resolveConfig, unifiedDiff, METHOD_FILE, projectPaths, applyPending, revertToBackup }
