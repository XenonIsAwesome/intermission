// Catches keys and clicks over the game picture and posts what is held, which
// the hooks module writes to the engine's input file. Each click also asks the
// engine to lock the cursor, which it then reads for mouse-look itself.
//
// The terminal reports presses, never releases. A key counts as held until
// its auto-repeat stops: long after a single press, because the first repeat
// comes late, and briefly once repeats are flowing. Mouse buttons do report
// releases.

const HOLD_AFTER_PRESS_MS = 550
const HOLD_WHILE_REPEATING_MS = 120

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
      clicks: 0,
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
      const code = e.button === 'left' ? MOUSE_FIRE : e.button === 'right' ? KEY_FORWARD : null
      if (code === null) return
      if (e.type === 'down') {
        input.buttons.add(code)
        input.clicks += 1
      }
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
      const line = [input.clicks, ...[...keys].sort()].join(' ')
      if (line === input.posted) return
      input.posted = line
      surface.post({ line })
    })

    surface.setState(input)
  }

  const { Box } = surface.elements
  return Box({ width: '100%', height: '100%' })
}
