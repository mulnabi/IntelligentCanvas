import { useState, useRef, useEffect } from 'react'

import ToolPicker from '../components/DrawingSpace/ToolPicker'
import DrawCanvas from '../components/DrawingSpace/DrawCanavs'
import LayerMenu from '../components/DrawingSpace/LayerMenu'
import Range from '../components/Range'

import { useLayers } from '../hook/useLayers'
import { dummyLayers } from '../data/dummyData'


import './DrawingSpace.css'

function DrawingSpace() {
  // const canvasRef = useRef(null);
  const [toolInfo, setToolInfo] = useState({tool: 'pen', color: '#000000'});

  const layerState = useLayers(dummyLayers)
  return (
    <>
      <ToolPicker f={setToolInfo} />
      <DrawCanvas toolInfo={toolInfo}/>
      <LayerMenu {...layerState} />
    </>
  )
}

export default DrawingSpace