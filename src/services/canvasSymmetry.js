function clipToHalf({ x, y, width, height }, origin, dx, dy, side) {
  const corners = [
    { x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }
  ]
  const distance = point => side * (dx * (point.y - origin.y) - dy * (point.x - origin.x))
  const polygon = []
  for (let i = 0; i < corners.length; i++) {
    const start = corners[i]
    const end = corners[(i + 1) % corners.length]
    const from = distance(start)
    const to = distance(end)
    if (from >= 0) polygon.push(start)
    if ((from < 0 && to > 0) || (from > 0 && to < 0)) {
      const t = from / (from - to)
      polygon.push({ x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t })
    }
  }
  return polygon
}

function symmetryTransform(axis) {
  const [first, second] = axis
  const length = Math.hypot(second.x - first.x, second.y - first.y)
  const dx = (second.x - first.x) / length
  const dy = (second.y - first.y) / length
  const a = 2 * dx * dx - 1
  const b = 2 * dx * dy
  const d = 2 * dy * dy - 1
  return { first, dx, dy, matrix: [a, b, b, d, first.x - a * first.x - b * first.y, first.y - b * first.x - d * first.y] }
}

function polygonPath(points) {
  const path = new Path2D()
  path.moveTo(points[0].x, points[0].y)
  for (const point of points.slice(1)) path.lineTo(point.x, point.y)
  path.closePath()
  return path
}

export function prepareSymmetryBrush({ area, axis, sourceSide }) {
  const { first, dx, dy } = symmetryTransform(axis)
  const distance = ({ x, y }) => dx * (y - first.y) - dy * (x - first.x)
  const fold = point => {
    const offset = distance(point)
    return offset * sourceSide >= 0 ? point : { x: point.x + 2 * dy * offset, y: point.y - 2 * dx * offset }
  }
  const half = clipToHalf(area, first, dx, dy, sourceSide)
  return {
    clip: half.length >= 3 ? polygonPath(half) : new Path2D(),
    fold,
    // A stroke crossing the axis bends at the crossing point when folded.
    split(from, to) {
      const a = distance(from)
      const b = distance(to)
      if (a * b >= 0) return null
      const t = a / (a - b)
      return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }
    }
  }
}

export function drawSymmetry(ctx, { area, source, working, axis, sourceSide }) {
  const { first, dx, dy, matrix } = symmetryTransform(axis)
  const opposite = clipToHalf(area, first, dx, dy, -sourceSide)
  const { x, y, width, height } = area
  const drawSource = () => ctx.drawImage(working ?? source, working ? 0 : x, working ? 0 : y, width, height, x, y, width, height)

  ctx.clearRect(x, y, width, height)
  drawSource()
  if (opposite.length < 3) return
  ctx.save()
  try {
    ctx.clip(polygonPath(opposite))
    ctx.clearRect(x, y, width, height)
    ctx.transform(...matrix)
    drawSource()
  } finally {
    ctx.restore()
  }
}

export function updateSymmetryPreview(previous, draft) {
  const { area, source } = draft
  let preview = previous
  if (!preview?.symmetry || preview.area !== area || preview.source !== source) {
    const ctx = new OffscreenCanvas(source.width, source.height).getContext('2d')
    ctx.drawImage(source, 0, 0)
    preview = { area, source, ctx, symmetry: true }
  }
  drawSymmetry(preview.ctx, draft)
  return preview
}
