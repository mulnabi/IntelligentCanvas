import { useState, useRef } from 'react'

import ToolPicker from '../components/DrawingSpace/ToolPicker'
import DrawCanvas from '../components/DrawingSpace/DrawCanavs'
import LayerMenu from '../components/DrawingSpace/LayerMenu'

import { useLayers } from '../hook/useLayers'
import { useCanvasPersistence } from '../hook/useCanvasPersistence'
import { useEditSession } from '../hook/useEditSession'
import { useArtworkSync } from '../hook/useArtworkSync'
import { getCanvasErrorMessage } from '../repositories/canvasRepository'

import './DrawingSpace.css'

function ArtworkEditor({ artwork, edit, serverSnapshot }) {
  const canvasApi = useRef(null)
  const [toolInfo, setToolInfo] = useState({tool: 'pen', color: '#000000'});
  const [toolSizes, setToolSizes] = useState({ pen: 50, eraser: 20 })
  const [penOpacity, setPenOpacity] = useState(100)
  const sizeTool = toolInfo.tool === 'eraser' ? 'eraser' : 'pen'
  const strokeSize = toolSizes[sizeTool]
  const persistence = useCanvasPersistence(artwork, canvasApi, serverSnapshot)
  useArtworkSync(persistence.ready && !serverSnapshot, edit.saveAutomatically)

  const layerState = useLayers(persistence)
  const activeLayer = layerState.layers.find(layer => layer.layerId === layerState.activeId)
  return (
    <>
      <ToolPicker f={setToolInfo} onColorDrop={(x, y, color) => canvasApi.current?.fillAt(x, y, color)} />
      <DrawCanvas toolInfo={toolInfo} strokeSize={strokeSize} penOpacity={penOpacity / 100} artwork={artwork} canvasApi={canvasApi} activeLayer={activeLayer} readOnly={!edit.writable}
        onInputError={error => { if (error) console.error(getCanvasErrorMessage(error)) }} {...persistence}/>
      <div className="brush-controls">
        <div className="brush-setting">
          <input type="range" min="1" max="100" value={strokeSize}
            aria-label={sizeTool === 'eraser' ? '지우개 크기' : '브러시 크기'}
            aria-valuetext={`${strokeSize}px`}
            onChange={event => {
              const size = event.currentTarget.valueAsNumber
              setToolSizes(sizes => ({ ...sizes, [sizeTool]: size }))
            }} />
          <span aria-hidden="true">{strokeSize} px</span>
        </div>
        <label className="brush-setting brush-opacity">
          <span>펜 불투명도</span>
          <input type="range" min="0" max="100" value={penOpacity}
            aria-valuetext={`${penOpacity}%`}
            onChange={event => setPenOpacity(event.currentTarget.valueAsNumber)} />
          <span aria-hidden="true">{penOpacity}%</span>
        </label>
      </div>
      {persistence.ready && <LayerMenu {...layerState} getLayerPreview={persistence.getLayerPreview}
        select={id => {
          if (persistence.canDraw()) canvasApi.current?.trackLayerSelection(id)
          layerState.select(id)
        }}
        disabled={persistence.locked || !edit.writable} />}
    </>
  )
}

export default function DrawingSpace({ artwork, serverSnapshot }) {
  const edit = useEditSession(artwork.uid, artwork.artworkId, Boolean(serverSnapshot))
  if (edit.status === 'checking') return <p className="no-result" role="status">작품 편집 권한 확인 중…</p>
  return <ArtworkEditor key={edit.canvasEpoch} artwork={artwork} edit={edit} serverSnapshot={serverSnapshot} />
}
