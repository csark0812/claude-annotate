import { expect, test } from 'claude-code/testing'

const SESSIONS = '/home/me/.cache/claude-annotate/sessions'
const BRIDGE = { endpoint: 'http://127.0.0.1:4000', token: 't0k', cwd: '/repo', startedAt: 1 }
const PAGE = 'http://localhost:3000/'

const PREVIEW = { src: 'data:image/jpeg;base64,AAAA', w: 280, h: 160 }

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: the band shows unsent notes with their pictures, and what Claude has not finished`, async ($, on) => {
    const notes = [{ n: 2, text: 'bigger title', preview: PREVIEW }]
    const sent = [
      { url: PAGE, n: 1, text: 'make this blue', status: 'working', result: '', batch: 1, preview: PREVIEW },
      { url: PAGE, n: 0, text: 'old one', status: 'done', result: 'ok', batch: 1, preview: null },
    ]

    on('process.run', () => ({ value: { exitCode: 0, stdout: '/home/me\n4242\n', stderr: '' } }) as never)
    on('fs.exists', (_$, e) => ({ value: e.path === SESSIONS || e.path === `${SESSIONS}/4242.json` }))
    on('fs.read', () => ({ value: JSON.stringify(BRIDGE) }))
    on('fs.list', () => ({ value: [] }))
    on('clock.every', () => ({ value: undefined }))
    on('command.register', () => ({ value: { command: 'annotations' } }))
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    on('ui.status', () => ({ value: undefined }))
    on('http.fetch', () => ({ value: {
      status: 200,
      ok: true,
      headers: {},
      text: JSON.stringify({
        ok: true,
        mode: 'chat',
        totals: { notes: 1, shapes: 0, pages: 1, unsent: 1, open: 1, sent: 2, batches: 1 },
        pages: [{ url: PAGE, notes, shapes: 0 }],
        sent,
        delivery: { queued: 0, listening: true },
      }),
    } }))

    on('ui.render', () => ({ type: 'Box', props: {}, children: [] }) as never)
    await $.session.start({ cwd: '/repo', surface, isInteractive: true } as never)
    await $.command.run({ command: 'annotations', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
    const band = await $.ui.mount({ plugin: 'annotate', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false } as never })

    // Closed, the band is one chip, like Codex's; only what has not gone out yet.
    expect((await band.find({ key: 'chip' }))?.props.label).toContain('1 annotation')
    expect(await band.find({ key: 'card:http://localhost:3000/#2' })).toBeUndefined()
    expect(await band.find({ text: /Claude is on/ })).toBeUndefined()
    // The closed chip carries the page's picture on the desktop.
    expect((await band.find({ key: `chip-pic:${PAGE}#2` })) !== undefined).toBe(surface === 'desktop')

    // Closed, the chip says what the notes say, under it.
    expect((await band.find({ key: 'gist' })) !== undefined).toBe(true)
    expect(await band.find({ text: /2 bigger title/ })).toBeDefined()

    await band.press({ key: 'chip' })
    expect(await band.find({ key: 'gist' })).toBeUndefined()
    expect(await band.find({ text: /bigger title/ })).toBeDefined()
    // Sent: no card, one line while Claude works on it; a finished note is gone from the bar.
    expect(await band.find({ key: `card:${PAGE}#1` })).toBeUndefined()
    expect(await band.find({ text: /◐ 1 make this blue/ })).toBeDefined()
    expect(await band.find({ text: /old one/ })).toBeUndefined()
    // The desktop draws each note's picture; the terminal goes without.
    expect((await band.find({ key: `thumb:${PAGE}#2` })) !== undefined).toBe(surface === 'desktop')
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: /annotations lists the notes as text and opens no pane`, async ($, on) => {
    const notes = [{ n: 1, text: 'make this blue' }]

    on('process.run', () => ({ value: { exitCode: 0, stdout: '/home/me\n4242\n', stderr: '' } }) as never)
    on('fs.exists', (_$, e) => ({ value: e.path === SESSIONS || e.path === `${SESSIONS}/4242.json` }))
    on('fs.read', () => ({ value: JSON.stringify(BRIDGE) }))
    on('fs.list', () => ({ value: [] }))
    on('clock.every', () => ({ value: undefined }))
    on('command.register', () => ({ value: { command: 'annotations' } }))
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    on('ui.status', () => ({ value: undefined }))
    let opened = false
    on('ui.open', () => { opened = true; return { value: { isPlaced: true } } })
    on('http.fetch', () => ({ value: {
      status: 200,
      ok: true,
      headers: {},
      text: JSON.stringify({
        ok: true,
        mode: 'chat',
        totals: { notes: 1, shapes: 0, pages: 1, unsent: 1, open: 0, batches: 0 },
        pages: [{ url: PAGE, notes, shapes: 0 }],
        batches: [],
      }),
    } }))

    await $.session.start({ cwd: '/repo', surface, isInteractive: true } as never)
    const out = await $.command.run({ command: 'annotations', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

    expect(opened).toBe(false)
    expect(out.text).toContain('Annotations activated · ✎ 1 note')
    expect(out.text).toContain(PAGE)
    expect(out.text).toContain('1. make this blue')
  })

}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: the chip's × asks first, then discards through the bridge`, async ($, on) => {
    let notes = [{ n: 1, text: 'make this blue', color: 'cyan' }]
    const posted: string[] = []

    on('process.run', () => ({ value: { exitCode: 0, stdout: '/home/me\n4242\n', stderr: '' } }) as never)
    on('fs.exists', (_$, e) => ({ value: e.path === SESSIONS || e.path === `${SESSIONS}/4242.json` }))
    on('fs.read', () => ({ value: JSON.stringify(BRIDGE) }))
    on('fs.list', () => ({ value: [] }))
    on('clock.every', () => ({ value: undefined }))
    on('command.register', () => ({ value: { command: 'annotations' } }))
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    on('ui.status', () => ({ value: undefined }))
    on('http.fetch', (_$, e) => {
      posted.push(e.url)
      if (e.url.endsWith('/clear')) {
        notes = []
        return { value: { status: 200, ok: true, headers: {}, text: '{"ok":true}' } }
      }
      return { value: {
        status: 200,
        ok: true,
        headers: {},
        text: JSON.stringify({
          ok: true,
          mode: 'chat',
          totals: { notes: notes.length, shapes: 0, pages: notes.length ? 1 : 0, unsent: notes.length, open: 0, batches: 0 },
          pages: notes.length ? [{ url: PAGE, notes, shapes: 0 }] : [],
          batches: [],
        }),
      } }
    })

    on('ui.render', () => ({ type: 'Box', props: {}, children: [] }) as never)
    await $.session.start({ cwd: '/repo', surface, isInteractive: true } as never)
    await $.command.run({ command: 'annotations', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
    const ui = await $.ui.mount({ plugin: 'annotate', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false } as never })

    await ui.press({ key: 'discard' })
    expect(posted.some(u => u.endsWith('/clear'))).toBe(false)
    expect(await ui.find({ text: /Discard 1 annotation\?/ })).toBeDefined()

    await ui.press({ key: 'discard-yes' })
    expect(posted.some(u => u.endsWith('/clear'))).toBe(true)
    expect(await ui.find({ text: /make this blue/ })).toBeUndefined()
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: unsent notes ride along with the next prompt; the chip above it lists them`, async ($, on) => {
    let notes = [
      { n: 1, text: 'make it blue', color: 'pink' },
      { n: 2, text: 'bigger title', color: 'cyan' },
    ]
    const sends: { skip?: string[]; from?: string }[] = []
    const reached: { text: string; context?: readonly string[] }[] = []

    on('process.run', () => ({ value: { exitCode: 0, stdout: '/home/me\n4242\n', stderr: '' } }) as never)
    on('fs.exists', (_$, e) => ({ value: e.path === SESSIONS || e.path === `${SESSIONS}/4242.json` }))
    on('fs.read', () => ({ value: JSON.stringify(BRIDGE) }))
    on('fs.list', () => ({ value: [] }))
    on('clock.every', () => ({ value: undefined }))
    on('command.register', () => ({ value: { command: 'annotations' } }))
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    on('ui.status', () => ({ value: undefined }))
    on('prompt.submit', (_$, e) => {
      reached.push({ text: e.text, context: e.context })
      return { text: e.text, context: e.context }
    })
    on('http.fetch', (_$, e) => {
      if (e.url.endsWith('/note/delete')) {
        const { n } = JSON.parse(e.init?.body ?? '{}')
        notes = notes.filter(note => note.n !== n)
        return { value: { status: 200, ok: true, headers: {}, text: '{"ok":true}' } }
      }
      if (e.url.endsWith('/send')) {
        const body = JSON.parse(e.init?.body ?? '{}')
        sends.push(body)
        const going = notes.filter(note => !(body.skip ?? []).includes(`${PAGE}#${note.n}`))
        if (!going.length) return { value: { status: 400, ok: false, headers: {}, text: JSON.stringify({ ok: false, error: 'Nothing to send yet.' }) } }
        notes = notes.filter(note => !going.includes(note))
        return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ok: true, content: `Browser annotations · batch 1 · 1 page · ${going.length} notes · 0 marks\n${going.map(n => `### Note ${n.n} — "${n.text}"`).join('\n')}` }) } }
      }
      return { value: {
        status: 200,
        ok: true,
        headers: {},
        text: JSON.stringify({
          ok: true,
          mode: 'chat',
          totals: { notes: notes.length, shapes: 0, pages: notes.length ? 1 : 0, unsent: notes.length, open: 0, sent: 0, batches: 0 },
          pages: notes.length ? [{ url: PAGE, notes, shapes: 0 }] : [],
          sent: [],
          batches: [],
          delivery: { queued: 0, listening: true },
        }),
      } }
    })

    let rowText = ''
    on('ui.render', (_$, e) => {
      if (e.component === 'UserMessage') rowText = (e.props as { text: string }).text
      return { type: 'Box', props: {}, children: [] } as never // the engine's own band: nothing
    })
    await $.session.start({ cwd: '/repo', surface, isInteractive: true } as never)
    await $.command.run({ command: 'annotations', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } }).catch(() => {}) // waits for the first refresh
    const band = await $.ui.mount({ plugin: 'annotate', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false } as never })
    await band.press({ key: 'chip' })
    expect(await band.find({ text: /make it blue/ })).toBeDefined()
    expect(await band.find({ text: /bigger title/ })).toBeDefined()

    // The trash deletes a note from its page, so it does not go.
    await band.press({ key: `delete:${PAGE}#2` })
    expect(await band.find({ text: /bigger title/ })).toBeUndefined()

    await $.prompt.submit({ text: 'fix these', origin: { kind: 'composer' } } as never)
    expect(sends).toEqual([{ from: 'prompt' }])
    expect(reached.at(-1)?.context?.at(-1)).toContain('### Note 1 — "make it blue"')

    // The sent row names what went with it, under the words typed.
    const row = await $.ui.mount({ plugin: 'annotate', surface, component: 'UserMessage', props: { text: 'fix these', origin: { kind: 'composer' }, isExpanded: false } as never })
    await row.drawn()
    expect(rowText).toBe('fix these\n📎 1 annotation: 1 make it blue')

    // Nothing left: the server is still asked (the bar may be behind it), and the prompt goes alone.
    await $.command.run({ command: 'annotations', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } }).catch(() => {})
    await $.prompt.submit({ text: 'thanks', origin: { kind: 'composer' } } as never)
    expect(reached.at(-1)?.context ?? []).toEqual([])
    expect(sends.length).toBe(2)
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: no Send: a saved note is on its way to Claude by itself`, async ($, on) => {
    const sends: unknown[] = []
    on('process.run', () => ({ value: { exitCode: 0, stdout: '/home/me\n4242\n', stderr: '' } }) as never)
    on('fs.exists', (_$, e) => ({ value: e.path === SESSIONS || e.path === `${SESSIONS}/4242.json` }))
    on('fs.read', () => ({ value: JSON.stringify(BRIDGE) }))
    on('fs.list', () => ({ value: [] }))
    on('clock.every', () => ({ value: undefined }))
    on('command.register', () => ({ value: { command: 'annotations' } }))
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    on('ui.status', () => ({ value: undefined }))
    on('http.fetch', (_$, e) => {
      if (e.url.endsWith('/send')) sends.push(e.url)
      return { value: { status: 200, ok: true, headers: {}, text: overviewWith([TAB], [{ n: 1, text: 'make it blue', color: 'blue' }]) } }
    })
    on('ui.render', () => ({ type: 'Box', props: {}, children: [] }) as never)
    await $.session.start({ cwd: '/repo', surface, isInteractive: true } as never)
    await $.command.run({ command: 'annotations', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
    const band = await $.ui.mount({ plugin: 'annotate', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false } as never })

    expect(await band.find({ key: 'send' })).toBeUndefined()
    expect(await band.find({ text: /Sending to Claude/ })).toBeDefined()
    expect(sends).toEqual([]) // the server sends it; the bar only shows it going
  })
}

const TAB = { id: 'tab1', url: 'http://localhost:3000/pricing', title: 'Pricing', kind: 'annotating', local: true, visible: true, since: 1 }
const overviewWith = (tabs: unknown[], notes: unknown[] = [], rev = 1) => JSON.stringify({
  ok: true,
  rev,
  mode: 'chat',
  totals: { notes: notes.length, shapes: 0, pages: notes.length ? 1 : 0, unsent: notes.length, open: 0, sent: 0, batches: 0 },
  tabs,
  pages: notes.length ? [{ url: PAGE, notes, shapes: 0 }] : [],
  sent: [],
  delivery: { queued: 0, listening: true },
})
type TestOn = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[1]
function bridgeAt4242(on: TestOn) {
  on('process.run', () => ({ value: { exitCode: 0, stdout: '/home/me\n4242\n', stderr: '' } }) as never)
  on('fs.exists', (_$, e) => ({ value: e.path === SESSIONS || e.path === `${SESSIONS}/4242.json` }))
  on('fs.read', () => ({ value: JSON.stringify(BRIDGE) }))
  on('fs.list', () => ({ value: [] }))
  on('clock.every', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'annotations' } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }) as never)
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: annotating with no notes shows the bar; its ✕ turns annotating off`, async ($, on) => {
    const posted: string[] = []
    let tabs: unknown[] = [TAB]
    bridgeAt4242(on)
    on('process.spawn', async function* () { return { value: { code: 0, signal: null } } } as never)
    on('http.fetch', (_$, e) => {
      posted.push(e.url)
      if (e.url.endsWith('/stop')) { tabs = []; return { value: { status: 200, ok: true, headers: {}, text: '{"ok":true}' } } }
      return { value: { status: 200, ok: true, headers: {}, text: overviewWith(tabs, [], tabs.length ? 1 : 2) } }
    })
    await $.session.start({ cwd: '/repo', surface, isInteractive: true } as never)
    await $.command.run({ command: 'annotations', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
    const band = await $.ui.mount({ plugin: 'annotate', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false } as never })

    expect(await band.find({ text: /Annotating · localhost:3000\/pricing/ })).toBeDefined()
    expect(await band.find({ text: /Click an element/ })).toBeDefined()
    expect(await band.find({ key: 'send' })).toBeUndefined()

    await band.press({ key: 'stop' })
    expect(posted.some(u => u.endsWith('/stop'))).toBe(true)
    expect(await band.find({ text: /Annotating/ })).toBeUndefined()
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: no tab and no notes: no bar`, async ($, on) => {
    bridgeAt4242(on)
    on('process.spawn', async function* () { return { value: { code: 0, signal: null } } } as never)
    on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: overviewWith([]) } }))
    await $.session.start({ cwd: '/repo', surface, isInteractive: true } as never)
    await $.command.run({ command: 'annotations', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
    const band = await $.ui.mount({ plugin: 'annotate', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false } as never })
    expect(await band.find({ key: 'chip-row' })).toBeUndefined()
  })
}

test('a pushed change is fetched at once, and an unchanged revision costs one word', async ($, on) => {
  const asked: string[] = []
  let notes: unknown[] = []
  let rev = 1
  bridgeAt4242(on)
  on('process.spawn', async function* () {
    notes = [{ n: 1, text: 'make this blue' }]
    rev = 2
    yield { stream: 'stdout', text: 'up\nrev 2\n' }
    return { value: { code: 0, signal: null } }
  } as never)
  on('http.fetch', (_$, e) => {
    asked.push(e.url)
    if (e.url.includes(`since=${rev}`)) return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ok: true, rev, unchanged: true }) } }
    return { value: { status: 200, ok: true, headers: {}, text: overviewWith([TAB], notes, rev) } }
  })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true } as never)
  await $.command.run({ command: 'annotations', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  const band = await $.ui.mount({ plugin: 'annotate', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false } as never })
  expect((await band.find({ key: 'chip' }))?.props.label).toContain('1 annotation')
  // A look with nothing new asks with the revision it has and gets "unchanged" back.
  await $.command.run({ command: 'annotations', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  expect(asked.at(-1)).toContain('/overview?since=2')
})

test("another chat's server in the same folder is never this chat's", async ($, on) => {
  on('process.run', () => ({ value: { exitCode: 0, stdout: '/home/me\n4242\n', stderr: '' } }) as never)
  on('fs.exists', (_$, e) => ({ value: e.path === SESSIONS || e.path === `${SESSIONS}/9999.json` }))
  on('fs.read', () => ({ value: JSON.stringify(BRIDGE) }))
  on('fs.list', () => ({ value: [{ name: '9999.json', kind: 'file', size: 1, mtimeMs: 1, isLink: false }] }) as never)
  on('clock.every', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'annotations' } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }) as never)
  on('process.spawn', async function* () { return { value: { code: 0, signal: null } } } as never)
  let fetched = false
  on('http.fetch', () => { fetched = true; return { value: { status: 200, ok: true, headers: {}, text: overviewWith([TAB], [{ n: 1, text: 'x' }]) } } })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true } as never)
  const r = await $.command.run({ command: 'annotations', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  expect(fetched).toBe(false)
  expect(JSON.stringify(r)).toContain('not running')
})

test('the annotating tab goes with a prompt even when no notes wait', async ($, on) => {
  const reached: { context?: readonly string[] }[] = []
  bridgeAt4242(on)
  on('process.spawn', async function* () { return { value: { code: 0, signal: null } } } as never)
  on('prompt.submit', (_$, e) => { reached.push({ context: e.context }); return { text: e.text, context: e.context } })
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: overviewWith([TAB]) } }))
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true } as never)
  await $.command.run({ command: 'annotations', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  await $.prompt.submit({ text: 'why is this misaligned?', origin: { kind: 'composer' } } as never)
  expect(reached.at(-1)?.context?.join('\n')).toContain('Annotating tab: http://localhost:3000/pricing (local)')
})
