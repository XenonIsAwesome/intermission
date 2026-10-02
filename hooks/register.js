// intermission: drops you into Doom while Claude works and hands you back when
// it's done, or as soon as it needs you.

const PANE = 'intermission'
const WIDTH = 640
const HEIGHT = 360
const DROP_IN_DELAY_MS = 2000
const COUNTDOWN_SECONDS = 3
const SERVER = '157.245.140.115:10666'
// Between drop-ins the engine waits on the server as a spectator; after this
// long it disconnects, so idle sessions don't hold the server's slots
const AWAY_DISCONNECT_MS = 5 * 60 * 1000

const NAME_STARTS = ['Idle', 'Bored', 'Queued', 'Pending', 'Async', 'Blocked', 'Lazy']
const NAME_ENDS = ['Dev', 'Coder', 'Hacker', 'Intern', 'Marine', 'Imp']

// Whether the person turned intermission on, and their name in the game, both
// kept between sessions in $.store
let isOn = false
let name = null

// Where play stands:
//   idle      not playing, whether or not Claude is working
//   waiting   Claude is working; dropping in once the delay passes
//   playing   the pane is open and the engine runs
//   countdown Claude is done; closing when the count reaches zero
let phase = 'idle'
let isTurnRunning = false
// Closed by hand during this turn, so stay out until the next one
let isDismissed = false
let isWelcomeOpen = false
let timer = null
let countdown = 0

// The running engine's output stream, the newest frame it wrote, the file it
// reads input from, the input region's last line, and the disconnect timer
let engine = null
let frame = null
let inputPath = null
let clientLine = '0'
let awayTimer = null
// Kills and deaths in the current or last round, as the engine reports them
let score = null

function cancelTimer() {
  timer?.cancel()
  timer = null
}

function armDropIn($) {
  if (!isOn || !isTurnRunning || isDismissed || phase !== 'idle') return
  phase = 'waiting'
  timer = $.clock.after(DROP_IN_DELAY_MS, () => dropIn($))
}

async function dropIn($) {
  if (phase !== 'waiting') return
  timer = null
  const surfaces = await $.session.surfaces()
  if (!surfaces.includes('terminal')) {
    phase = 'idle'
    return
  }
  const { isPlaced } = await $.ui.open({ id: PANE, title: 'intermission', focus: true })
  if (!isPlaced) {
    // A waiting pane would pop up later, long after the moment has passed
    phase = 'idle'
    await $.ui.close({ id: PANE })
    $.ui.toast('Widen the terminal to play intermission while Claude works')
    return
  }
  phase = 'playing'
  awayTimer?.cancel()
  awayTimer = null
  if (engine) await writeInput($)
  else void runEngine($)
}

// why, when given, heads the toast that sums up the round
async function pullOut($, why) {
  cancelTimer()
  phase = 'idle'
  if (why && score) $.ui.toast(why + ' · ' + scoreText(score))
  await $.ui.close({ id: PANE })
}

function scoreText({ kills, deaths }) {
  return kills + (kills === 1 ? ' kill, ' : ' kills, ') + deaths + (deaths === 1 ? ' death' : ' deaths')
}

function startCountdown($) {
  phase = 'countdown'
  countdown = COUNTDOWN_SECONDS
  $.ui.invalidate('ui.render')
  timer = $.clock.every(1000, () => {
    countdown -= 1
    if (countdown > 0) $.ui.invalidate('ui.render')
    else void pullOut($, "Claude's done")
  })
}

// The engine plays or spectates by the first number, and takes keys only in play
async function writeInput($) {
  if (!inputPath) return
  const isPlaying = phase === 'playing' || phase === 'countdown'
  await $.fs.write(inputPath, isPlaying ? '1 ' + clientLine + '\n' : '0 0\n')
}

// The pane closed, whoever closed it: spectate until the next drop-in
async function goAway($) {
  cancelTimer()
  phase = 'idle'
  isWelcomeOpen = false
  frame = null
  // The next input region counts its clicks from zero again
  clientLine = '0'
  if (!engine) return
  await writeInput($)
  awayTimer?.cancel()
  awayTimer = $.clock.after(AWAY_DISCONNECT_MS, () => void stopEngine($))
}

