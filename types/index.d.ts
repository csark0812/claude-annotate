export type NoteStatus = 'pending' | 'working' | 'done' | 'skipped'

export type Note = {
  n: number
  text: string
  status?: NoteStatus
  result?: string
  batch?: number
  /** The overlay's ink: blue (pink, sun, cyan or lime from an older overlay). */
  color?: string
  /** A small JPEG of the tab around the note, cut by the overlay when the note was saved. */
  preview?: Preview | null
  /** A screen recording the note is about: the file, its stills, its length in seconds. */
  video?: { file: string; frames?: string[]; duration?: number } | null
  /** What the note is on, as the overlay read it. */
  ctx?: { selector?: string } | null
}

export type Preview = { src: string; w: number; h: number }

/** A note that went to Claude and left its page. */
export type SentNote = {
  url: string
  n: number
  text: string
  color?: string
  batch: number
  status: NoteStatus
  result: string
  preview: Preview | null
}

export type Page = { url: string; notes: Note[]; shapes: number }

export type Totals = { notes: number; shapes: number; pages: number; unsent: number; open: number; sent: number; batches: number }

/** Batches sent but not yet in Claude's hands; `listening` is false when no chat hook waits to wake Claude. */
export type Delivery = { queued: number; listening: boolean }

/** A browser tab annotating (or recording) into this session: one while its event stream is open. */
export type Tab = { id: string; url: string; title: string; kind: 'annotating' | 'recording'; local: boolean; visible: boolean; since: number }

/** What the annotate server's GET /overview answers, or why there is nothing to show. */
export type Overview =
  | { kind: 'linked'; rev: number; mode: string; totals: Totals; tabs: Tab[]; pages: Page[]; sent: SentNote[]; delivery: Delivery }
  | { kind: 'no-server' }

/** Notes that went out with a prompt the user typed: the prompt's text and the line its row shows under it. */
export type Ride = { text: string; label: string }

declare module 'claude-code' {
  interface PluginState {
    annotate: { overview: Overview; error: string | null; confirmClear: boolean; expanded: boolean; sending: string | null; rides: Ride[] }
  }
}
