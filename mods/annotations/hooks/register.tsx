import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Note, Overview, Page } from '../types'

const PANE = 'annotations'
const POLL_MS = 2000

const overview = atom({ plugin: 'annotations', key: 'overview' } as const, { kind: 'no-server' } as Overview)
const lastError = atom({ plugin: 'annotations', key: 'error' } as const, null as string | null)

/** The annotate server this session started: its HTTP bridge and token. */
type Bridge = { endpoint: string; token: string }

const STATUS_MARK: Record<string, string> = { pending: '○', working: '◐', done: '●', skipped: '⊘' }

// Module variables: a hot reload starts them over, and the next poll finds the server again.
let bridge: Bridge | null = null
let lastSeen = ''
let cwd = ''

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    await $.command.register({ name: 'annotations', description: 'Show and edit the browser annotations of this session' })
    void refresh($, cwd)
    $.clock.every(POLL_MS, () => refresh($, cwd))

    return next(e)
  })

  on('command.run', { command: 'annotations' }, async $ => {
    await refresh($, cwd)
    const opened = await $.ui.open({ id: PANE, title: 'Annotations' })
    const now = await read($, overview)
    if (now.kind !== 'linked') return { text: 'Annotations: no annotate server in this session yet.' }
    // The notes go in the text too: a headless host (the desktop app's Code tab) reports the pane
    // as placed but draws nothing, and an older desktop says it placed none.
    const head = `Annotations: ${statusLine(now.totals)}.${opened.isPlaced ? '' : ` No pane here: ${opened.reason}`}`
    return { text: [head, ...noteLines(now.pages)].join('\n') }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const now = await read($, overview)
    const error = await read($, lastError)

    if (now.kind === 'no-server') {
      return (
        <Box flexDirection="column">
          <Text dimColor>No annotate server in this session.</Text>
          <Text dimColor>Ask Claude to open a page with annotate, then come back.</Text>
        </Box>
      )
    }

    const { totals } = now
    const notesOf = (page: Page) =>
      page.notes.map((note: Note) => (
        <Box key={`${page.url}#${note.n}`} flexDirection="row">
          <Box flexGrow={1} flexDirection="column">
            <Text>
              {STATUS_MARK[note.status ?? ''] ?? '·'} {note.n}. {clip(note.text || '(no text)', 160)}
            </Text>
            {note.result && <Text dimColor>  → {clip(note.result, 160)}</Text>}
          </Box>
          <Button
            key={`delete:${page.url}#${note.n}`}
            label="Delete"
            plain
            onPress={() => act($, cwd, 'POST', '/note/delete', { url: page.url, n: note.n })}
          />
        </Box>
      ))

    return (
      <Box flexDirection="column">
        <Text dimColor>
          {statusLine(totals)} · delivery: {now.mode}
        </Text>
        <Box flexDirection="row">
          {totals.unsent > 0 && (
            <Button key="send" label={`Send ${totals.unsent}`} variant="primary" onPress={() => act($, cwd, 'POST', '/send')} />
          )}
          {totals.notes + totals.shapes > 0 && (
            <Button key="clear" label="Clear all" onPress={() => act($, cwd, 'POST', '/clear')} />
          )}
          <Button key="refresh" label="Refresh" onPress={() => refresh($, cwd)} />
        </Box>
        {error && <Text color="red">{error}</Text>}
        {now.pages.length === 0 && <Text dimColor>No annotations yet. Draw on the page, then come back.</Text>}
        {now.pages.map(page => (
          <Box key={page.url} flexDirection="column" marginTop={1}>
            <Text bold>{clip(page.url, 80)}</Text>
            {page.notes.length === 0 && <Text dimColor>{page.shapes} marks, no notes</Text>}
            {notesOf(page)}
          </Box>
        ))}
      </Box>
    )
  })
}

// The annotate server writes ~/.cache/claude-annotate/sessions/<claude pid>.json.
// The engine runs `sh` as a child of that same claude process, so sh's $PPID is the key.
// Older servers wrote no cwd; a session with no pid match falls back to the newest file for this cwd.
async function findBridge($: EngineInterface, cwd: string): Promise<Bridge | null> {
  const { stdout } = await $.process.run(['sh', '-c', 'echo "$HOME"; echo "$PPID"'])
  const [home, pid] = stdout.trim().split('\n')
  const dir = `${home}/.cache/claude-annotate/sessions`
  if (!(await $.fs.exists(dir))) return null

  const own = `${dir}/${pid}.json`
  if (await $.fs.exists(own)) return JSON.parse(await $.fs.read(own))

  let newest: (Bridge & { startedAt: number }) | null = null
  for (const entry of await $.fs.list(dir)) {
    if (!entry.name.endsWith('.json')) continue
    const one = JSON.parse(await $.fs.read(`${dir}/${entry.name}`))
    if (one.cwd === cwd && (!newest || one.startedAt > newest.startedAt)) newest = one
  }
  return newest
}

async function call($: EngineInterface, method: string, path: string, body?: unknown) {
  if (!bridge) throw new Error('no annotate server in this session')
  const res = await $.http.fetch(`${bridge.endpoint}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Annot-Token': bridge.token },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const parsed = JSON.parse(res.text || '{}')
  if (!res.ok) throw new Error(parsed.error ?? `HTTP ${res.status}`)
  return parsed
}

async function refresh($: EngineInterface, cwd: string) {
  let next: Overview
  try {
    bridge ??= await findBridge($, cwd)
    if (!bridge) next = { kind: 'no-server' }
    else {
      const o = await call($, 'GET', '/overview')
      next = { kind: 'linked', mode: o.mode, totals: o.totals, pages: o.pages }
    }
  } catch {
    // The server restarted or went away: look it up again next tick.
    bridge = null
    next = { kind: 'no-server' }
  }

  const seen = JSON.stringify(next)
  if (seen === lastSeen) return
  lastSeen = seen
  await update($, overview, () => next)
  $.ui.status(next.kind === 'linked' && next.totals.notes > 0 ? statusLine(next.totals) : undefined)
}

async function act($: EngineInterface, cwd: string, method: string, path: string, body?: unknown) {
  try {
    await call($, method, path, body)
    await update($, lastError, () => null)
  } catch (err) {
    await update($, lastError, () => String((err as Error).message ?? err))
  }
  await refresh($, cwd)
}

function statusLine(t: { notes: number; unsent: number; open: number }) {
  return `✎ ${t.notes} note${t.notes === 1 ? '' : 's'} · ${t.unsent} unsent · ${t.open} open`
}

function noteLines(pages: Page[]) {
  return pages.flatMap(page => [
    page.url,
    ...page.notes.map(note => `  ${STATUS_MARK[note.status ?? ''] ?? '·'} ${note.n}. ${clip(note.text || '(no text)', 160)}`),
  ])
}

function clip(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
