import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, Register } from 'claude-code'

import type { Note, Overview, Page, Preview } from '../types'

const POLL_MS = 2000

const overview = atom({ plugin: 'annotate', key: 'overview' } as const, { kind: 'no-server' } as Overview)
const lastError = atom({ plugin: 'annotate', key: 'error' } as const, null as string | null)
const confirmClear = atom({ plugin: 'annotate', key: 'confirmClear' } as const, false)
/** Whether the "N annotations" chip above the prompt is open to its list. */
const expanded = atom({ plugin: 'annotate', key: 'expanded' } as const, false)

/** The annotate server this session started: its HTTP bridge and token. */
type Bridge = { endpoint: string; token: string }

const STATUS_MARK: Record<string, string> = { pending: '○', working: '◐', done: '●', skipped: '⊘' }

/** The overlay's ink colors. */
const INK: Record<string, Color> = { blue: '#3B82F6', pink: '#FF4D8D', sun: '#FFD23F', cyan: '#35D7FF', lime: '#9BFF4D' }

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

  // Unsent notes ride along with what the user types next: the same text Send hands Claude, read
  // beside the prompt. Nothing is woken, so this works whatever the chat hook is doing.
  on('prompt.submit', async ($, e, next) => {
    if (!isUsersOwn(e.origin.kind) || e.text.trim().startsWith('/')) return next(e)
    const now = await read($, overview)
    if (now.kind !== 'linked' || now.totals.unsent === 0) return next(e)

    let content: string | undefined
    try {
      content = (await call($, 'POST', '/send', { from: 'prompt' })).content
    } catch {
      // Nothing left to send, or a Send already running: the prompt goes alone.
    }
    if (!content) return next(e)

    void refresh($, cwd)
    return next({ ...e, context: [...(e.context ?? []), content] })
  })

  // Above the prompt, as Codex does it: one chip, "N annotations", with small pictures of the
  // pages and a ✕ that discards them all. Pressed, it lists each note: its picture, what it is on,
  // the words and a trash. Only notes not sent yet: once they go, they are part of the message.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const now = await read($, overview)
    if (e.props.hasSurvey || now.kind !== 'linked') return next(e)

    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const isOpen = await read($, expanded)
    const confirming = await read($, confirmClear)
    const error = await read($, lastError)
    const pending = now.pages.flatMap(page => page.notes.filter(note => !note.batch && note.text?.trim()).map(note => ({ url: page.url, note })))
    const marks = now.pages.reduce((n, page) => n + page.shapes, 0)
    if (pending.length + marks === 0 && !error) return next(e)

    // The desktop draws pictures as Svg and borders as thin lines; the terminal's Image takes no
    // JPEG and a border costs it two rows, so there the chip is a line of text.
    const roomy = e.surface !== 'terminal' && 'Svg' in els
    const picture = (key: string, preview: Preview | null | undefined, n: number, width: number, height: number) =>
      roomy && preview && preview.src.length < MAX_PREVIEW_CHARS ? (
        <Box key={key}>
          <els.Svg source={previewSvg(preview, width, height)} alt={`The page around note ${n}`} width={width} height={height} />
        </Box>
      ) : null

    if (confirming) {
      return (
        <Box key="annotations" flexDirection="row" gap={2} alignItems="center">
          <Box flexGrow={1} flexShrink={1}>
            <Text wrap="truncate">Discard all pending annotations?</Text>
          </Box>
          <Button key="discard-no" label="Cancel" plain dimColor onPress={() => update($, confirmClear, () => false)} />
          <Button key="discard-yes" label="Discard" plain color="error" onPress={() => clearAll($)} />
        </Box>
      )
    }

    const label = pending.length ? plural(pending.length, 'annotation') : plural(marks, 'mark')
    const strip = pending.filter(({ note }) => note.preview).slice(0, CHIP_PICTURES)
    const chip = (
      <Box key="chip-row" flexDirection="row" gap={1} alignItems="center">
        <Box
          key="chip-box"
          flexDirection="row"
          gap={1}
          alignItems="center"
          paddingX={roomy ? 1 : 0}
          borderStyle={roomy ? 'round' : undefined}
          borderDimColor
          hover={roomy ? { borderDimColor: false } : undefined}
        >
          {roomy && <els.Svg source={CHIP_ICON} alt="" width={14} height={14} />}
          <Button key="chip" label={`${roomy ? '' : '✎ '}${label} ${isOpen ? '▴' : '▾'}`} plain onPress={() => update($, expanded, v => !v)} />
          {!isOpen && strip.map(({ url, note }) => picture(`chip-pic:${noteKey(url, note.n)}`, note.preview, note.n, 30, 20))}
        </Box>
        {pending.length > 0 && (
          <Button key="send" label="Send" variant="primary" plain={roomy ? undefined : true} onPress={() => sendAlone($)} />
        )}
        <Button key="discard" label="✕" role="dismiss" plain dimColor hover={{ dimColor: false, color: 'error' }} onPress={() => update($, confirmClear, () => true)} />
      </Box>
    )

    // One card per note, as Codex lists them.
    const card = ({ url, note }: { url: string; note: Note }) => {
      const key = noteKey(url, note.n)
      const what = note.video ? `▶ ${Math.round(note.video.duration ?? 0)} s recording` : note.ctx?.selector ? clip(note.ctx.selector, 32) : null
      return (
        <Box key={`card:${key}`} flexDirection="row" gap={1} paddingX={1} borderStyle={roomy ? 'round' : undefined} borderDimColor>
          {picture(`thumb:${key}`, note.preview, note.n, THUMB_W, THUMB_H)}
          <Box flexDirection="column" flexGrow={1} flexShrink={1}>
            <Box flexDirection="row" gap={1}>
              <Text color={INK[note.color ?? ''] ?? 'text'} bold>
                {note.n}
              </Text>
              {what && (
                <Box flexShrink={1}>
                  <Text dimColor wrap="truncate">
                    {what}
                  </Text>
                </Box>
              )}
              <Box flexGrow={1} />
              <Button
                key={`delete:${key}`}
                label="🗑"
                plain
                dimColor
                hover={{ dimColor: false, color: 'error' }}
                onPress={() => act($, cwd, 'POST', '/note/delete', { url, n: note.n })}
              />
            </Box>
            <Text wrap="wrap">{note.text}</Text>
          </Box>
        </Box>
      )
    }

    // Closed, what the notes say, two lines at most.
    const gist = !isOpen && pending.length > 0 && (
      <Box key="gist" height={2} paddingLeft={roomy ? 1 : 2} overflow="hidden">
        <Text dimColor wrap="wrap">
          {pending.map(({ note }) => `${note.n} ${note.text.replace(/\s+/g, ' ').trim()}`).join('  ·  ')}
        </Text>
      </Box>
    )

    return (
      <Box key="annotations" flexDirection="column" gap={roomy ? 1 : 0}>
        {chip}
        {gist}
        {error && <Text key="error" color="error" wrap="truncate">{error}</Text>}
        {isOpen && pending.map(card)}
      </Box>
    )
  })

  // No sidebar: the band above the prompt shows the notes; this lists them as text.
  on('command.run', { command: 'annotations' }, async $ => {
    await refresh($, cwd)
    const now = await read($, overview)
    if (now.kind !== 'linked') return { text: 'Annotations: the annotate plugin is not running in this session.' }
    const counts = now.totals.notes > 0 ? ` · ${statusLine(now.totals)}` : ''
    return { text: [`Annotations activated${counts}`, ...noteLines(now.pages)].join('\n') }
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
      next = { kind: 'linked', mode: o.mode, totals: o.totals, pages: o.pages, sent: o.sent ?? [], delivery: o.delivery ?? { queued: 0, listening: true } }
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

const noteKey = (url: string, n: number) => `${url}#${n}`

// A prompt the user typed, here or through Remote Control; not a notification, a peer or a plugin.
const isUsersOwn = (kind: string) => kind === 'composer' || kind === 'bridge'

const MAX_PREVIEW_CHARS = 120_000 // an Svg source holds 131072 characters
const THUMB_W = 96
const THUMB_H = 60
const CHIP_PICTURES = 3 // the closed chip shows this many pages
// A speech bubble with lines, drawn in the desktop's text color.
const CHIP_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 9h8"/><path d="M8 13h5"/></svg>`

// The picture scaled to cover w×h, cut to a rounded card.
function previewSvg(p: Preview, w: number, h: number) {
  const k = Math.max(w / p.w, h / p.h)
  const iw = p.w * k, ih = p.h * k
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><clipPath id="c"><rect width="${w}" height="${h}" rx="4"/></clipPath></defs><image href="${p.src}" x="${(w - iw) / 2}" y="${(h - ih) / 2}" width="${iw}" height="${ih}" preserveAspectRatio="xMidYMid slice" clip-path="url(#c)"/></svg>`
}

// Send with nothing typed: the prompt box will not send empty, so the notes go as a message of
// their own, the same batch they would add to a typed prompt.
let sendingAlone = false
async function sendAlone($: EngineInterface) {
  if (sendingAlone) return
  sendingAlone = true
  try {
    const { content } = await call($, 'POST', '/send', { from: 'prompt' })
    await update($, expanded, () => false)
    if (content) await $.prompt.submit({ text: content })
  } catch (err) {
    await update($, lastError, () => String((err as Error).message ?? err))
  } finally {
    sendingAlone = false
    await refresh($, cwd)
  }
}

async function clearAll($: EngineInterface) {
  await update($, confirmClear, () => false)
  await act($, cwd, 'POST', '/clear')
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

function clip(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