async function stopEngine($) {
  awayTimer?.cancel()
  awayTimer = null
  // Leaving the stream's loop is what stops the engine
  if (engine) await engine.return()
}

function randomName() {
  const pick = (words) => words[Math.floor(Math.random() * words.length)]
  return pick(NAME_STARTS) + pick(NAME_ENDS) + (10 + Math.floor(Math.random() * 90))
}

// Claude is about to ask the person something, so they must see the prompt
async function needsYou($) {
  if (phase === 'waiting') {
    cancelTimer()
    phase = 'idle'
  } else if (phase !== 'idle') {
    await pullOut($, 'Claude needs you')
  }
}

function engineRequest(root, id) {
  return {
    argv: [
      root + '/dist/odamex.app/Contents/MacOS/odamex',
      '-iwad', root + '/dist/freedoom2.wad',
      // Its own settings, so a person's own Odamex setup is never touched
      '-config', '/tmp/intermission-' + id + '.cfg',
      '-width', String(WIDTH),
      '-height', String(HEIGHT),
      '+vid_fullscreen', '0',
      '+vid_maxfps', '35',
      '+cl_name', name,
      '+connect', SERVER,
    ],
    env: {
      SDL_VIDEODRIVER: 'dummy',
      SDL_RENDER_DRIVER: 'software',
      // A per-run name keeps two sessions' frames from colliding
      INTERMISSION_FRAMES: '/im' + id + '-',
      INTERMISSION_INPUT: inputPath,
    },
  }
}

async function runEngine($) {
  const id = Math.random().toString(36).slice(2, 6)
  inputPath = '/tmp/intermission-' + id + '.input'
  await writeInput($)
  score = { kills: 0, deaths: 0 }
  engine = $.process.spawn(engineRequest($.plugin.root, id))
  let pending = ''
  let failure = null
  try {
    for await (const { stream, text } of engine) {
      if (stream !== 'stdout') continue
      // Pieces arrive as written, not as lines
      const lines = (pending + text).split('\n')
      pending = lines.pop()
      for (const line of lines) {
        const scored = /^@score (\d+) (\d+)/.exec(line)
        if (scored) {
          score = { kills: Number(scored[1]), deaths: Number(scored[2]) }
          $.ui.invalidate('ui.render')
          continue
        }
        const match = /^@frame (\S+)/.exec(line)
        if (!match) continue
        const isFirst = frame === null
        frame = match[1]
        if (isFirst) {
          $.ui.invalidate('ui.render')
        } else {
          $.ui.blit({ requestId: PANE, key: 'view', source: shmSource(frame) }).catch(() => {})
        }
      }
    }
  } catch (error) {
    $.ui.log('the game did not start: ' + error, { to: 'debug' })
    failure = "intermission couldn't start the game"
  } finally {
    engine = null
    frame = null
    inputPath = null
  }
  // Ending on its own while someone plays means the engine quit or crashed.
  // It also ends when this module unloads, and then there's nothing to close.
  if (failure || phase === 'playing' || phase === 'countdown') {
    try {
      $.ui.toast(failure ?? 'intermission lost the game')
      await pullOut($)
    } catch {}
  }
}

