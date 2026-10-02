import { expect, mock, test } from 'claude-code/testing'

// Answers everything the mod asks of Claude Code, and counts the pane opening
// and closing, which is what the person sees. isPlaced(n) says whether the nth
// open gets room on screen, as it may not in a narrow terminal.
function stubClaudeCode(on, clock, { isOn = true, isPlaced = (n) => true, isServerUnreachable = false } = {}) {
  const pane = { opens: 0, closes: 0, engines: [] }
  on('store.get', ($, e) => ({ value: e.key === 'isOn' ? isOn : 'TestMarine' }))
  on('store.set', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('ui.open', () => {
    pane.opens += 1
    return { value: isPlaced(pane.opens) ? { isPlaced: true } : { isPlaced: false, reason: 'narrow' } }
  })
  // What Claude Code itself draws in the band, under anything the mod adds
  on('ui.render', () => ({ type: 'Text', props: {}, children: [''] }))
  on('ui.close', () => {
    pane.closes += 1
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: true }))
  // The engine runs for longer than any test. The first one, when the server
  // never answers, draws frames for 11 seconds without reporting connecting.
  on('process.spawn', async function* ($, e) {
    pane.engines.push(e.argv)
    if (isServerUnreachable && pane.engines.length === 1) {
      yield { stream: 'stdout', text: '@frame /imtest-0 640 360\n' }
      await clock.sleep(11 * 1000)
      yield { stream: 'stdout', text: '@frame /imtest-1 640 360\n' }
    }
    await clock.sleep(60 * 60 * 1000)
  })
  on('ui.blit', () => ({ value: {} }))
  on('ui.log', () => ({ value: undefined }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.check', () => ({ decision: 'ask' }))
  on('tool.call', () => ({ result: 'ok' }))
  return pane
}

async function startSession($) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
}

function finishTurn($, fields = {}) {
  return $.turn.complete({ turnId: 't1', answer: '', durationMs: 1000, isAborted: false, usage: null, ...fields })
}

const askPermission = ($) => $.tool.check({ tool: 'Bash', input: { command: 'rm -rf build' }, tool_use_id: 'u1' })

test('drops in once Claude has worked for two seconds', async ($, on) => {
  const clock = mock.clock(on)
  const pane = stubClaudeCode(on, clock)
  await startSession($)

  await $.turn.start({ turnId: 't1', text: 'refactor auth' })
  await clock.advance(1999)
  expect(pane.opens).toBe(0)
  await clock.advance(1)
  expect(pane.opens).toBe(1)
})

test('stays out of a turn that ends before the delay', async ($, on) => {
  const clock = mock.clock(on)
  const pane = stubClaudeCode(on, clock)
  await startSession($)

  await $.turn.start({ turnId: 't1', text: 'hi' })
  await clock.advance(1000)
  await finishTurn($)
  await clock.advance(5000)
  expect(pane.opens).toBe(0)
})

test('stays out while intermission is off', async ($, on) => {
  const clock = mock.clock(on)
  const pane = stubClaudeCode(on, clock, { isOn: false })
  await startSession($)

  await $.turn.start({ turnId: 't1', text: 'refactor auth' })
  await clock.advance(5000)
  expect(pane.opens).toBe(0)
})

test('counts down three seconds when Claude finishes, then hands back', async ($, on) => {
  const clock = mock.clock(on)
  const pane = stubClaudeCode(on, clock)
  await startSession($)

  await $.turn.start({ turnId: 't1', text: 'refactor auth' })
  await clock.advance(2000)
  await finishTurn($)
  await clock.advance(2999)
  expect(pane.closes).toBe(0)
  await clock.advance(1)
  expect(pane.closes).toBe(1)
})

test('hands back at once when the person interrupts Claude', async ($, on) => {
  const clock = mock.clock(on)
  const pane = stubClaudeCode(on, clock)
  await startSession($)

  await $.turn.start({ turnId: 't1', text: 'refactor auth' })
  await clock.advance(2000)
  await finishTurn($, { isAborted: true })
  expect(pane.closes).toBe(1)
})

test('keeps playing when a subagent finishes', async ($, on) => {
  const clock = mock.clock(on)
  const pane = stubClaudeCode(on, clock)
  await startSession($)

  await $.turn.start({ turnId: 't1', text: 'refactor auth' })
  await clock.advance(2000)
  await finishTurn($, { turnId: 't2', agentId: 'a1' })
  await clock.advance(5000)
  expect(pane.closes).toBe(0)
})

test('hands back at once when Claude asks for permission', async ($, on) => {
  const clock = mock.clock(on)
  const pane = stubClaudeCode(on, clock)
  await startSession($)

  await $.turn.start({ turnId: 't1', text: 'clean up' })
  await clock.advance(2000)
  await askPermission($)
  expect(pane.closes).toBe(1)
})

test('drops back in once the permission prompt is answered', async ($, on) => {
  const clock = mock.clock(on)
  const pane = stubClaudeCode(on, clock)
  await startSession($)

  await $.turn.start({ turnId: 't1', text: 'clean up' })
  await clock.advance(2000)
  await askPermission($)
  // The call goes ahead once the person answers
  await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
  await clock.advance(2000)
  expect(pane.opens).toBe(2)
})

test('a permission prompt during the countdown hands back at once', async ($, on) => {
  const clock = mock.clock(on)
  const pane = stubClaudeCode(on, clock)
  await startSession($)

  await $.turn.start({ turnId: 't1', text: 'clean up' })
  await clock.advance(2000)
  await finishTurn($)
  await clock.advance(1000)
  await askPermission($)
  expect(pane.closes).toBe(1)
  // The countdown's own close never comes on top
  await clock.advance(5000)
  expect(pane.closes).toBe(1)
})

const BAND = {
  plugin: 'intermission',
  component: 'AbovePrompt',
  requestId: 'band',
  surface: 'terminal',
  viewport: { columns: 100, rows: 30 },
  props: { hasSurvey: false, isWorking: true, maxRows: 4, bodyColumns: 100, scroll: { offset: 0, bodyRows: 4 }, view: {} },
} as const

test('offers a key in a narrow terminal, and pressing it drops in', async ($, on) => {
  const clock = mock.clock(on)
  // The pane can't open by itself, but opens when the person asks
  const pane = stubClaudeCode(on, clock, { isPlaced: (n) => n > 1 })
  await startSession($)

  await $.turn.start({ turnId: 't1', text: 'refactor auth' })
  await clock.advance(2000)
  const band = await $.ui.mount(BAND)
  await band.press({ key: 'play' })
  expect(pane.opens).toBe(2)
  // Claude finishing now counts down like any other round
  await finishTurn($)
  await clock.advance(3000)
  expect(pane.closes).toBe(2)
})

test('withdraws the offer when Claude finishes first', async ($, on) => {
  const clock = mock.clock(on)
  stubClaudeCode(on, clock, { isPlaced: () => false })
  await startSession($)

  await $.turn.start({ turnId: 't1', text: 'refactor auth' })
  await clock.advance(2000)
  const offered = await $.ui.mount(BAND)
  expect(await offered.find({ key: 'play' })).toBeDefined()
  await offered.unmount()
  await finishTurn($)
  const withdrawn = await $.ui.mount(BAND)
  expect(await withdrawn.find({ key: 'play' })).toBeUndefined()
})

test('plays offline when the server never answers', async ($, on) => {
  const clock = mock.clock(on)
  const pane = stubClaudeCode(on, clock, { isServerUnreachable: true })
  await startSession($)

  await $.turn.start({ turnId: 't1', text: 'refactor auth' })
  await clock.advance(2000)
  expect(pane.engines.length).toBe(1)
  expect(pane.engines[0]).toContain('+connect')
  await clock.advance(12000)
  // The pane stays open while a local game takes over
  expect(pane.engines.length).toBe(2)
  expect(pane.engines[1]).toContain('+map')
  expect(pane.closes).toBe(0)
})
