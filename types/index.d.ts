export type NoteStatus = 'pending' | 'working' | 'done' | 'skipped'

export type Note = {
  n: number
  text: string
  status?: NoteStatus
  result?: string
  batch?: number
  /** The overlay's ink: pink, sun, cyan or lime. */
  color?: string
}

export type Page = { url: string; notes: Note[]; shapes: number }

export type Totals = { notes: number; shapes: number; pages: number; unsent: number; open: number; batches: number }

/** What the annotate server's GET /overview answers, or why there is nothing to show. */
export type Overview =
  | { kind: 'linked'; mode: string; totals: Totals; pages: Page[] }
  | { kind: 'no-server' }

declare module 'claude-code' {
  interface PluginState {
    annotate: { overview: Overview; error: string | null; confirmClear: boolean }
  }
}
