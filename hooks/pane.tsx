import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, Register } from 'claude-code'

import type { Note, Overview, Page } from '../types'

const PANE = 'annotations'
const POLL_MS = 2000

const overview = atom({ plugin: 'annotate', key: 'overview' } as const, { kind: 'no-server' } as Overview)
const lastError = atom({ plugin: 'annotate', key: 'error' } as const, null as string | null)
const confirmClear = atom({ plugin: 'annotate', key: 'confirmClear' } as const, false)

/** The annotate server this session started: its HTTP bridge and token. */
type Bridge = { endpoint: string; token: string }

const STATUS_MARK: Record<string, string> = { pending: '○', working: '◐', done: '●', skipped: '⊘' }

/** Where a note stands, the unsent ones included. */
type NoteState = 'unsent' | 'pending' | 'working' | 'done' | 'skipped'
const STATUS: Record<NoteState, { label: string; color: Color }> = {
  unsent: { label: 'Unsent', color: 'subtle' },
  pending: { label: 'Queued', color: 'inactive' },
  working: { label: 'Working', color: 'claude' },
  done: { label: 'Done', color: 'success' },
  skipped: { label: 'Skipped', color: 'warning' },
}
const noteStatus = (note: Note): NoteState => (!note.batch ? 'unsent' : note.status ?? 'pending')

/** The overlay's ink colors. */
const INK: Record<string, Color> = { pink: '#FF4D8D', sun: '#FFD23F', cyan: '#35D7FF', lime: '#9BFF4D' }

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
    if (opened.isPlaced) return {}

    // No pane on this surface: say why, and list the notes here instead.
    const now = await read($, overview)
    if (now.kind !== 'linked') return { text: 'Annotations: the annotate plugin is not running in this session.' }
    return { text: [`Annotations: ${statusLine(now.totals)}. No pane here: ${opened.reason}`, ...noteLines(now.pages)].join('\n') }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const now = await read($, overview)
    const error = await read($, lastError)
    const confirming = await read($, confirmClear)
    const width = e.props.bodyColumns

    if (now.kind === 'no-server') {
      return (
        <Box flexDirection="column" gap={1}>
          <Text>
            <Text color="error">●</Text> Not connected
          </Text>
          <Text dimColor wrap="wrap">
            The annotate plugin isn't running in this session. Start a new session after installing or updating it.
          </Text>
        </Box>
      )
    }

    const { totals } = now
    const hasAnything = totals.notes + totals.shapes > 0

    const header = (
      <Box flexDirection="column">
        <Text>
          <Text color="success">●</Text> Connected <Text dimColor>· {now.mode} delivery</Text>
        </Text>
        {hasAnything && <Text dimColor wrap="wrap">{summary(totals)}</Text>}
      </Box>
    )

    const actions = !hasAnything ? null : confirming ? (
      <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
        <Text color="warning">Clear every note and mark on every page?</Text>
        <Button key="clear-yes" label="Clear all" variant="primary" onPress={() => clearAll($)} />
        <Button key="clear-no" label="Cancel" onPress={() => update($, confirmClear, () => false)} />
      </Box>
    ) : (
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        {totals.unsent > 0 && (
          <Button key="send" label={`Send ${totals.unsent} to Claude`} variant="primary" onPress={() => act($, cwd, 'POST', '/send')} />
        )}
        <Button key="clear" label="Clear all" onPress={() => update($, confirmClear, () => true)} />
      </Box>
    )

    const noteRow = (page: Page, note: Note) => {
      const st = STATUS[noteStatus(note)]
      return (
        <Box key={`${page.url}#${note.n}`} flexDirection="column" paddingLeft={1}>
          <Box flexDirection="row" gap={1}>
            <Text color={INK[note.color ?? ''] ?? 'text'}>●</Text>
            <Text bold>{note.n}</Text>
            <Box flexGrow={1} flexShrink={1}>
              <Text wrap="wrap">{note.text || '(no text)'}</Text>
            </Box>
            <Text color={st.color}>{st.label}</Text>
            <Button
              key={`delete:${page.url}#${note.n}`}
              label="×"
              plain
              dimColor
              hover={{ dimColor: false, color: 'error' }}
              onPress={() => act($, cwd, 'POST', '/note/delete', { url: page.url, n: note.n })}
            />
          </Box>
          {note.result && (
            <Box paddingLeft={4}>
              <Text dimColor wrap="wrap">→ {note.result}</Text>
            </Box>
          )}
        </Box>
      )
    }

    const pageBlock = (page: Page) => (
      <Box key={page.url} flexDirection="column" marginTop={1}>
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Link href={page.url} label={clip(shortUrl(page.url), Math.max(24, width - 24))} />
          <Text dimColor>
            · {plural(page.notes.length, 'note')}
            {page.shapes > 0 ? ` · ${plural(page.shapes, 'mark')}` : ''}
          </Text>
        </Box>
        {[...page.notes].sort((a, b) => a.n - b.n).map(note => noteRow(page, note))}
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1}>
        {header}
        {actions}
        {error && <Text color="error" wrap="wrap">{error}</Text>}
        {!hasAnything && (
          <Box flexDirection="column" gap={1}>
            <Text bold>No annotations yet</Text>
            <Text dimColor wrap="wrap">
              In Chrome, turn on annotation mode from the Claude Annotate toolbar button (⌥⇧A), or ask Claude to /annotate a URL. Notes you pin show up here.
            </Text>
          </Box>
        )}
        {now.pages.map(pageBlock)}
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

async function clearAll($: EngineInterface) {
  await update($, confirmClear, () => false)
  await act($, cwd, 'POST', '/clear')
}

function summary(t: { notes: number; pages: number; unsent: number; open: number; shapes: number }) {
  const parts = [plural(t.notes, 'note'), plural(t.pages, 'page')]
  if (t.shapes) parts.push(plural(t.shapes, 'mark'))
  if (t.unsent) parts.push(`${t.unsent} unsent`)
  if (t.open) parts.push(`${t.open} in progress`)
  return parts.join(' · ')
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

function shortUrl(url: string) {
  try {
    const u = new URL(url)
    return `${u.host}${u.pathname === '/' ? '' : u.pathname}${u.search}`
  } catch {
    return url
  }
}

function clip(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
