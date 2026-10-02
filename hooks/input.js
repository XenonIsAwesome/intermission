// Catches keys and the mouse over the game picture and posts what is held,
// which the hooks module writes to the engine's input file.
//
// The terminal reports presses, never releases. A key counts as held until
// its auto-repeat stops: long after a single press, because the first repeat
// comes late, and briefly once repeats are flowing. Mouse buttons do report
// releases.
//
// Moving the mouse turns by how far it moved, as in any FPS. A terminal can't
// capture the cursor, so parking it in a strip at either side keeps turning
// that way. While a button is held the pointer is reported past the edges
// too, so a drag can keep turning beyond the picture.

const HOLD_AFTER_PRESS_MS = 550
const HOLD_WHILE_REPEATING_MS = 120
const MOUSE_PER_COLUMN = 40
const EDGE_COLUMNS = 3
const EDGE_TURN_PER_TICK = 60

const MOUSE_FIRE = 0x20000000
const KEY_FORWARD = 'w'.charCodeAt(0)

const SPECIAL_KEYS = {
  up: 0x40000052,
  down: 0x40000051,
  left: 0x40000050,
  right: 0x4000004f,
  return: 0x0d,
  tab: 0x09,
}

function keyCode(key) {
  if (SPECIAL_KEYS[key]) return SPECIAL_KEYS[key]
  return key.length === 1 ? key.toLowerCase().charCodeAt(0) : null
}

export default function GameInput(props, surface) {
  if (surface.state === undefined) {
    const input = {
      presses: new Map(), // key code -> { at, isRepeating }
      buttons: new Set(),
      // Tells the engine this is a new running total, not motion
      writer: 1 + Math.floor(Math.random() * 1e9),
      mouse: 0,
      lastX: null,
      edge: 0, // -1 turning left, 1 turning right
      posted: '',
    }

    surface.onKey((e) => {
      const code = keyCode(e.key)
      if (code === null) return
      const now = Date.now()
      const last = input.presses.get(code)
      input.presses.set(code, { at: now, isRepeating: !!last && now - last.at < HOLD_AFTER_PRESS_MS })
    })

    surface.onPointer((e) => {
      if (e.type === 'leave' || e.type === 'enter') {
        // Where the pointer was before it left says nothing about motion now
        input.lastX = null
        input.edge = 0
      } else {
        const x = e.fine?.x ?? e.x + 0.5
        if (input.lastX !== null) input.mouse += (x - input.lastX) * MOUSE_PER_COLUMN
        input.lastX = x
        input.edge = x < EDGE_COLUMNS ? -1 : x > surface.columns - EDGE_COLUMNS ? 1 : 0
      }
      const code = e.button === 'left' ? MOUSE_FIRE : e.button === 'right' ? KEY_FORWARD : null
      if (code === null) return
      if (e.type === 'down') input.buttons.add(code)
      if (e.type === 'up') input.buttons.delete(code)
    })

    surface.every(30, () => {
      const now = Date.now()
      input.mouse += input.edge * EDGE_TURN_PER_TICK
      const keys = new Set(input.buttons)
      for (const [code, press] of input.presses) {
        const holdMs = press.isRepeating ? HOLD_WHILE_REPEATING_MS : HOLD_AFTER_PRESS_MS
        if (now - press.at < holdMs) keys.add(code)
        else input.presses.delete(code)
      }
      const line = [input.writer, Math.round(input.mouse), ...[...keys].sort()].join(' ')
      if (line === input.posted) return
      input.posted = line
      surface.post({ line })
    })

    surface.setState(input)
  }

  const { Box } = surface.elements
  return Box({ width: '100%', height: '100%' })
}
