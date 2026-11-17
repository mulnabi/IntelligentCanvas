
import { useState, useEffect } from 'react'
import './Color.css'

import { Blind } from '../mainComponents'

// ------ 추가-1 : 색상 변환 ------
function hexToHsv(hex = '#ff0000') {
  let value = hex.replace('#', '')
  if (value.length === 3) value = [...value].map(v => v + v).join('')
  if (!/^[0-9a-f]{6}$/i.test(value)) value = 'ff0000'

  const r = parseInt(value.slice(0, 2), 16) / 255
  const g = parseInt(value.slice(2, 4), 16) / 255
  const b = parseInt(value.slice(4, 6), 16) / 255

  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min

  let h = 0
  if (delta !== 0) {
    if (max === r) h = ((g - b) / delta) % 6
    else if (max === g) h = (b - r) / delta + 2
    else h = (r - g) / delta + 4
  }

  return {
    h: (h * 60 + 360) % 360,
    s: max === 0 ? 0 : delta / max,
    v: max
  }
}

function hsvToHex({ h, s, v }) {
  const f = n => {
    const k = (n + h / 60) % 6
    return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255)
      .toString(16).padStart(2, '0')
  }
  return `#${f(5)}${f(3)}${f(1)}`
}
// ---------------------

function Color({ color, onChange }) {
  const [hide, setHide] = useState(true)

  // ------ 추가-2 : 색상 상태 ------
  const [hsv, setHsv] = useState(() => hexToHsv(color))
  const [recent, setRecent] = useState([color || '#ff0000'])

  useEffect(() => {
    setHsv(hexToHsv(color))
  }, [color])

  const selectedColor = hsvToHex(hsv)

  function changeColor(next) {
    setHsv(next)
    onChange?.(hsvToHex(next))
  }

  function changeHue(e) {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left - rect.width / 2
    const y = e.clientY - rect.top - rect.height / 2
    const h = (Math.atan2(x, -y) * 180 / Math.PI + 360) % 360

    changeColor({ ...hsv, h })
  }

  function changeSV(e) {
    const rect = e.currentTarget.getBoundingClientRect()
    const s = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    const v = 1 - Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height))

    changeColor({ ...hsv, s, v })
  }

  function saveRecent() {
    setRecent(prev => [
      selectedColor,
      ...prev.filter(c => c !== selectedColor)
    ].slice(0, 8))
  }
  // ---------------------

  return(<>
    <div className="openColorPicker" style={{background: selectedColor}} onClick={() => {setHide(false)}}></div>
    <Blind hide={hide} onClick={() => {setHide(true)}}>
      <div className="color-picker-menu" onClick={(e) => e.stopPropagation()}>

        {/* ------ 추가-3 : 컬러픽커 UI ------ */}
        <div className="color-picker-header">
          <strong>색 지정</strong>
          <button type="button" onClick={() => setHide(true)}>×</button>
        </div>

        <div
          className="color-picker-wheel"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            changeHue(e)
          }}
          onPointerMove={(e) => {
            if (e.currentTarget.hasPointerCapture(e.pointerId)) changeHue(e)
          }}
          onPointerUp={saveRecent}
        >
          <div
            className="color-picker-hue-marker"
            style={{
              left: `${50 + Math.sin(hsv.h * Math.PI / 180) * 44}%`,
              top: `${50 - Math.cos(hsv.h * Math.PI / 180) * 44}%`,
              background: `hsl(${hsv.h} 100% 50%)`
            }}
          />

          <div
            className="color-picker-square"
            style={{
              background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${hsv.h} 100% 50%))`
            }}
            onPointerDown={(e) => {
              e.stopPropagation()
              e.currentTarget.setPointerCapture(e.pointerId)
              changeSV(e)
            }}
            onPointerMove={(e) => {
              if (e.currentTarget.hasPointerCapture(e.pointerId)) changeSV(e)
            }}
          >
            <div
              className="color-picker-sv-marker"
              style={{
                left: `${hsv.s * 100}%`,
                top: `${(1 - hsv.v) * 100}%`
              }}
            />
          </div>
        </div>

        <div className="color-picker-recent">
          {Array.from({length: 8}, (_, i) => (
            <button
              type="button"
              key={i}
              className="color-picker-swatch"
              style={{background: recent[i] || '#d9d9d9'}}
              onClick={() => {
                if (!recent[i]) return
                changeColor(hexToHsv(recent[i]))
              }}
            />
          ))}
        </div>
        {/* --------------------- */}

      </div>
    </Blind>
  </>)
}

export default Color
