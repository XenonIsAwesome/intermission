// Plays Doom in a pane. This cut opens on /intermission, shows the engine's
// frames and passes keys and the mouse through; multiplayer and the turn
// triggers come next.

const PANE = 'intermission'
const WIDTH = 640
const HEIGHT = 360

// The running engine's output stream, the newest frame it wrote, and the file
// it reads input from
let engine = null
let frame = null
let inputPath = null

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
    await $.command.register({ name: 'intermission', description: 'Open the Doom pane' })
    return next(e)
  })

  on('command.run', { command: 'intermission' }, async ($) => {
    await $.ui.open({ id: PANE, title: 'intermission', focus: true, closeOnEscape: true, rows: 34 })
    if (!engine) void runEngine($)
    return {}
  })

  on('ui.close', async ($, e, next) => {
    // Leaving the stream's loop is what stops the engine
    if (e.id === PANE && engine) await engine.return()
    return next(e)
  })

  on('ui.message', async ($, e) => {
    if (e.element === 'input' && inputPath) await $.fs.write(inputPath, e.data.line + '\n')
    return {}
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const { Box, Text, Image, Client } = $.ui.resolve(e)
    if (e.surface !== 'terminal') return Text({ children: ['intermission needs the terminal, in Ghostty or kitty.'] })
    if (!frame) return Text({ children: ['Loading…'] })
    // Terminal cells are about twice as tall as they are wide
    const columns = Math.min(255, e.props.bodyColumns)
    const rows = Math.max(1, Math.round((columns * HEIGHT) / WIDTH / 2))
    return Box({
      flexDirection: 'column',
      children: [
        Image({ key: 'view', source: shmSource(frame), columns, rows, alt: 'Doom' }),
        // Laid over the picture, so clicks and the pointer land on the game
        Box({
          position: 'absolute',
          top: 0,
          left: 0,
          children: [Client({ key: 'input', module: './input.js', width: columns, height: rows })],
        }),
        Text({
          dimColor: true,
          children: ['Click the game to play and lock the mouse · Esc or ⌘ releases it · WASD or arrows · left click fires · right click runs · space opens'],
        }),
      ],
    })
  })
}
