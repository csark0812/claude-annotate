import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, Register } from 'claude-code'

import type { Note, Overview, Page, Preview, Ride, Tab } from '../types'

// The server pushes every change (scripts/watch.mjs); this poll is only the net under it.
const POLL_MS = 10000

const overview = atom({ plugin: 'annotate', key: 'overview' } as const, { kind: 'no-server' } as Overview)
const lastError = atom({ plugin: 'annotate', key: 'error' } as const, null as string | null)
const confirmClear = atom({ plugin: 'annotate', key: 'confirmClear' } as const, false)
/** Whether the "N annotations" chip above the prompt is open to its list. */
const expanded = atom({ plugin: 'annotate', key: 'expanded' } as const, false)
/** The prompts notes rode along with, newest last: each one's row in the transcript names them. */
const rides = atom({ plugin: 'annotate', key: 'rides' } as const, [] as Ride[])

/** The annotate server this session started: its HTTP bridge and token. */
type Bridge = { endpoint: string; token: string }

const STATUS_MARK: Record<string, string> = { pending: '○', working: '◐', done: '●', skipped: '⊘' }

/** The overlay's ink colors. */
const INK: Record<string, Color> = { blue: '#3B82F6', pink: '#FF4D8D', sun: '#FFD23F', cyan: '#35D7FF', lime: '#9BFF4D' }

