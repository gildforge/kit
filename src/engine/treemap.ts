// Squarified treemap layout (Bruls, Huizing, van Wijk). Boxes come out in the
// units of the rectangle passed in; Glance lays out in a W×H box and then
// converts to percentages so the map scales with its container.

export interface Rect { x: number; y: number; w: number; h: number }

function worst(row: number[], side: number) {
  const sum = row.reduce((a, b) => a + b, 0)
  const max = Math.max(...row)
  const min = Math.min(...row)
  return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min))
}

/** Places `values` (any positive weights, largest first works best) in `box`. */
export function squarify(values: number[], box: Rect): Rect[] {
  const total = values.reduce((a, b) => a + b, 0)
  if (!values.length || total <= 0) return []
  const scale = (box.w * box.h) / total
  const areas = values.map((v) => v * scale)
  const out: Rect[] = []
  let { x, y, w, h } = box
  let i = 0
  while (i < areas.length) {
    const side = Math.min(w, h)
    const row = [areas[i]]
    let j = i + 1
    while (j < areas.length && worst([...row, areas[j]], side) <= worst(row, side)) row.push(areas[j++])
    const sum = row.reduce((a, b) => a + b, 0)
    if (w >= h) {
      // A column on the left.
      const cw = h > 0 ? sum / h : 0
      let cy = y
      for (const a of row) { const rh = cw > 0 ? a / cw : 0; out.push({ x, y: cy, w: cw, h: rh }); cy += rh }
      x += cw; w -= cw
    } else {
      // A row along the top.
      const rh = w > 0 ? sum / w : 0
      let cx = x
      for (const a of row) { const cw = rh > 0 ? a / rh : 0; out.push({ x: cx, y, w: cw, h: rh }); cx += cw }
      y += rh; h -= rh
    }
    i = j
  }
  return out
}
