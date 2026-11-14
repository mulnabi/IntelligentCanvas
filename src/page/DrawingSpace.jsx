import { useState, useRef, useEffect } from 'react'

import ToolPicker from '../components/DrawingSpace/ToolPicker'
import DrawCanvas from '../components/DrawingSpace/DrawCanavs'
import LayerMenu from '../components/DrawingSpace/LayerMenu'
import { useLayers } from '../hook/useLayers'
import { dummyLayers } from '../data/dummyData'

import './DrawingSpace.css'

function DrawingSpace() {
  // const canvasRef = useRef(null);
  const layerState = useLayers(dummyLayers)

  return (
    <>
      <ToolPicker f={tool => console.log('선택된 도구', tool)} />
      <DrawCanvas/>
      <LayerMenu {...layerState} />
    </>
  )
}

export default DrawingSpace