// Module variables: a hot reload starts them over, and the next poll finds the server again.
let bridge: Bridge | null = null
let lastSeen = ''
let lastRev: number | null = null
let wasLinked = false // this chat's server answered once: gone now means it stopped
let working = false // Claude is mid-turn (from the prompt area's props)
let unheardSince: number | null = null // when notes started waiting with no chat hook to deliver them
let cwd = ''

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    await $.command.register({ name: 'annotations', description: 'Show and edit the browser annotations of this session' })
    void refresh($, cwd)
    void followServer($)
    $.clock.every(POLL_MS, () => refresh($, cwd))

    return next(e)
  })

  // Notes go to Claude by themselves a moment after they are saved. One saved just before the user
  // presses Enter rides along with that prompt instead, text and pictures alike. The server is always asked: the bar's copy can be a
  // moment behind a note just saved. It answers at once (it never waits on the tab), well inside the
  // hook's 10 s budget; past that budget the prompt would go without notes the server already took.
  on('prompt.submit', async ($, e, next) => {
    if (!isUsersOwn(e.origin.kind) || e.text.trim().startsWith('/')) return next(e)
    bridge ??= await findBridge($).catch(() => null)
    if (!bridge) return next(e)
    const now = await read($, overview)
    // Which tab the user is looking at, so "this" and "the page" mean something to Claude.
    const tabs = now.kind === 'linked' ? now.tabs.filter(isShown).map(t => `Annotating tab: ${t.url} (${t.local ? 'local' : 'not a local page'}${t.visible ? '' : ', in the background'})`) : []
    const content = await takeUnsent($).catch(() => undefined) // nothing waiting: the prompt goes alone
    if (content) {
      await update($, rides, list => [...list, { text: e.text, label: sentLabel(content) }].slice(-MAX_RIDES))
      void refresh($, cwd)
    }
    const extra = [...(tabs.length ? [tabs.join('\n')] : []), ...(content ? [content] : [])]
    return extra.length ? next({ ...e, context: [...(e.context ?? []), ...extra] }) : next(e)
  })

  // The sent message says what went with it: a line under the prompt the notes rode with, and a
  // batch the plugin posted drawn as that line instead of the text Claude reads (ctrl+o shows it all).
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const { origin, text, isExpanded } = e.props
    if (origin.kind === 'plugin' && origin.name === 'annotate' && text.startsWith('Browser annotations')) {
      return isExpanded ? next(e) : next({ ...e, props: { ...e.props, text: sentLabel(text) } })
    }
    if (!isUsersOwn(origin.kind)) return next(e)
    const ride = (await read($, rides)).findLast(r => r.text === text)
    return ride ? next({ ...e, props: { ...e.props, text: text ? `${text}\n${ride.label}` : ride.label } }) : next(e)
  })

  // Above the prompt, as Codex does it. No Send: notes go to Claude as they are saved. While one is
  // on its way, the "N annotations" chip (pressed, it lists each note: its picture, what it is on,
  // the words, a trash) and Discard. Under it, dim lines: which tab is annotating, and the notes
  // Claude has and has not finished.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    working = !!e.props.isWorking
    const now = await read($, overview)
    if (e.props.hasSurvey) return next(e)
    // Claude Code does not start a chat's MCP server again by itself: say so, and how.
    if (now.kind === 'no-server' && now.lost) {
      const { Box, Text } = $.ui.resolve(e)
      return (
        <Box key="annotations" paddingLeft={1}>
          <Text color="warning" wrap="truncate">Annotate stopped in this chat. Run /mcp and reconnect annotate.</Text>
        </Box>
      )
    }
    if (now.kind !== 'linked') return next(e)

    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const isOpen = await read($, expanded)
    const confirming = await read($, confirmClear)
    const error = await read($, lastError)
    const pending = now.pages.flatMap(page => page.notes.filter(note => !note.batch && note.text?.trim()).map(note => ({ url: page.url, note })))
    const writing = now.pages.flatMap(page => page.notes.filter(note => !note.batch && !note.text?.trim()))
    const marks = now.pages.reduce((n, page) => n + page.shapes, 0)
    const tabs = now.tabs.filter(isShown)
    const hasNotes = pending.length + marks > 0
    // What Claude has of them: the notes that went out and are not finished, newest last.
    const open = now.sent.filter(note => note.status === 'pending' || note.status === 'working')
    if (!hasNotes && !error && !tabs.length && !open.length) return next(e)

    // The desktop draws pictures as Svg and borders as thin lines; the terminal's Image takes no
    // JPEG and a border costs it two rows, so there the chip is a line of text.
    const roomy = e.surface !== 'terminal' && 'Svg' in els
    const picture = (key: string, preview: Preview | null | undefined, n: number, width: number, height: number) =>
      roomy && preview && preview.src.length < MAX_PREVIEW_CHARS ? (
        <Box key={key}>
          <els.Svg source={previewSvg(preview, width, height)} alt={`The page around note ${n}`} width={width} height={height} />
        </Box>
      ) : null
    const icon = roomy ? <els.Svg source={CHIP_ICON} alt="" width={14} height={14} /> : null
    const line = (key: string, text: string, color?: Color) => (
      <Box key={key} paddingLeft={roomy ? 1 : 2}>
        <Text dimColor={!color} color={color} wrap="truncate">{text}</Text>
      </Box>
    )

    if (confirming) {
      return (
        <Box key="annotations" flexDirection="row" gap={2} alignItems="center">
          <Box flexGrow={1} flexShrink={1}>
            <Text wrap="truncate">{`Discard ${hasNotes ? (pending.length ? plural(pending.length, 'annotation') : plural(marks, 'mark')) : 'all pending annotations'}?`}</Text>
          </Box>
          <Button key="discard-no" label="Keep" dimColor onPress={() => update($, confirmClear, () => false)} />
          <Button key="discard-yes" label="Discard" variant="primary" onPress={() => clearAll($)} />
        </Box>
      )
    }

    const where = tabs.length ? tabsLabel(tabs) : null

    // Annotating, nothing marked yet: the bar says so; Stop turns annotating off in the tab.
    if (!hasNotes) {
      return (
        <Box key="annotations" flexDirection="column" gap={0}>
          <Box key="chip-row" flexDirection="row" gap={1} alignItems="center">
            {icon}
            <Box key="where-box" flexGrow={1} flexShrink={1}>
              <Text key="where" wrap="truncate">{`${roomy ? '' : '✎ '}${where ?? 'Annotations'}`}</Text>
            </Box>
            {where && <Button key="stop" label="Stop" dimColor onPress={() => act($, cwd, 'POST', '/stop')} />}
          </Box>
          {line('hint', writing.length ? 'Writing a note…' : 'Click an element or drag an area in the page; each note goes to Claude as you save it')}
          {open.slice(-MAX_OPEN_LINES).map(note => line(`open:${noteKey(note.url, note.n)}`, `${STATUS_MARK[note.status]} ${note.n} ${clip(note.text.replace(/\s+/g, ' ').trim(), 80)}`))}
          {error && line('error', error, 'error')}
        </Box>
      )
    }

    const label = pending.length ? plural(pending.length, 'annotation') : plural(marks, 'mark')
    const strip = pending.filter(({ note }) => note.preview).slice(0, CHIP_PICTURES)
    const header = (
      <Box key="chip-row" flexDirection="row" gap={1} alignItems="center">
        <Box
          key="chip-box"
          flexDirection="row"
          gap={1}
          alignItems="center"
          flexShrink={0}
          paddingX={roomy ? 1 : 0}
          borderStyle={roomy ? 'round' : undefined}
          borderDimColor
          hover={roomy ? { borderDimColor: false } : undefined}
        >
          {icon}
          <Button key="chip" label={`${roomy ? '' : '✎ '}${label} ${isOpen ? '▴' : '▾'}`} plain onPress={() => update($, expanded, v => !v)} />
          {!isOpen && strip.map(({ url, note }) => picture(`chip-pic:${noteKey(url, note.n)}`, note.preview, note.n, 30, 20))}
        </Box>
        <Box key="spacer" flexGrow={1} />
        <Text key="going" dimColor>Sending to Claude…</Text>
        <Button key="discard" label="Discard" dimColor onPress={() => update($, confirmClear, () => true)} />
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
    const gist = !isOpen && pending.length + writing.length > 0 && (
      <Box key="gist" height={2} paddingLeft={roomy ? 1 : 2} overflow="hidden">
        <Text wrap="wrap">
          {[...pending.map(({ note }) => `${note.n} ${note.text.replace(/\s+/g, ' ').trim()}`), ...writing.map(note => `${note.n} writing…`)].join('  ·  ')}
        </Text>
      </Box>
    )

    return (
      <Box key="annotations" flexDirection="column" gap={roomy ? 1 : 0}>
        <Box key="head" flexDirection="column" gap={0}>
          {header}
          {where && line('hint', where)}
        </Box>
        {gist}
        {open.slice(-MAX_OPEN_LINES).map(note => line(`open:${noteKey(note.url, note.n)}`, `${STATUS_MARK[note.status]} ${note.n} ${clip(note.text.replace(/\s+/g, ' ').trim(), 80)}`))}
        {error && line('error', error, 'error')}
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
// The engine runs `sh` as a child of that same claude process, so sh's $PPID is the key. No file for
// this pid: no annotate server in this chat. Never another chat's, even one in the same folder.
async function findBridge($: EngineInterface): Promise<Bridge | null> {
  const { stdout } = await $.process.run(['sh', '-c', 'echo "$HOME"; echo "$PPID"'])
  const [home, pid] = stdout.trim().split('\n')
  const own = `${home}/.cache/claude-annotate/sessions/${pid}.json`
  return (await $.fs.exists(own)) ? JSON.parse(await $.fs.read(own)) : null
}

// The server's changes, pushed: scripts/watch.mjs holds its event stream open for the session's life
// and prints "up", "rev N" or "down"; each one is a reason to look again. "up" may be a restarted
// server with a new token, so the bridge is looked up again first.
async function followServer($: EngineInterface) {
  try {
    let buf = ''
    for await (const { stream, text } of $.process.spawn({ argv: ['node', `${$.plugin.root}/scripts/watch.mjs`] })) {
      if (stream !== 'stdout') continue
      buf += text
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      if (!lines.length) continue
      if (lines.some(line => line === 'up' || line === 'down')) { bridge = null; lastRev = null }
      void refresh($, cwd)
    }
  } catch {
    // No node, or the module unloaded: the poll still runs.
  }
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

// One look at the server at a time: a call made while one runs makes it look once more after,
// so an older answer can never land over a newer one.
let inflight: Promise<void> | null = null
let again = false
function refresh($: EngineInterface, _cwd: string): Promise<void> {
  if (inflight) {
    again = true
    return inflight
  }
  inflight = (async () => {
    do {
      again = false
      await refreshOnce($)
    } while (again)
  })().finally(() => {
    inflight = null
  })
  return inflight
}

async function refreshOnce($: EngineInterface) {
  let next: Overview
  try {
    bridge ??= await findBridge($)
    if (!bridge) next = { kind: 'no-server', lost: wasLinked }
    else {
      const o = await call($, 'GET', lastRev == null ? '/overview' : `/overview?since=${lastRev}`)
      if (o.unchanged) return
      lastRev = o.rev ?? null
      wasLinked = true
      next = { kind: 'linked', rev: o.rev ?? 0, mode: o.mode, totals: o.totals, tabs: o.tabs ?? [], pages: o.pages, sent: o.sent ?? [], delivery: o.delivery ?? { queued: 0, listening: true } }
    }
  } catch {
    // The server restarted or went away: look it up again next time.
    bridge = null
    lastRev = null
    next = { kind: 'no-server', lost: wasLinked }
  }

  const seen = JSON.stringify(next)
  if (seen === lastSeen) return
  lastSeen = seen
  await update($, overview, () => next)
  $.ui.status(next.kind === 'linked' && next.totals.notes > 0 ? statusLine(next.totals) : undefined)
  void deliverUnheard($, next)
}

// The chat hook delivers notes; it is armed when a turn ends. A turn stopped with Esc ends without
// arming it, and notes would wait until the user types. Notes that have waited UNHEARD_MS with no
// hook listening, while Claude isn't working, go from here instead: the same batch, once (the
// server hands each batch out one time).
const UNHEARD_MS = 3000
async function deliverUnheard($: EngineInterface, now: Overview) {
  if (now.kind !== 'linked' || now.mode !== 'chat' || now.delivery.queued === 0 || now.delivery.listening) {
    unheardSince = null
    return
  }
  const t = await $.clock.now()
  unheardSince ??= t
  if (working || t - unheardSince < UNHEARD_MS) {
    $.clock.after(UNHEARD_MS, async () => deliverUnheard($, await read($, overview))) // an unchanged overview fetches nothing new
    return
  }
  unheardSince = null
  try {
    const { content } = await call($, 'GET', '/next?wait=0')
    if (content) await $.prompt.submit({ text: content })
  } catch {
    // Nothing waiting after all (a hook took it), or the server went: nothing to do.
  }
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

// Tabs the bar names: annotating or recording into this chat.
const isShown = (t: Tab) => t.kind === 'annotating' || t.kind === 'recording'

// "Annotating · localhost:5180/pricing +1": the tab in view first.
function tabsLabel(tabs: Tab[]) {
  const first = [...tabs].sort((a, b) => Number(b.visible) - Number(a.visible))[0]
  if (!first) return ''
  let where = first.url
  try {
    const u = new URL(first.url)
    where = `${u.host}${u.pathname === '/' ? '' : u.pathname}`
  } catch {
    // not a URL: as it is
  }
  const more = tabs.length > 1 ? ` +${tabs.length - 1}` : ''
  return `${first.kind === 'recording' ? '● Recording' : 'Annotating'} · ${clip(where, 48)}${more}`
}

// A prompt the user typed, here or through Remote Control; not a notification, a peer or a plugin.
const isUsersOwn = (kind: string) => kind === 'composer' || kind === 'bridge'

const MAX_OPEN_LINES = 3 // the unfinished notes the bar names
const MAX_RIDES = 20 // the prompts whose rows still name their notes
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

// The unsent notes, taken by the server as one batch for Claude: the text a prompt carries.
// Rejects with the server's reason; "Nothing to send yet." when nothing waits.
async function takeUnsent($: EngineInterface): Promise<string | undefined> {
  return (await call($, 'POST', '/send', { from: 'prompt' })).content
}

async function clearAll($: EngineInterface) {
  await update($, confirmClear, () => false)
  await act($, cwd, 'POST', '/clear')
}

// "📎 2 annotations: 1 make it blue · 2 bigger title", read from the batch the server wrote.
function sentLabel(content: string) {
  const notes = [...content.matchAll(/^### Note (\d+) — "(.*)"$/gm)].map(m => `${m[1]} ${clip(m[2] ?? '', 60)}`)
  if (notes.length) return `📎 ${plural(notes.length, 'annotation')}: ${notes.join(' · ')}`
  const marks = Number(/· (\d+) marks?$/m.exec(content)?.[1] ?? 0)
  return `📎 ${plural(marks, 'mark')} on the page`
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

function clip(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
