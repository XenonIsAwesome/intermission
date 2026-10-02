// intermission: drops you into Doom while Claude works and hands you back when
// it's done, or as soon as it needs you.

const PANE = 'intermission'
const WIDTH = 640
const HEIGHT = 360
const DROP_IN_DELAY_MS = 2000
const COUNTDOWN_SECONDS = 3

// Whether the person turned intermission on, kept between sessions in $.store
let isOn = false

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

// The running engine's output stream, the newest frame it wrote, and the file
// it reads input from
let engine = null
let frame = null
let inputPath = null

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
  if (!engine) void runEngine($)
}

async function pullOut($) {
  cancelTimer()
  phase = 'idle'
  await $.ui.close({ id: PANE })
}

function startCountdown($) {
  phase = 'countdown'
  countdown = COUNTDOWN_SECONDS
  $.ui.invalidate('ui.render')
  timer = $.clock.every(1000, () => {
    countdown -= 1
    if (countdown > 0) $.ui.invalidate('ui.render')
    else void pullOut($)
  })
}

// Claude is about to ask the person something, so they must see the prompt
async function needsYou($) {
  if (phase === 'waiting') {
    cancelTimer()
    phase = 'idle'
  } else if (phase !== 'idle') {
    await pullOut($)
  }
}

function engineRequest(root, id) {
  return {
    argv: [
      root + '/dist/odamex.app/Contents/MacOS/odamex',
      '-iwad', root + '/dist/freedoom2.wad',
      '-width', String(WIDTH),
      '-height', String(HEIGHT),
      '+vid_fullscreen', '0',
      '+vid_maxfps', '35',
      '+map', 'MAP01',
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
  await $.fs.write(inputPath, '0\n')
  engine = $.process.spawn(engineRequest($.plugin.root, id))
  let pending = ''
  try {
    for await (const { stream, text } of engine) {
      if (stream !== 'stdout') continue
      // Pieces arrive as written, not as lines
      const lines = (pending + text).split('\n')
      pending = lines.pop()
      for (const line of lines) {
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
    $.ui.toast("intermission couldn't start the game")
    await pullOut($)
  } finally {
    engine = null
    frame = null
    inputPath = null
  }
}

function shmSource(name) {
  return { shm: name, format: 'rgb', width: WIDTH, height: HEIGHT }
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    isOn = (await $.store.get('isOn')) === true
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
    cancelTimer()
    phase = 'idle'
    isWelcomeOpen = false
    // Leaving the stream's loop is what stops the engine
    if (engine) await engine.return()
    return next(e)
  })

  on('ui.message', async ($, e) => {
    if (e.element === 'input' && inputPath) await $.fs.write(inputPath, e.data.line + '\n')
    return {}
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
    if (!frame) return Text({ children: ['Loading…'] })
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
