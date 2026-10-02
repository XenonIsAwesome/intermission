#!/usr/bin/env node
// A stand-in for Claude Code, to try the mod without spending tokens.
//
// It loads the real hooks/register.js, gives it a fake host, and lets you play
// Claude's part: start working, finish, ask a permission question. In kitty it
// paints the game; the engine, the input file and the audio are the real ones.
//
//   node tools/simulate.mjs                 interactive, in kitty
//   node tools/simulate.mjs --auto          scripted run that checks itself,
//                                           including that the engine goes
//                                           silent when the pane closes
//   --root <dir>   where dist/ holds the engine (default: the installed plugin,
//                  else this repo)
//   --jitter       delay file writes by a random few ms, like a busy host
//
// Keys:  s  Claude starts working      f  Claude finishes
//        p  Claude asks permission     r  you answer, Claude carries on
//        x  you close the pane         q  quit

import cp from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const isAuto = args.includes('--auto')
const isJitter = args.includes('--jitter') || isAuto
const rootArg = args.indexOf('--root') >= 0 ? args[args.indexOf('--root') + 1] : null
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const installed = path.join(os.homedir(), '.claude/plugins/marketplaces/local-desktop-app-uploads/intermission')
const root = rootArg ?? (fs.existsSync(installed + '/dist/odamex') ? installed : repo)
if (!fs.existsSync(root + '/dist/odamex') && !fs.existsSync(root + '/dist/odamex.app')) {
  console.error('No engine under ' + root + '/dist. Run /intermission once in Claude Code, or pass --root.')
  process.exit(1)
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'intermission-sim-'))
const audioFile = scratch + '/audio.raw'
const logFile = scratch + '/sim.log'
const log = (text) => fs.appendFileSync(logFile, text + '\n')

// ---- the fake host ---------------------------------------------------------

const handlers = []
const on = (event, ...rest) => {
  const handler = rest.pop()
  handlers.push({ event, filter: rest[0] ?? {}, handler })
}

async function emit(event, payload, fallback) {
  const chain = handlers.filter(
    (h) => h.event === event && Object.entries(h.filter).every(([k, v]) => payload?.[k] === v),
  )
  const run = async (i, e) => (i < chain.length ? chain[i].handler($, e, (next) => run(i + 1, next)) : fallback ?? e)
  return run(0, payload)
}

const state = {
  paneOpen: false,
  turnRunning: false,
  toast: '',
  inputPath: null,
  engineArgs: null,
  texts: [],
  frame: null,
  engine: null,
  isLinux: process.platform === 'linux',
}
const store = new Map()
const timers = new Set()

const element = (type) => (props = {}) => ({ type, props })
const builders = { Box: element('Box'), Text: element('Text'), Image: element('Image'), Client: element('Client'), Button: element('Button') }

function* walk(node) {
  if (!node || typeof node !== 'object') return
  yield node
  for (const child of node.props?.children ?? []) yield* walk(child)
}

async function rerender() {
  if (!state.paneOpen) return
  const tree = await emit('ui.render', {
    component: 'Pane',
    requestId: 'intermission',
    surface: 'terminal',
    props: { bodyColumns: Math.min(process.stdout.columns || 100, 100) },
  }, null)
  state.texts = []
  for (const node of walk(tree)) {
    if (node.type === 'Text') state.texts.push(node.props.children.join(''))
    if (node.type === 'Image') draw(node.props.source.shm, node.props.columns, node.props.rows)
  }
}

function draw(shm, columns, rows) {
  state.frame = shm
  if (isAuto || !process.stdout.isTTY) return
  // kitty reads the shared-memory object and removes it, as the real host does
  const payload = Buffer.from(shm).toString('base64')
  process.stdout.write(`\x1b[H\x1b_Ga=T,f=24,s=640,v=360,t=s,i=1,c=${columns},r=${rows},C=1,q=2;${payload}\x1b\\`)
}

