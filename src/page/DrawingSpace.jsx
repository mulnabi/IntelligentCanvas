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
  const sizeTool = toolInfo.tool === 'eraser' ? 'eraser' : 'pen'
  const strokeSize = toolSizes[sizeTool]
  const persistence = useCanvasPersistence(artwork, canvasApi, serverSnapshot)
  useArtworkSync(persistence.ready && !serverSnapshot, edit.saveAutomatically)

  const layerState = useLayers(persistence)
  const activeLayer = layerState.layers.find(layer => layer.layerId === layerState.activeId)
  return (
    <>
      <ToolPicker f={setToolInfo} onColorDrop={(x, y, color) => canvasApi.current?.fillAt(x, y, color)} />
      <DrawCanvas toolInfo={toolInfo} strokeSize={strokeSize} artwork={artwork} canvasApi={canvasApi} activeLayer={activeLayer} readOnly={!edit.writable}
        onInputError={error => { if (error) console.error(getCanvasErrorMessage(error)) }} {...persistence}/>
      <div className="brush-size">
        <input type="range" min="1" max="100" value={strokeSize}
          aria-label={sizeTool === 'eraser' ? '지우개 크기' : '브러시 크기'}
          onChange={event => {
            const size = event.currentTarget.valueAsNumber
            setToolSizes(sizes => ({ ...sizes, [sizeTool]: size }))
          }} />
        <span aria-hidden="true">{strokeSize} px</span>
      </div>
      {persistence.ready && <LayerMenu {...layerState} getLayerPreview={persistence.getLayerPreview} disabled={persistence.locked || !edit.writable} />}
    </>
  )
}

export default function DrawingSpace({ artwork, serverSnapshot }) {
  const edit = useEditSession(artwork.uid, artwork.artworkId, Boolean(serverSnapshot))
  if (edit.status === 'checking') return <p className="no-result" role="status">작품 편집 권한 확인 중…</p>
  return <ArtworkEditor key={edit.canvasEpoch} artwork={artwork} edit={edit} serverSnapshot={serverSnapshot} />
}