function shmSource(name) {
  return { shm: name, format: 'rgb', width: WIDTH, height: HEIGHT }
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    isOn = (await $.store.get('isOn')) === true
    name = await $.store.get('name')
    if (!name) {
      name = randomName()
      await $.store.set('name', name)
    }
    await $.command.register({
      name: 'intermission',
      description: 'Play Doom while Claude works',
      argumentHint: '[off]',
    })
    return next(e)
  })

  on('command.run', { command: 'intermission' }, async ($, e) => {
    if (e.args.trim() === 'off') {
      isOn = false
      await $.store.set('isOn', false)
      if (phase !== 'idle') await pullOut($)
      await stopEngine($)
      return { text: 'intermission is off.' }
    }
    isOn = true
    await $.store.set('isOn', true)
    // Opening it yourself also lets it open by itself in narrower terminals
    if (phase === 'idle') {
      isWelcomeOpen = true
      await $.ui.open({ id: PANE, title: 'intermission' })
    }
    return {}
  })

  on('turn.start', async ($, e, next) => {
    isTurnRunning = true
    isDismissed = false
    if (isWelcomeOpen) {
      isWelcomeOpen = false
      await $.ui.close({ id: PANE })
    }
    if (phase === 'countdown') {
      // A queued prompt started straight away, so keep playing
      cancelTimer()
      phase = 'playing'
      $.ui.invalidate('ui.render')
    }
    armDropIn($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) return next(e)
    isTurnRunning = false
    if (phase === 'waiting') {
      cancelTimer()
      phase = 'idle'
    } else if (phase === 'playing') {
      if (e.isAborted) await pullOut($)
      else startCountdown($)
    }
    return next(e)
  })

  on('tool.check', async ($, e, next) => {
    const result = await next(e)
    // In auto mode an ask can go to the classifier instead of the person;
    // pulling out anyway costs a moment, missing a real prompt costs more
    if (e.tool_use_id && result.decision === 'ask') await needsYou($)
    return result
  })

  on('tool.call', async ($, e, next) => {
    if (e.tool === 'AskUserQuestion') await needsYou($)
    const result = await next(e)
    // Once an answered prompt lets Claude carry on, drop back in
    armDropIn($)
    return result
  })

  on('ui.close', async ($, e, next) => {
    if (e.id !== PANE) return next(e)
    if (e.origin?.kind === 'person' && isTurnRunning) isDismissed = true
    await goAway($)
    return next(e)
  })

  on('ui.message', async ($, e) => {
    if (e.element !== 'input') return {}
    clientLine = e.data.line
    await writeInput($)
    return {}
  })

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (phase === 'idle' || phase === 'waiting' || !score) return next(e)
    return next({ ...e, props: { ...e.props, suffix: ' · ' + scoreText(score) + '…' } })
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const { Box, Text, Image, Client, Button } = $.ui.resolve(e)

    if (isWelcomeOpen) {
      return Box({
        flexDirection: 'column',
        gap: 1,
        children: [
          Text({ bold: true, children: ['intermission is on'] }),
          Text({
            children: [
              'When Claude has been working for 2 seconds you drop into Doom here, and you get handed back when it is done or needs you.',
            ],
          }),
          Text({ dimColor: true, children: ['/intermission off turns it off.'] }),
          Button({
            key: 'got-it',
            label: 'Got it',
            autoFocus: true,
            onPress: async () => {
              isWelcomeOpen = false
              await $.ui.close({ id: PANE })
            },
          }),
        ],
      })
    }

    if (e.surface !== 'terminal') return Text({ children: ['intermission needs the terminal, in Ghostty or kitty.'] })
    if (!frame) return Text({ children: ['Joining the game as ' + name + '…'] })
    // Terminal cells are about twice as tall as they are wide
    const columns = Math.min(255, e.props.bodyColumns)
    const rows = Math.max(1, Math.round((columns * HEIGHT) / WIDTH / 2))
    const status =
      phase === 'countdown'
        ? Text({ bold: true, children: ["Claude's done · back in " + countdown] })
        : Text({
            dimColor: true,
            children: ['Click the game to play and lock the mouse · Esc or ⌘ releases it · WASD or arrows · left click fires · right click runs · space opens'],
          })
    return Box({
      flexDirection: 'column',
      children: [
        Image({ key: 'view', source: shmSource(frame), columns, rows, alt: 'Doom' }),
        // Laid over the picture, so clicks land on the game
        Box({
          position: 'absolute',
          top: 0,
          left: 0,
          children: [Client({ key: 'input', module: './input.js', width: columns, height: rows })],
        }),
        status,
      ],
    })
  })
}
