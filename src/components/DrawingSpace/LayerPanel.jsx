import { useState, useRef } from 'react'
import './LayerPanel.css'

const ROW_H = 56 // 줄 높이 52 + 간격 4

const icons = {
  plus: 'M16 7v18M7 16h18',
  close: 'M8 8l16 16M24 8 8 24',
  eye: 'M3 16s5-8 13-8 13 8 13 8-5 8-13 8S3 16 3 16ZM20 16a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
  eyeOff: 'M3 16s5-8 13-8 13 8 13 8-5 8-13 8S3 16 3 16ZM6 6l20 20',
  grip: 'M11 10h10M11 16h10M11 22h10',
}

const Icon = ({ name }) => (
  <svg viewBox="0 0 32 32"><path d={icons[name]} /></svg>
)

function LayerPanel({ layers, activeId, select, toggle, setOpacity, add, remove, move, Close }) {
  const [drag, setDrag] = useState(null) 
  const dragged = useRef(false)          // 끌고 난 직후 클릭 통제

  const active = layers.find(l => l.layerId === activeId)
  const opacity = Math.round(active.opacity * 100)

  // 끌고 있는 줄이 지금 몇 번째 자리인지 체크
  let dragTo = -1
  if (drag) {
    dragTo = drag.from + Math.round(drag.dy / ROW_H)
    dragTo = Math.max(0, Math.min(layers.length - 1, dragTo))
  }

  const dragStart = (e, id, index) => {
    dragged.current = false
    if (layers.length < 2) return
    if (e.target.closest('.layer-eye')) return
    if (e.pointerType !== 'mouse' && !e.target.closest('.layer-grip')) return
    setDrag({ id, from: index, startY: e.clientY, dy: 0, moving: false })
  }

  const dragMove = e => {
    if (!drag) return
    const dy = e.clientY - drag.startY
    if (!drag.moving && Math.abs(dy) < 5) return //
    if (!drag.moving) {
      dragged.current = true
      e.currentTarget.setPointerCapture(e.pointerId)
    }
    setDrag({ ...drag, dy, moving: true })
  }

 const dragEnd = () => {
  if (!drag) return
  if (drag.moving) move(drag.id, dragTo)
  setDrag(null)
  setTimeout(() => { dragged.current = false }, 0) 
}

// 
const dragLeave = () => {
  if (drag && !drag.moving) setDrag(null)
}

  return (
    <section className="layer-panel">
      <header className="layer-head">
        <h2>레이어</h2>
        <span className="layer-count">{layers.length}</span>
        <button className="layer-add" title="레이어 추가" onClick={add}><Icon name="plus" /></button>
        <button className="layer-close" title="닫기" onClick={Close}><Icon name="close" /></button>
      </header>

      <ol className={drag && drag.moving ? 'layer-rows is-sorting' : 'layer-rows'}>
        {layers.map((layer, index) => {
          const id = layer.layerId
          let cls = 'layer-row'
          if (id === activeId) cls += ' is-selected'
          if (!layer.visible) cls += ' is-hidden'

          // 끄는 중이면 줄 위치를 옮겨서 보여줌
          let y = 0
          if (drag && drag.moving) {
            if (id === drag.id) {
              y = drag.dy
              cls += ' is-dragging'
            } else if (drag.from < index && index <= dragTo) {
              y = -ROW_H // 
            } else if (dragTo <= index && index < drag.from) {
              y = ROW_H  // 
            }
          }

          return (
            <li key={id} className={cls} style={{ transform: `translateY(${y}px)` }}
              onPointerDown={e => dragStart(e, id, index)}
              onPointerMove={dragMove}
              onPointerUp={dragEnd}
              onPointerCancel={() => setDrag(null)}>
              <span className="layer-grip"><Icon name="grip" /></span>
              <button className="layer-select" onClick={() => { if (!dragged.current) select(id) }}>
                <span className="layer-thumb"></span>
                <span className="layer-name">{layer.name}</span>
                {layer.category && <span className="layer-tag">{layer.category}</span>}
              </button>
              <button className="layer-eye" title="보이기/숨기기" onClick={() => toggle(id)}>
                <Icon name={layer.visible ? 'eye' : 'eyeOff'} />
              </button>
            </li>
          )
        })}
      </ol>

      <div className="layer-bottom">
        <label className="layer-opacity">
          불투명도
          <input type="range" min="0" max="100" value={opacity}
            onChange={e => setOpacity(activeId, e.target.value / 100)} />
          <span>{opacity}%</span>
        </label>
        <button className="layer-delete" disabled={layers.length <= 1} onClick={() => remove(activeId)}>
          레이어 삭제
        </button>
      </div>
    </section>
  )
}

export default LayerPanel
