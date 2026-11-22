import { useEffect, useEffectEvent, useImperativeHandle, useState, useRef } from 'react'
import { canAllocateCanvas, canvasImageError } from '../../services/canvasImage'
import { capturePixels, fillConnectedPixels, recordEdit } from '../../services/canvasEdits'

function DrawCanvas({
  toolInfo, artwork, canvasApi, activeLayer, ready, locked, readOnly, canDraw, getLayerCanvas, compose,
  onStrokeStart, onStrokeEnd, onRenderError, onInputError, strokeSize, onClassifyStroke, watchLayerRevision,
}) {
  const { width, height, backgroundColor } = artwork
  const allocated = canAllocateCanvas(width, height)
  const [scale, setScale] = useState(() => Math.min(window.innerWidth / width * 0.8, window.innerHeight / height * 0.8, 5))
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const pointer = useRef({ x: 0, y: 0, id: null, changed: false, target: null }).current
  const canvas = useRef(null)
  const [selection, setSelection] = useState(null)
  const history = useRef({ undo: [], redo: [] })
  const selectedArea = toolInfo.tool === 'select' && activeLayer?.visible && selection?.layerId === activeLayer.layerId
    ? selection : null

  const point = event => {
    const rect = canvas.current.getBoundingClientRect()
    return { x: (event.clientX - rect.left) * width / rect.width, y: (event.clientY - rect.top) * height / rect.height }
  }
  const finishStroke = (classify = false) => {
    if (pointer.id === null) return
    const { id, target, changed, layerId, before, context, selectionDrag } = pointer
    pointer.id = null
    pointer.changed = false
    pointer.context = null
    pointer.before = null
    pointer.selectionDrag = null
    if (target?.hasPointerCapture(id)) target.releasePointerCapture(id)
    if (selectionDrag) {
      setSelection(selectionDrag.original)
      if (selectionDrag.preview) compose()
      return
    }
    if (changed) recordEdit(history.current, layerId, before)
    onStrokeEnd(layerId, changed)
    if (changed && classify) onClassifyStroke(layerId, context.canvas)
  }

  const strokeContext = (layerId, allocate = false) => {
    const original = getLayerCanvas(layerId, allocate)
    const ctx = original?.getContext('2d')
    if (original && (!ctx || ctx.isContextLost?.())) throw canvasImageError('레이어를 다시 불러와 주세요.')
    return ctx
  }
  const completeEdit = (layerId, before) => {
    recordEdit(history.current, layerId, before)
    onStrokeEnd(layerId, true)
    compose()
    onInputError(null)
  }
  function fillAt(clientX, clientY, hex) {
    if (!canDraw() || !activeLayer?.visible || pointer.id !== null ||
        document.elementFromPoint(clientX, clientY) !== canvas.current || !/^#[0-9a-f]{6}$/i.test(hex)) return
    const p = point({ clientX, clientY })
    const x = Math.floor(p.x)
    const y = Math.floor(p.y)
    if (x < 0 || y < 0 || x >= width || y >= height) return
    try {
      // A large fill temporarily needs two RGBA buffers and a flood-fill queue.
      if (width * height > 8_388_608) throw canvasImageError('이 크기의 작품에서는 영역 채우기를 사용할 수 없습니다.')
      const layerId = activeLayer.layerId
      const ctx = strokeContext(layerId, true)
      if (!ctx) return
      const composite = canvas.current.getContext('2d').getImageData(0, 0, width, height)
      const pixels = ctx.getImageData(0, 0, width, height)
      const rgb = Number.parseInt(hex.slice(1), 16)
      if (!fillConnectedPixels(composite, pixels, x, y, [rgb >> 16, (rgb >> 8) & 255, rgb & 255, 255])) return
      const before = capturePixels(ctx)
      ctx.putImageData(pixels, 0, 0)
      setSelection(null)
      completeEdit(layerId, before)
    } catch (error) { onInputError(error) }
  }
  useImperativeHandle(canvasApi, () => ({ getCanvas: () => canvas.current, finishStroke, fillAt }))

  const handleHistory = useEffectEvent(event => {
    if (event.defaultPrevented || !(event.ctrlKey || event.metaKey) || event.altKey ||
        (event.code !== 'KeyZ' && event.key.toLowerCase() !== 'z') || pointer.id !== null || !canDraw()) return
    if (event.target instanceof HTMLElement && (event.target.isContentEditable || event.target.matches('input, textarea'))) return
    const { undo, redo } = history.current
    const [from, to] = event.shiftKey ? [redo, undo] : [undo, redo]
    try {
      while (from.length) {
        const entry = from.at(-1)
        const ctx = strokeContext(entry.layerId)
        if (!ctx) { from.pop(); continue }
        event.preventDefault()
        const pixels = capturePixels(ctx)
        if (!pixels) return
        ctx.putImageData(entry.pixels, 0, 0)
        from.pop()
        to.push({ layerId: entry.layerId, pixels })
        setSelection(null)
        onStrokeEnd(entry.layerId, true)
        compose()
        return
      }
    } catch (error) { onInputError(error) }
  })

  useEffect(() => {
    const onKeyDown = event => handleHistory(event)
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const selectionPoint = event => {
    const p = point(event)
    return { x: Math.max(0, Math.min(width, Math.round(p.x))), y: Math.max(0, Math.min(height, Math.round(p.y))) }
  }
  const startSelection = event => {
    const start = selectionPoint(event)
    const original = selectedArea && start.x >= selectedArea.x && start.x < selectedArea.x + selectedArea.width
      && start.y >= selectedArea.y && start.y < selectedArea.y + selectedArea.height ? selectedArea : null
    if (!original) setSelection(null)
    const layerId = activeLayer.layerId
    const drag = { start, original, isCurrent: watchLayerRevision(layerId) }
    // Keep live previews bounded. A large selection can still be moved on release.
    if (original && width * height <= 4_194_304) {
      const ctx = strokeContext(layerId)
      if (ctx) drag.preview = new OffscreenCanvas(width, height).getContext('2d')
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    Object.assign(pointer, {
      id: event.pointerId, target: event.currentTarget, layerId, selectionDrag: drag,
    })
  }
  const selectionAt = (event, drag) => {
    const p = selectionPoint(event)
    const { start, original } = drag
    if (original) return {
      ...original,
      x: Math.max(0, Math.min(width - original.width, original.x + p.x - start.x)),
      y: Math.max(0, Math.min(height - original.height, original.y + p.y - start.y)),
    }
    return {
      layerId: pointer.layerId, x: Math.min(start.x, p.x), y: Math.min(start.y, p.y),
      width: Math.abs(start.x - p.x), height: Math.abs(start.y - p.y),
    }
  }
  const movePixels = (destination, source, original, area) => {
    const cutout = new OffscreenCanvas(original.width, original.height)
    const cutoutContext = cutout.getContext('2d')
    if (!cutoutContext) throw canvasImageError('선택 영역을 이동할 메모리가 부족합니다.')
    cutoutContext.drawImage(source, original.x, original.y, original.width, original.height,
      0, 0, original.width, original.height)
    destination.save()
    try {
      destination.globalCompositeOperation = 'source-over'
      destination.clearRect(original.x, original.y, original.width, original.height)
      destination.drawImage(cutout, area.x, area.y)
    } finally { destination.restore() }
  }
  const finishSelection = event => {
    const drag = pointer.selectionDrag
    const layerId = pointer.layerId
    const area = event.type === 'pointerup' && drag.isCurrent?.() && toolInfo.tool === 'select'
      && activeLayer?.visible && activeLayer.layerId === layerId ? selectionAt(event, drag) : drag.original
    finishStroke()
    setSelection(area?.width && area.height ? area : null)
    const original = drag.original
    if (!original || !area || (area.x === original.x && area.y === original.y)) return
    try {
      const ctx = strokeContext(layerId)
      if (!ctx) return
      const before = capturePixels(ctx)
      movePixels(ctx, ctx.canvas, original, area)
      completeEdit(layerId, before)
    } catch (error) { onInputError(error) }
  }

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
    if (!canDraw() || !allocated || event.button !== 0 || pointer.id !== null) return
    if (!activeLayer?.visible) return
    const p = point(event)
    if (p.x < 0 || p.y < 0 || p.x >= width || p.y >= height) return
    if (toolInfo.tool === 'select') {
      if (event.target === canvas.current) {
        try { startSelection(event) } catch (error) { onInputError(error) }
      }
      return
    }
    if (!['pen', 'eraser'].includes(toolInfo.tool)) return
    setSelection(null)
    let context
    try {
      context = strokeContext(activeLayer.layerId, toolInfo.tool === 'pen')
      if (!context) return
    } catch (error) {
      onInputError(error)
      return
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
      Object.assign(pointer, p, {
        id: event.pointerId, changed: false, target: event.currentTarget, layerId: activeLayer.layerId, context,
        before: capturePixels(context),
      })
      onInputError(null)
      onStrokeStart()
      const ctx = context
      ctx.globalCompositeOperation = toolInfo.tool === 'eraser' ? 'destination-out' : 'source-over'
      ctx.lineWidth = strokeSize
      ctx.lineCap = 'round'
      ctx.strokeStyle = toolInfo.color
      ctx.fillStyle = toolInfo.color
      paint(ctx, p, p, () => { ctx.beginPath(); ctx.arc(p.x, p.y, strokeSize / 2, 0, Math.PI * 2); ctx.fill() })
      if (pointer.changed) compose()
    } catch { drawingError() }
  }
  const onPointerMove = event => {
    if (!ready || pointer.id !== event.pointerId) return
    if (!canDraw()) { finishStroke(); return }
    if (pointer.selectionDrag) {
      const drag = pointer.selectionDrag
      if (toolInfo.tool !== 'select' || !drag.isCurrent?.()) finishStroke()
      else {
        const area = selectionAt(event, drag)
        setSelection(area)
        if (drag.preview) {
          const { preview, original } = drag
          try {
            const source = strokeContext(pointer.layerId)?.canvas
            if (!source) { finishStroke(); return }
            preview.clearRect(0, 0, width, height)
            preview.drawImage(source, 0, 0)
            if (area.x !== original.x || area.y !== original.y) movePixels(preview, source, original, area)
            compose({ layerId: pointer.layerId, canvas: preview.canvas })
          } catch (error) {
            finishStroke()
            onInputError(error)
          }
        }
      }
      return
    }
    try {
      const from = { x: pointer.x, y: pointer.y }
      const to = point(event)
      Object.assign(pointer, to)
      const ctx = pointer.context
      paint(ctx, from, to, () => { ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke() })
      if (pointer.changed) compose()
    } catch { drawingError() }
  }
  const onPointerUp = event => {
    if (pointer.id !== event.pointerId) return
    if (pointer.selectionDrag) finishSelection(event)
    else finishStroke(event.type === 'pointerup')
  }

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
        data-ready={ready && !locked} data-read-only={readOnly} aria-busy={!ready || locked}
        style={{ background: backgroundColor, transform: `translate(calc(-50% + ${pos.x}px), calc(-50% + ${pos.y}px))scale(${scale})` }}
      />
      {selectedArea?.width > 0 && selectedArea.height > 0 && <div className="canvas-selection" aria-hidden="true" style={{
        left: `calc(50% + ${pos.x + (selectedArea.x - width / 2) * scale}px)`,
        top: `calc(50% + ${pos.y + (selectedArea.y - height / 2) * scale}px)`,
        width: selectedArea.width * scale, height: selectedArea.height * scale,
      }} />}
    </div>
  )
}

export default DrawCanvas