const $ = {
  plugin: { root },
  session: { surfaces: async () => ['terminal'] },
  store: { get: async (k) => store.get(k), set: async (k, v) => void store.set(k, v) },
  command: { register: async () => {} },
  fs: {
    exists: async (p) => fs.existsSync(p),
    read: async (p) => fs.readFileSync(p, 'utf8'),
    write: async (p, text) => {
      if (isJitter) await new Promise((r) => setTimeout(r, Math.random() * 60))
      fs.writeFileSync(p, text)
    },
  },
  clock: {
    now: async () => Date.now(),
    after(ms, fn) {
      const t = setTimeout(fn, ms)
      timers.add(t)
      return { cancel: () => clearTimeout(t) }
    },
    every(ms, fn) {
      const t = setInterval(fn, ms)
      timers.add(t)
      return { cancel: () => clearInterval(t) }
    },
  },
  process: {
    run: async (argv) => {
      const r = cp.spawnSync(argv[0], argv.slice(1), { encoding: 'utf8' })
      return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.status ?? 1 }
    },
    spawn(request) {
      const env = { ...process.env, ...request.env }
      if (isAuto) {
        env.SDL_AUDIODRIVER = 'disk'
        env.SDL_DISKAUDIOFILE = audioFile
      }
      state.inputPath = request.env.INTERMISSION_INPUT
      state.engineArgs = request.argv
      const child = cp.spawn(request.argv[0], request.argv.slice(1), { env })
      const queue = []
      let wake = null
      let done = false
      const push = (item) => {
        queue.push(item)
        wake?.()
      }
      child.stdout.on('data', (b) => push({ stream: 'stdout', text: b.toString() }))
      child.stderr.on('data', (b) => log('engine: ' + b.toString().trimEnd()))
      child.on('close', () => {
        done = true
        wake?.()
      })
      state.engine = child
      state.spawnedAt ??= Date.now()
      return {
        [Symbol.asyncIterator]() {
          return this
        },
        async next() {
          while (!queue.length && !done) await new Promise((r) => (wake = r))
          return queue.length ? { value: queue.shift(), done: false } : { value: undefined, done: true }
        },
        async return() {
          child.kill('SIGTERM')
          return { value: undefined, done: true }
        },
      }
    },
  },
  ui: {
    open: async ({ id }) => {
      if (id === 'intermission') {
        state.paneOpen = true
        setTimeout(rerender, 0)
      }
      return { isPlaced: true }
    },
    close: async ({ id }) => {
      if (id !== 'intermission' || !state.paneOpen) return
      state.paneOpen = false
      state.frame = null
      state.texts = []
      if (!isAuto && process.stdout.isTTY) process.stdout.write('\x1b_Ga=d,d=A,q=2\x1b\\\x1b[2J')
      await emit('ui.close', { id, origin: { kind: 'mod' } })
    },
    invalidate: () => void setTimeout(rerender, 0),
    toast: (text) => {
      state.toast = text
      log('toast: ' + text)
    },
    log: (text) => log('log: ' + text),
    blit: async ({ source }) => draw(source.shm, Math.min(process.stdout.columns || 100, 100), 28),
    resolve: () => builders,
  },
}

// ---- Claude's side ---------------------------------------------------------

const claude = {
  async start() {
    state.turnRunning = true
    await emit('turn.start', {})
  },
  async finish() {
    state.turnRunning = false
    await emit('turn.complete', {})
  },
  async askPermission() {
    // The decision the host would have reached is "ask"
    await emit('tool.check', { tool_use_id: 'sim', tool: 'Bash' }, { decision: 'ask' })
  },
  async carryOn() {
    await emit('tool.call', { tool: 'Bash' })
  },
  async personCloses() {
    if (!state.paneOpen) return
    state.paneOpen = false
    state.frame = null
    if (!isAuto && process.stdout.isTTY) process.stdout.write('\x1b_Ga=d,d=A,q=2\x1b\\\x1b[2J')
    await emit('ui.close', { id: 'intermission', origin: { kind: 'person' } })
  },
}

// ---- load the mod ----------------------------------------------------------

const copy = scratch + '/register.mjs'
fs.copyFileSync(repo + '/hooks/register.js', copy)
const { register } = await import(pathToFileURL(copy).href)
register(on)
await emit('session.start', {})
await emit('command.run', { command: 'intermission', args: '' })
// The welcome pane belongs to /intermission; the first turn replaces it
const readInput = () => (state.inputPath && fs.existsSync(state.inputPath) ? fs.readFileSync(state.inputPath, 'utf8').trim() : '-')

function shutdown(code = 0) {
  state.engine?.kill('SIGTERM')
  for (const t of timers) clearTimeout(t)
  if (process.stdout.isTTY && !isAuto) process.stdout.write('\x1b_Ga=d,d=A,q=2\x1b\\\x1b[2J\x1b[H')
  process.exit(code)
}

// ---- interactive -----------------------------------------------------------

