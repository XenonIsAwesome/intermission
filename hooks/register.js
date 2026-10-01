// Plays Doom in a pane. This first cut opens on /intermission and shows the
// engine's frames; input, multiplayer and the turn triggers come next.

const PANE = 'intermission'
const WIDTH = 640
const HEIGHT = 360

// The running engine's output stream, and the newest frame it wrote
let engine = null
let frame = null

function engineRequest(root) {
  // A per-run prefix keeps two sessions' frames from colliding in shared memory
  const prefix = '/im' + Math.random().toString(36).slice(2, 6) + '-'
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
      INTERMISSION_FRAMES: prefix,
    },
  }
}

async function runEngine($) {
  engine = $.process.spawn(engineRequest($.plugin.root))
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
    await $.ui.open({ id: PANE, title: 'intermission', focus: true, closeOnEscape: true, rows: 32 })
    if (!engine) void runEngine($)
    return {}
  })

  on('ui.close', async ($, e, next) => {
    // Leaving the stream's loop is what stops the engine
    if (e.id === PANE && engine) await engine.return()
    return next(e)
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const { Text, Image } = $.ui.resolve(e)
    if (e.surface !== 'terminal') return Text({ children: ['intermission needs the terminal, in Ghostty or kitty.'] })
    if (!frame) return Text({ children: ['Loading…'] })
    // Terminal cells are about twice as tall as they are wide
    const columns = Math.min(255, e.props.bodyColumns)
    const rows = Math.max(1, Math.round((columns * HEIGHT) / WIDTH / 2))
    return Image({ key: 'view', source: shmSource(frame), columns, rows, alt: 'Doom' })
  })
}
