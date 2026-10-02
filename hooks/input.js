// Catches keys and the mouse over the game picture and posts what is held,
// which the hooks module writes to the engine's input file.
//
// The terminal reports presses, never releases. A key counts as held until
// its auto-repeat stops: long after a single press, because the first repeat
// comes late, and briefly once repeats are flowing. Mouse buttons do report
// releases. The pointer's distance from the centre steers like a joystick,
// because a terminal can't capture the mouse for ordinary mouse-look.

const HOLD_AFTER_PRESS_MS = 550
const HOLD_WHILE_REPEATING_MS = 120
const DEAD_ZONE = 0.15
const MAX_TURN = 60

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

// From -MAX_TURN to MAX_TURN, by how far the pointer is from the centre
function steer(x, columns) {
  if (x === null || columns === 0) return 0
  const offset = Math.max(-1, Math.min(1, (x - columns / 2) / (columns / 2)))
  const beyond = Math.abs(offset) - DEAD_ZONE
  if (beyond <= 0) return 0
  return Math.sign(offset) * Math.round(MAX_TURN * (beyond / (1 - DEAD_ZONE)) ** 1.5)
}

export default function GameInput(props, surface) {
  if (surface.state === undefined) {
    const input = {
      presses: new Map(), // key code -> { at, isRepeating }
      buttons: new Set(),
      pointerX: null,
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
      if (e.type === 'leave') input.pointerX = null
      else input.pointerX = e.fine?.x ?? e.x + 0.5
      const code = e.button === 'left' ? MOUSE_FIRE : e.button === 'right' ? KEY_FORWARD : null
      if (code === null) return
      if (e.type === 'down') input.buttons.add(code)
      if (e.type === 'up') input.buttons.delete(code)
    })

    surface.every(30, () => {
      const now = Date.now()
      const keys = new Set(input.buttons)
      for (const [code, press] of input.presses) {
        const holdMs = press.isRepeating ? HOLD_WHILE_REPEATING_MS : HOLD_AFTER_PRESS_MS
        if (now - press.at < holdMs) keys.add(code)
        else input.presses.delete(code)
      }
      const turn = steer(input.pointerX, surface.columns)
      const line = [turn, ...[...keys].sort()].join(' ')
      if (line === input.posted) return
      input.posted = line
      surface.post({ line })
    })

    surface.setState(input)
  }

  const { Box } = surface.elements
  return Box({ width: '100%', height: '100%' })
}