if (!isAuto) {
  if (!process.stdin.isTTY) {
    console.error('Interactive mode needs a terminal; use --auto for a scripted run.')
    process.exit(1)
  }
  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.on('data', async (key) => {
    const k = key.toString()
    if (k === 'q' || k === '\x03') shutdown()
    if (k === 's') await claude.start()
    if (k === 'f') await claude.finish()
    if (k === 'p') await claude.askPermission()
    if (k === 'r') await claude.carryOn()
    if (k === 'x') await claude.personCloses()
  })
  setInterval(() => {
    const rows = process.stdout.rows || 40
    const lines = [
      `Claude: ${state.turnRunning ? 'WORKING' : 'idle'}   pane: ${state.paneOpen ? 'open' : 'closed'}   input file: "${readInput()}"`,
      ...state.texts.map((t) => '  ' + t.slice(0, (process.stdout.columns || 80) - 4)),
      state.toast ? 'toast: ' + state.toast : '',
      '[s] start working  [f] finish  [p] permission ask  [r] answer  [x] close pane  [q] quit',
    ]
    process.stdout.write('\x1b7' + lines.map((l, i) => `\x1b[${rows - lines.length + 1 + i};1H\x1b[2K${l}`).join('') + '\x1b8')
  }, 200)
}

// ---- scripted --------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (ok, what) => {
  console.log((ok ? '  ok   ' : '  FAIL ') + what)
  if (!ok) failures++
}

// Peak loudness of the recorded audio between two wall-clock moments
function peak(fromMs, toMs, startedMs, bytesPerMs) {
  const data = fs.readFileSync(audioFile)
  const from = Math.max(0, Math.floor(((fromMs - startedMs) * bytesPerMs) / 4) * 4)
  const to = Math.min(data.length, Math.floor(((toMs - startedMs) * bytesPerMs) / 4) * 4)
  let max = 0
  for (let i = from; i + 1 < to; i += 2) max = Math.max(max, Math.abs(data.readInt16LE(i)))
  return max
}

async function cycle(n, { withPermission }) {
  console.log(`cycle ${n}${withPermission ? ' (with a permission question)' : ''}`)
  await claude.start()
  await sleep(3500)
  check(state.paneOpen, 'pane opens after Claude works for a bit')
  check(state.frame !== null, 'a game frame arrived')
  check(readInput().startsWith('1 '), `engine told to play (file: "${readInput()}")`)
  const playedAt = Date.now()
  await sleep(1500)
  const marks = { play: [playedAt, Date.now()] }

  if (withPermission) {
    await claude.askPermission()
    await sleep(600)
    check(!state.paneOpen, 'pane closes when Claude needs you')
    check(readInput() === '0 0', `engine told to stop (file: "${readInput()}")`)
    marks.prompt = Date.now()
    await sleep(2500)
    marks.promptEnd = Date.now()
    await claude.carryOn()
    await sleep(3500)
    check(state.paneOpen, 'pane comes back once Claude carries on')
    check(state.frame !== null, 'a fresh game frame arrived after coming back')
    await sleep(1000)
  }

  await claude.finish()
  await sleep(4200)
  check(!state.paneOpen, 'pane closes after the countdown')
  check(readInput() === '0 0', `engine told to stop (file: "${readInput()}")`)
  marks.away = Date.now()
  await sleep(3000)
  marks.awayEnd = Date.now()
  return marks
}

if (isAuto) {
  const all = []
  all.push(await cycle(1, { withPermission: false }))
  all.push(await cycle(2, { withPermission: true }))
  all.push(await cycle(3, { withPermission: false }))

  // Audio is recorded in real time; work out its rate from how much was written
  const size = fs.existsSync(audioFile) ? fs.statSync(audioFile).size : 0
  if (size > 0) {
    // SDL's disk driver writes in real time, so the rate is what was written
    // over the time the engine has run
    const audioStart = state.spawnedAt
    const bytesPerMs = size / (Date.now() - audioStart)
    console.log('audio')
    const loud = peak(all[0].play[0], all[0].play[1], audioStart, bytesPerMs)
    console.log(`  (playing: peak ${loud}; away windows should be 0)`)
    for (const [i, marks] of all.entries()) {
      const quiet = peak(marks.away + 1000, marks.awayEnd, audioStart, bytesPerMs)
      check(quiet === 0, `cycle ${i + 1} is silent after the pane closes (peak ${quiet})`)
    }
  } else {
    console.log('audio: nothing recorded, skipped')
  }
  console.log(failures ? `\n${failures} check(s) failed. Log: ${logFile}` : '\nAll checks passed.')
  shutdown(failures ? 1 : 0)
}
