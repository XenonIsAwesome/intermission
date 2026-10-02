import { expect, mock, test } from 'claude-code/testing'

// Answers everything the mod asks of Claude Code, and counts the pane opening
// and closing, which is what the person sees
function stubClaudeCode(on, clock, { isOn = true } = {}) {
  const pane = { opens: 0, closes: 0 }
  on('store.get', ($, e) => ({ value: e.key === 'isOn' ? isOn : 'TestMarine' }))
  on('store.set', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('ui.open', () => {
    pane.opens += 1
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => {
    pane.closes += 1
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('fs.write', () => ({ value: undefined }))
  // The engine runs for longer than any test
  on('process.spawn', async function* () {
    await clock.sleep(60 * 60 * 1000)
  })
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
