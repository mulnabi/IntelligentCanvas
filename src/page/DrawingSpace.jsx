import { useState, useRef } from 'react'
import { Link } from 'react-router'

import ToolPicker from '../components/DrawingSpace/ToolPicker'
import DrawCanvas from '../components/DrawingSpace/DrawCanavs'
import LayerMenu from '../components/DrawingSpace/LayerMenu'

import { useLayers } from '../hook/useLayers'
import { useCanvasPersistence } from '../hook/useCanvasPersistence'
import { getCanvasErrorMessage } from '../repositories/canvasRepository'


import './DrawingSpace.css'

function DrawingSpace({ artwork }) {
  const canvasApi = useRef(null)
  const [toolInfo, setToolInfo] = useState({tool: 'pen', color: '#000000'});
  const [inputError, setInputError] = useState('')
  const persistence = useCanvasPersistence(artwork, canvasApi)
  const statusText = { loading: '그림을 불러오는 중…', ready: '그리거나 레이어 설정을 바꾸면 자동 저장됩니다', pending: '저장 대기 중…', saving: '저장 중…', saved: '이 브라우저에 저장됨', error: '그림 처리 실패' }

  const layerState = useLayers(persistence)
  const activeLayer = layerState.layers.find(layer => layer.layerId === layerState.activeId)
  return (
    <>
      <ToolPicker f={setToolInfo} />
      <DrawCanvas toolInfo={toolInfo} artwork={artwork} canvasApi={canvasApi} activeLayer={activeLayer}
        onInputError={error => setInputError(error ? getCanvasErrorMessage(error) : '')} {...persistence}/>
      {persistence.ready && <LayerMenu {...layerState} disabled={persistence.locked} />}
      {artwork && <aside aria-label="현재 작품 정보" data-artwork-id={artwork.artworkId}
        style={{ position: 'fixed', left: 12, bottom: 12, zIndex: 2, maxWidth: 'calc(100% - 48px)', background: 'white', padding: '8px 12px', borderRadius: 8 }}>
        <strong>{artwork.title}</strong> · {artwork.width} × {artwork.height}px · <Link to="/">작품 목록</Link>
        <p role="status" aria-live="polite">{statusText[persistence.status]}</p>
        {persistence.error && <p role="alert">{persistence.error}{' '}
          {persistence.failure === 'save'
            ? <button onClick={persistence.retrySave}>다시 저장</button>
            : <button onClick={persistence.retryLoad}>다시 불러오기</button>}
        </p>}
        {persistence.blocked && <p>저장을 완료한 후 이동합니다. <button onClick={persistence.stay}>이 화면에 머무르기</button></p>}
        {inputError && !persistence.error && <p role="alert">{inputError} <button onClick={() => setInputError('')}>닫기</button></p>}
        {activeLayer?.visible === false && <p role="status">선택한 레이어가 숨겨져 있습니다. 다시 표시한 뒤 그려 주세요.</p>}
      </aside>}
    </>
  )
}

export default DrawingSpace
