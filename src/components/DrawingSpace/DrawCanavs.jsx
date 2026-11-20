import { useEffect, useImperativeHandle, useState, useRef } from 'react'
import { canAllocateCanvas, canvasImageError } from '../../services/canvasImage'

function DrawCanvas({
  toolInfo, artwork, canvasApi, activeLayer, ready, locked, getLayerCanvas, compose,
  onStrokeStart, onStrokeEnd, onRenderError, onInputError,
}) {
  const { width, height, backgroundColor } = artwork
  const allocated = canAllocateCanvas(width, height)
  const [scale, setScale] = useState(() => Math.min(window.innerWidth / width * 0.8, window.innerHeight / height * 0.8, 5))
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const pointer = useRef({ x: 0, y: 0, id: null, changed: false, target: null }).current
  const canvas = useRef(null)

  const point = event => {
    const rect = canvas.current.getBoundingClientRect()
    return { x: (event.clientX - rect.left) * width / rect.width, y: (event.clientY - rect.top) * height / rect.height }
  }
  const finishStroke = () => {
    if (pointer.id === null) return
    const { id, target, changed, layerId } = pointer
    pointer.id = null
    pointer.changed = false
    pointer.context = null
    if (target?.hasPointerCapture(id)) target.releasePointerCapture(id)
    onStrokeEnd(layerId, changed)
  }
  useImperativeHandle(canvasApi, () => ({ getCanvas: () => canvas.current, finishStroke }))

  // 첫 실제 변경까지만 영향 영역을 비교한다. 빈 곳 지우기는 저장하지 않는다.
  const paint = (ctx, from, to, draw) => {
    if (pointer.changed) { draw(); return }
    const radius = ctx.lineWidth / 2 + 2
    const x = Math.max(0, Math.floor(Math.min(from.x, to.x) - radius))
    const y = Math.max(0, Math.floor(Math.min(from.y, to.y) - radius))
    const w = Math.min(width, Math.ceil(Math.max(from.x, to.x) + radius)) - x
    const h = Math.min(height, Math.ceil(Math.max(from.y, to.y) + radius)) - y
    if (w <= 0 || h <= 0) return
    const before = ctx.getImageData(x, y, w, h).data
    draw()
    pointer.changed = true // 변경 후 픽셀 읽기에 실패해도 미저장 변경으로 취급한다.
    const after = ctx.getImageData(x, y, w, h).data
    pointer.changed = before.some((value, index) => value !== after[index])
  }
  const drawingError = () => {
    finishStroke()
    onRenderError(canvasImageError('그림판 메모리 또는 픽셀 처리 오류가 발생했습니다. 저장된 PNG는 유지됩니다. 다시 불러오면 저장되지 않은 변경은 사라질 수 있습니다.'))
  }
  useEffect(() => {
    const element = canvas.current
    element.addEventListener('contextlost', drawingError)
    return () => element.removeEventListener('contextlost', drawingError)
  })
  const onPointerDown = event => {
    if (!ready || locked || !allocated || event.button !== 0 || pointer.id !== null || !['pen', 'eraser'].includes(toolInfo.tool)) return
    if (!activeLayer?.visible) return
    const p = point(event)
    if (p.x < 0 || p.y < 0 || p.x >= width || p.y >= height) return
    let context
    try {
      const original = getLayerCanvas(activeLayer.layerId, toolInfo.tool === 'pen')
      if (!original) return
      context = original.getContext('2d')
      if (!context || context.isContextLost?.()) throw canvasImageError('레이어를 다시 불러와 주세요.')
    } catch (error) {
      onInputError(error)
      return
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
      Object.assign(pointer, p, {
        id: event.pointerId, changed: false, target: event.currentTarget, layerId: activeLayer.layerId, context,
      })
      onInputError(null)
      onStrokeStart()
      const ctx = context
      ctx.globalCompositeOperation = toolInfo.tool === 'eraser' ? 'destination-out' : 'source-over'
      ctx.lineWidth = toolInfo.tool === 'eraser' ? 20 : 4
      ctx.lineCap = 'round'
      ctx.strokeStyle = toolInfo.color
      ctx.fillStyle = toolInfo.color
      paint(ctx, p, p, () => { ctx.beginPath(); ctx.arc(p.x, p.y, 2, 0, Math.PI * 2); ctx.fill() })
      if (pointer.changed) compose()
    } catch { drawingError() }
  }
  const onPointerMove = event => {
    if (!ready || pointer.id !== event.pointerId) return
    try {
      const from = { x: pointer.x, y: pointer.y }
      const to = point(event)
      Object.assign(pointer, to)
      const ctx = pointer.context
      paint(ctx, from, to, () => { ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke() })
      if (pointer.changed) compose()
    } catch { drawingError() }
  }
  const onPointerUp = event => { if (pointer.id === event.pointerId) finishStroke() }

  return (
    <div className="drawarea" onWheel={event => {
      if (!ready || locked || pointer.id !== null) return
      const p = point(event)
      const delta = event.deltaY > 0 ? scale / 20 : -scale / 20
      const nextScale = Math.min(Math.max(scale + delta, 0.01), 5)
      setPos({ x: pos.x + (p.x - width / 2) * (scale - nextScale), y: pos.y + (p.y - height / 2) * (scale - nextScale) })
      setScale(nextScale)
    }}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove}
      onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onLostPointerCapture={onPointerUp}
    >
      <canvas ref={canvas} className="drawcanvas" width={allocated ? width : 1} height={allocated ? height : 1}
        data-ready={ready && !locked} aria-busy={!ready || locked}
        style={{ background: backgroundColor, transform: `translate(calc(-50% + ${pos.x}px), calc(-50% + ${pos.y}px))scale(${scale})` }}
      />
    </div>
  )
}

export default DrawCanvas
