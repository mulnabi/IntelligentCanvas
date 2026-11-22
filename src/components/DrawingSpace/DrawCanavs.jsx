import { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react'


import { predict } from '../../model/model'

const HISTORY_LIMIT = 20;

function captureLayer(ctx) {
  return ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
}

function DrawCanvas({ toolInfo, layers, strokeSize }) {
  const [scale, setScale] = useState(Math.min(window.innerWidth / 800*0.8, window.innerHeight / 800*0.8));
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const pointer = useRef({ x: 0, y: 0 }).current;

  // ------ 추가-1 ------
  const canvas = useRef(null);
  const activeStroke = useRef(null);
  const history = useRef({ undo: [], redo: [], revision: 0 });

  const layerList = layers.layers;
  const drawLayers = useCallback(() => {
    const target = canvas.current;
    if (!target) return;

    const ctx = target.getContext('2d');
    ctx.clearRect(0, 0, target.width, target.height);
    ctx.save();
    // 목록 위쪽의 레이어가 앞에 보이도록 아래에서부터 합성한다.
    for (let i = layerList.length - 1; i >= 0; i--) {
      const currentLayer = layerList[i];
      if (!currentLayer.visible) continue;
      ctx.globalAlpha = currentLayer.opacity;
      ctx.drawImage(currentLayer.data.canvas, 0, 0);
    }
    ctx.restore();
  }, [layerList]);

  useLayoutEffect(() => {
    drawLayers();
  }, [drawLayers]);

  useEffect(() => {
    const handleHistoryShortcut = event => {
      if (event.defaultPrevented || !event.ctrlKey || event.altKey ||
          event.metaKey || event.key.toLowerCase() !== 'z') return;
      if (event.target instanceof HTMLElement &&
          (event.target.isContentEditable ||
           event.target.matches('textarea, input:not([type="range"]):not([type="radio"]):not([type="checkbox"])'))) return;
      if (activeStroke.current) return;

      const state = history.current;
      const from = event.shiftKey ? state.redo : state.undo;
      const to = event.shiftKey ? state.undo : state.redo;
      event.preventDefault();

      while (from.length > 0) {
        const entry = from.pop();
        const layer = layerList.find(layer => layer.layerId === entry.layerId);
        if (!layer) continue;

        const currentPixels = captureLayer(layer.data);
        layer.data.putImageData(entry.pixels, 0, 0);
        to.push({ layerId: entry.layerId, pixels: currentPixels });
        state.revision++;
        drawLayers();
        break;
      }
    };

    window.addEventListener('keydown', handleHistoryShortcut);
    return () => window.removeEventListener('keydown', handleHistoryShortcut);
  }, [drawLayers, layerList]);

  const updatePointer = e => {
    pointer.x=(e.clientX-window.innerWidth/2-pos.x)/scale;
    pointer.y=(e.clientY-window.innerHeight/2-pos.y)/scale;
  }
  // ---------------------

  const onPointerDown = e => {
    // ------ 추가-2 ------
    if(e.button !== 0 || activeStroke.current) return;
    const layer = layers.getLayer();
    const layerCanvas = layer.data;
    const pixels = captureLayer(layerCanvas);
    e.currentTarget.setPointerCapture(e.pointerId);
    updatePointer(e);
    history.current.revision++;
    activeStroke.current = {
      pointerId: e.pointerId,
      layerId: layer.layerId,
      layerCanvas,
      pixels
    };

    layerCanvas.globalCompositeOperation = toolInfo.tool === 'eraser' ? 'destination-out' : 'source-over';
    layerCanvas.lineWidth = strokeSize;
    layerCanvas.lineCap = 'round';
    layerCanvas.strokeStyle = toolInfo.color;
    layerCanvas.fillStyle = toolInfo.color;

    layerCanvas.beginPath();
    layerCanvas.arc(pointer.x+400,pointer.y+400,strokeSize / 2,0,Math.PI*2);
    layerCanvas.fill();
    drawLayers()
    // ---------------------
  }

  const onPointerMove = e => {
    // ------ 추가-3 ------
    const stroke = activeStroke.current;
    if (stroke && stroke.pointerId !== e.pointerId) return;
    const x = pointer.x;
    const y = pointer.y;
    updatePointer(e);

    if (!stroke) return;

    const { layerCanvas } = stroke;
    layerCanvas.beginPath();
    layerCanvas.moveTo(x+400,y+400);
    layerCanvas.lineTo(pointer.x+400,pointer.y+400);
    layerCanvas.stroke();
    drawLayers()
    // ---------------------
  }

  const onPointerUp = async e => {
    const stroke = activeStroke.current;
    if (!stroke || stroke.pointerId !== e.pointerId) return;
    activeStroke.current = null;

    const layer = layers.getLayer(stroke.layerId);
    if (!layer) return;

    const state = history.current;
    state.undo.push({ layerId: stroke.layerId, pixels: stroke.pixels });
    if (state.undo.length > HISTORY_LIMIT) state.undo.shift();
    state.redo.length = 0;
    const revision = state.revision;

    let data=await predict(canvas.current)
    if (revision !== state.revision) return;
    const classify=["명암","선화","채색"]
    layer.name=`(${classify[data]})`
    layer.category=classify[data]
    layers.setUpdate(true);
  }

  return (
    <div className="drawarea" onWheel={e => {
      const delta = e.deltaY > 0 ? scale/20 : -scale/20;
      let scaleValue = Math.min(Math.max(scale + delta, 0.1), 5);
      console.log(pointer.x)
      setPos({
        x: pos.x + pointer.x*(scale-scaleValue),
        y: pos.y + pointer.y*(scale-scaleValue)
      });
      setScale(scaleValue);
    }}
    onPointerDown={onPointerDown}
    onPointerMove={onPointerMove}
    onPointerUp={onPointerUp}
    onPointerCancel={onPointerUp}
    onLostPointerCapture={onPointerUp}
    >
      <canvas ref={canvas} className="drawcanvas" width="800" height="800"
        style={{transform: `translate(calc(-50% + ${pos.x}px), calc(-50% + ${pos.y}px))scale(${scale})`}}
      ></canvas>
    </div>
  );
}

export default DrawCanvas;
