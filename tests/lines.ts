// A drawn tree as the lines a terminal shows, roughly: Texts are lines, a
// column Box stacks, a row Box sets its children side by side, a border
// frames, marginTop and paddingTop add blank lines. Enough to find what is
// drawn at which row, for clicks in tests.

type Drawn =
  | string
  | number
  | boolean
  | null
  | undefined
  | { type: string; props?: Record<string, unknown>; children?: Drawn[] }

const textOf = (el: Drawn): string => {
  if (el === null || el === undefined || typeof el === 'boolean') return ''
  if (typeof el === 'string' || typeof el === 'number') return String(el)
  return (el.children ?? []).flat().map(textOf).join('')
}

export const linesOf = (el: Drawn): string[] => {
  if (el === null || el === undefined || typeof el === 'boolean') return []
  if (typeof el === 'string' || typeof el === 'number') return [String(el)]
  if (el.type === 'Text') return [textOf(el)]
  if (el.type !== 'Box') return []
  const p = el.props ?? {}
  const kids = (el.children ?? []).flat()
  let lines: string[]
  if (p.flexDirection === 'row') {
    const cols = kids.map(linesOf)
    const widths = cols.map(c => Math.max(0, ...c.map(l => l.length)))
    const h = Math.max(0, ...cols.map(c => c.length))
    lines = Array.from({ length: h }, (_, y) => cols.map((c, i) => (c[y] ?? '').padEnd(widths[i]!)).join(''))
  } else {
    lines = kids.flatMap(linesOf)
  }
  if (p.borderStyle) {
    const w = typeof p.width === 'number' ? p.width : Math.max(0, ...lines.map(l => l.length)) + 2
    lines = [`╭${'─'.repeat(w - 2)}╮`, ...lines.map(l => `│${l.padEnd(w - 2)}│`), `╰${'─'.repeat(w - 2)}╯`]
  }
  const pad = Number(p.marginTop ?? 0) + Number(p.paddingTop ?? 0)

  return [...Array<string>(pad).fill(''), ...lines]
}
