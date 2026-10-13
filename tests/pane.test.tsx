import { expect, test } from 'claude-code/testing'

const SESSIONS = '/home/me/.cache/claude-annotate/sessions'
const BRIDGE = { endpoint: 'http://127.0.0.1:4000', token: 't0k', cwd: '/repo', startedAt: 1 }
const PAGE = 'http://localhost:3000/'

const PREVIEW = { src: 'data:image/jpeg;base64,AAAA', w: 280, h: 160 }

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: the band shows only unsent notes, each with its picture`, async ($, on) => {
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
    expect(await band.find({ text: /make this blue/ })).toBeUndefined() // sent: it is part of the message now
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
    expect(await ui.find({ text: /Discard all pending annotations/ })).toBeDefined()

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
        notes = notes.filter(note => !going.includes(note))
        return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ok: true, content: `Browser annotations: ${going.map(n => n.text).join(', ')}` }) } }
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

    on('ui.render', () => ({ type: 'Box', props: {}, children: [] }) as never) // the engine's own band: nothing
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
    expect(reached.at(-1)?.context).toEqual(['Browser annotations: make it blue'])

    // Nothing left: the prompt goes alone and asks nothing of the server.
    await $.command.run({ command: 'annotations', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } }).catch(() => {})
    await $.prompt.submit({ text: 'thanks', origin: { kind: 'composer' } } as never)
    expect(reached.at(-1)?.context ?? []).toEqual([])
    expect(sends.length).toBe(1)
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: Send on the chip sends the notes with nothing typed`, async ($, on) => {
    let notes = [{ n: 1, text: 'make it blue', color: 'blue' }]
    const sends: unknown[] = []
    const submitted: { text: string }[] = []

    on('process.run', () => ({ value: { exitCode: 0, stdout: '/home/me\n4242\n', stderr: '' } }) as never)
    on('fs.exists', (_$, e) => ({ value: e.path === SESSIONS || e.path === `${SESSIONS}/4242.json` }))
    on('fs.read', () => ({ value: JSON.stringify(BRIDGE) }))
    on('fs.list', () => ({ value: [] }))
    on('clock.every', () => ({ value: undefined }))
    on('command.register', () => ({ value: { command: 'annotations' } }))
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    on('ui.status', () => ({ value: undefined }))
    on('prompt.submit', (_$, e) => {
      submitted.push({ text: e.text })
      return { text: e.text }
    })
    on('http.fetch', (_$, e) => {
      if (e.url.endsWith('/send')) {
        sends.push(JSON.parse(e.init?.body ?? '{}'))
        notes = []
        return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ ok: true, content: 'Browser annotations: make it blue' }) } }
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
          delivery: { queued: 0, listening: true },
        }),
      } }
    })

    on('ui.render', () => ({ type: 'Box', props: {}, children: [] }) as never)
    await $.session.start({ cwd: '/repo', surface, isInteractive: true } as never)
    await $.command.run({ command: 'annotations', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
    const band = await $.ui.mount({ plugin: 'annotate', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false } as never })

    await band.press({ key: 'send' })
    expect(sends).toEqual([{ from: 'prompt' }])
    expect(submitted.at(-1)?.text).toBe('Browser annotations: make it blue')
  })
}
