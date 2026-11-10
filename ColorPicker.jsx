
import { useEffect, useRef, useState } from 'react'
import './ColorPicker.css'

// HSV → HEX
function hsvToHex(h, s, v) {
  s /= 100
  v /= 100

  const c = v * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = v - c

  let r = 0, g = 0, b = 0

  if (h < 60) [r, g, b] = [c, x, 0]
  else if (h < 120) [r, g, b] = [x, c, 0]
  else if (h < 180) [r, g, b] = [0, c, x]
  else if (h < 240) [r, g, b] = [0, x, c]
  else if (h < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]

  return '#' + [r, g, b]
    .map(n =>
      Math.round((n + m) * 255)
        .toString(16)
        .padStart(2, '0')
    )
    .join('')
}

// HEX → HSV
function hexToHsv(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255

  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min

  let h = 0

  if (delta !== 0) {
    if (max === r) h = ((g - b) / delta) % 6
    else if (max === g) h = (b - r) / delta + 2
    else h = (r - g) / delta + 4

    h = (h * 60 + 360) % 360
  }

  return {
    h,
    s: max === 0 ? 0 : (delta / max) * 100,
    v: max * 100
  }
}

export default function ColorPicker({
  onClose,
  onColorChange,
  recentColors = [],
  onSaveColor,
  initialColor = '#e32d20'
}) {
  const [hsv, setHsv] = useState(() => hexToHsv(initialColor))

  // 드래그 중인 실제 HSV 값
  const hsvRef = useRef(hsv)

  // 드래그 중인 영역
  const dragTarget = useRef(null)

  // DOM 참조
  const hueRef = useRef(null)
  const squareRef = useRef(null)

  // 애니메이션 프레임
  const frameRef = useRef(null)

  const color = hsvToHex(hsv.h, hsv.s, hsv.v)
  const pureHue = hsvToHex(hsv.h, 100, 100)

  // 최신 콜백을 참조
  const onColorChangeRef = useRef(onColorChange)

  useEffect(() => {
    onColorChangeRef.current = onColorChange
  }, [onColorChange])

  // 컴포넌트 종료 시 예약 프레임 정리
  useEffect(() => {
    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
      }
    }
  }, [])

  // 화면 업데이트는 프레임당 최대 1회
  const scheduleUpdate = () => {
    if (frameRef.current !== null) return

    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null

      const next = { ...hsvRef.current }

      setHsv(next)

      onColorChangeRef.current?.(
        hsvToHex(next.h, next.s, next.v)
      )
    })
  }

  // 원형 색상환: H만 변경
  const handleHue = (e) => {
    const rect = hueRef.current.getBoundingClientRect()

    const x = e.clientX - rect.left - rect.width / 2
    const y = e.clientY - rect.top - rect.height / 2

    const angle = Math.atan2(y, x) * 180 / Math.PI
    const h = (angle + 90 + 360) % 360

    hsvRef.current.h = h

    scheduleUpdate()
  }

  // 중앙 사각형: S, V만 변경
  const handleSquare = (e) => {
    const rect = squareRef.current.getBoundingClientRect()

    const x = Math.max(
      0,
      Math.min(1, (e.clientX - rect.left) / rect.width)
    )

    const y = Math.max(
      0,
      Math.min(1, (e.clientY - rect.top) / rect.height)
    )

    hsvRef.current.s = x * 100
    hsvRef.current.v = (1 - y) * 100

    scheduleUpdate()
  }

  const startDrag = (e, target) => {
    e.preventDefault()
    e.stopPropagation()

    dragTarget.current = {
      target,
      pointerId: e.pointerId
    }

    e.currentTarget.setPointerCapture(e.pointerId)

    if (target === 'hue') handleHue(e)
    else handleSquare(e)
  }

  const moveDrag = (e, target) => {
    e.stopPropagation()

    const drag = dragTarget.current

    if (
      !drag ||
      drag.target !== target ||
      drag.pointerId !== e.pointerId
    ) {
      return
    }

    if (target === 'hue') handleHue(e)
    else handleSquare(e)
  }

  const endDrag = (e) => {
    e.stopPropagation()

    const drag = dragTarget.current

    if (!drag || drag.pointerId !== e.pointerId) return

    dragTarget.current = null

    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }

  const selectRecentColor = (hex) => {
    const next = hexToHsv(hex)

    hsvRef.current = next

    // 대기 중인 드래그 프레임이 있으면 제거
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }

    setHsv({ ...next })
    onColorChangeRef.current?.(hex)
  }

  const closePicker = () => {
    // 마지막 드래그 값까지 정확히 저장
    const finalColor = hsvToHex(
      hsvRef.current.h,
      hsvRef.current.s,
      hsvRef.current.v
    )

    onColorChangeRef.current?.(finalColor)
    onSaveColor?.(finalColor)
    onClose?.()
  }

  const hueAngle = (hsv.h - 90) * Math.PI / 180
  const hueRadius = 93

  const hueX = 107 + Math.cos(hueAngle) * hueRadius
  const hueY = 107 + Math.sin(hueAngle) * hueRadius

  return (
    <div className="color-picker">
      <div className="color-picker-header">
        <strong>색 지정</strong>

        <button type="button" onClick={closePicker}>
          ×
        </button>
      </div>

      <div className="color-picker-body">
        <div
          className="hue-wheel"
          ref={hueRef}
          onPointerDown={(e) => {
            // 중앙 사각형 클릭은 색상환에서 처리하지 않음
            if (e.target !== e.currentTarget) return
            startDrag(e, 'hue')
          }}
          onPointerMove={(e) => moveDrag(e, 'hue')}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <div
            className="hue-indicator"
            style={{
              left: hueX,
              top: hueY,
              backgroundColor: pureHue
            }}
          />

          <div
            className="sv-square"
            ref={squareRef}
            style={{
              backgroundColor: pureHue
            }}
            onPointerDown={(e) => startDrag(e, 'square')}
            onPointerMove={(e) => moveDrag(e, 'square')}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <div className="sv-white" />
            <div className="sv-black" />

            <div
              className="sv-indicator"
              style={{
                left: `${hsv.s}%`,
                top: `${100 - hsv.v}%`
              }}
            />
          </div>
        </div>
      </div>

      <div className="recent-colors">
        {Array.from({ length: 7 }, (_, i) => {
          const isCurrentColor = i === 0

          const recent = isCurrentColor
            ? color
            : recentColors[i - 1]

          return (
            <button
              key={i}
              type="button"
              className={`recent-color ${
                isCurrentColor ? 'current-color' : ''
              }`}
              title={
                isCurrentColor
                  ? `현재 색상: ${color}`
                  : recent || '빈 색상'
              }
              style={{
                backgroundColor: recent || '#d9d9d9'
              }}
              onClick={() => {
                if (!isCurrentColor && recent) {
                  selectRecentColor(recent)
                }
              }}
            />
          )
        })}
      </div>
    </div>
  )
}
