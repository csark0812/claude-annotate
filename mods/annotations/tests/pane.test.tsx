import { expect, test } from 'claude-code/testing'

const SESSIONS = '/home/me/.cache/claude-annotate/sessions'
const BRIDGE = { endpoint: 'http://127.0.0.1:4000', token: 't0k', cwd: '/repo', startedAt: 1 }
const PAGE = 'http://localhost:3000/'

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: pane lists notes and Delete removes one through the bridge`, async ($, on) => {
    let notes = [
      { n: 1, text: 'make this blue', status: 'done', result: 'changed to blue', batch: 1 },
      { n: 2, text: 'bigger title' },
    ]
    const posted: { url: string; body?: string; token?: string }[] = []

    on('process.run', () => ({ value: { exitCode: 0, stdout: '/home/me\n4242\n', stderr: '' } }) as never)
    on('fs.exists', (_$, e) => ({ value: e.path === SESSIONS || e.path === `${SESSIONS}/4242.json` }))
    on('fs.read', () => ({ value: JSON.stringify(BRIDGE) }))
    on('fs.list', () => ({ value: [] }))
    on('clock.every', () => ({ value: undefined }))
    on('command.register', () => ({ value: { command: 'annotations' } }))
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    on('ui.status', () => ({ value: undefined }))
    on('http.fetch', (_$, e) => {
      posted.push({ url: e.url, body: e.init?.body, token: e.init?.headers?.['X-Annot-Token'] })
      if (e.url.endsWith('/note/delete')) {
        const { n } = JSON.parse(e.init?.body ?? '{}')
        notes = notes.filter(note => note.n !== n)
        return { value: { status: 200, ok: true, headers: {}, text: '{"ok":true}' } }
      }
      const unsent = notes.filter(note => !note.batch).length
      return { value: {
        status: 200,
        ok: true,
        headers: {},
        text: JSON.stringify({
          ok: true,
          mode: 'chat',
          totals: { notes: notes.length, shapes: 0, pages: 1, unsent, open: 0, batches: 1 },
          pages: [{ url: PAGE, notes, shapes: 0 }],
          batches: [],
        }),
      } }
    })

    await $.session.start({ cwd: '/repo', surface, isInteractive: true } as never)

    const ui = await $.ui.mount({ plugin: 'annotations', surface, component: 'Pane', props: {} as never, requestId: 'annotations' })
    expect((await ui.find({ text: /make this blue/ }))?.text).toContain('1. make this blue')
    expect((await ui.find({ text: /changed to blue/ }))).toBeDefined()
    expect((await ui.find({ key: 'send' }))?.props.label).toBe('Send 1')

    await ui.press({ key: `delete:${PAGE}#2` })

    const del = posted.find(p => p.url === `${BRIDGE.endpoint}/note/delete`)
    expect(del?.token).toBe('t0k')
    expect(JSON.parse(del?.body ?? '{}')).toEqual({ url: PAGE, n: 2 })
    expect(await ui.find({ text: /bigger title/ })).toBeUndefined()
    expect(await ui.find({ key: 'send' })).toBeUndefined()
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: /annotations lists the notes as text when no pane is placed`, async ($, on) => {
    const notes = [{ n: 1, text: 'make this blue' }]

    on('process.run', () => ({ value: { exitCode: 0, stdout: '/home/me\n4242\n', stderr: '' } }) as never)
    on('fs.exists', (_$, e) => ({ value: e.path === SESSIONS || e.path === `${SESSIONS}/4242.json` }))
    on('fs.read', () => ({ value: JSON.stringify(BRIDGE) }))
    on('fs.list', () => ({ value: [] }))
    on('clock.every', () => ({ value: undefined }))
    on('command.register', () => ({ value: { command: 'annotations' } }))
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    on('ui.status', () => ({ value: undefined }))
    on('ui.open', () => ({ value: { isPlaced: false, reason: 'the attached desktop places no panes' } }))
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

    expect(out.text).toContain('No pane here: the attached desktop places no panes')
    expect(out.text).toContain(PAGE)
    expect(out.text).toContain('1. make this blue')
  })
}
