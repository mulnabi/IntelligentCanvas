import { useState } from 'react'

import ToolPicker from '../components/DrawingSpace/ToolPicker'
import DrawCanvas from '../components/DrawingSpace/DrawCanavs'
import LayerMenu from '../components/DrawingSpace/LayerMenu'

import { useLayers } from '../hook/useLayers'
import { dummyLayers } from '../data/dummyData'

import './DrawingSpace.css'

function DrawingSpace() {
  const [toolInfo, setToolInfo] = useState({tool: 'pen', color: '#000000'});
  const [toolSizes, setToolSizes] = useState({ pen: 50, eraser: 20 });
  const sizeTool = toolInfo.tool === 'eraser' ? 'eraser' : 'pen';
  const strokeSize = toolSizes[sizeTool];

  const layerState = useLayers(1080,1080,dummyLayers)
  console.log(layerState);
  
  return (
    <>
      <ToolPicker f={setToolInfo} />
      <DrawCanvas toolInfo={toolInfo} layers={layerState} strokeSize={strokeSize} />
      <div className="brush-size">
        <input
          aria-label={sizeTool === 'eraser' ? '지우개 크기' : '브러시 크기'}
          type="range"
          min="1"
          max="100"
          value={strokeSize}
          onChange={event => {
            const size = event.currentTarget.valueAsNumber;
            setToolSizes(sizes => ({ ...sizes, [sizeTool]: size }));
          }}
        />
        <span aria-hidden="true">{strokeSize} px</span>
      </div>
      <LayerMenu {...layerState} />
    </>
  )
}

export default DrawingSpace
