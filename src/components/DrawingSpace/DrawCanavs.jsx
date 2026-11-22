import { useState, useRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect } from 'react'


import { predict } from '../../model/model'

const HISTORY_LIMIT = 20;
const CANVAS_SIZE = 800;

function captureLayer(ctx) {
  return ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
}

function fillConnectedPixels(composite, destination, x, y, color) {
  const { data, width, height } = composite;
  const pixels = destination.data;
  const start = y * width + x;
  const offset = start * 4;
  const [red, green, blue, alpha] = data.subarray(offset, offset + 4);

  const queue = new Uint32Array(width * height);
  const visited = new Uint8Array(width * height);
  let tail = 0;
  let changed = false;

  function visit(pixel) {
    if (visited[pixel]) return;
    visited[pixel] = 1;
    const index = pixel * 4;
    if (data[index + 3] !== alpha ||
        (alpha !== 0 && (data[index] !== red || data[index + 1] !== green || data[index + 2] !== blue))) return;
    if (pixels[index] !== color[0] || pixels[index + 1] !== color[1] ||
        pixels[index + 2] !== color[2] || pixels[index + 3] !== color[3]) {
      pixels.set(color, index);
      changed = true;
    }
    queue[tail++] = pixel;
  }

  visit(start);
  for (let head = 0; head < tail; head++) {
    const pixel = queue[head];
    const column = pixel % width;
    if (column > 0) visit(pixel - 1);
    if (column < width - 1) visit(pixel + 1);
    if (pixel >= width) visit(pixel - width);
    if (pixel < width * (height - 1)) visit(pixel + width);
  }
  return changed;
}

function DrawCanvas({ ref, toolInfo, layers, strokeSize }) {
  const [scale, setScale] = useState(Math.min(window.innerWidth / 800*0.8, window.innerHeight / 800*0.8));
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const pointer = useRef({ x: 0, y: 0 }).current;

  // ------ 추가-1 ------
  const canvas = useRef(null);
  const activeStroke = useRef(null);
  const selectionDrag = useRef(null);
  const [selection, setSelection] = useState(null);
  const history = useRef({ undo: [], redo: [], revision: 0 });

  const layerList = layers.layers;
  const { updateLayer } = layers;
  const selectedArea = toolInfo.tool === 'select' && selection?.layerId === layers.activeId &&
    layers.getLayer()?.visible ? selection : null;
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
      const drag = selectionDrag.current;
      const source = drag?.layer === currentLayer.data && drag.preview
        ? drag.preview.canvas : currentLayer.data.canvas;
      ctx.drawImage(source, 0, 0);
    }
    ctx.restore();
  }, [layerList]);

  useLayoutEffect(() => {
    drawLayers();
  }, [drawLayers]);

  function recordEdit(layerId, pixels) {
    const state = history.current;
    state.undo.push({ layerId, pixels });
    if (state.undo.length > HISTORY_LIMIT) state.undo.shift();
    state.redo.length = 0;
  }

  useImperativeHandle(ref, () => ({
    getSelection() {
      if (!selectedArea || selectionDrag.current) return null;
      const { layerId, x, y, width, height } = selectedArea;
      return { layerId, x, y, pixels: layers.getLayer(layerId).data.getImageData(x, y, width, height) };
    },
    fillAt(clientX, clientY, hex) {
      const target = canvas.current;
      if (!target || activeStroke.current || selectionDrag.current ||
          document.elementFromPoint(clientX, clientY) !== target) return;

      const layer = layers.getLayer();
      if (!layer?.visible) return;
      const rect = target.getBoundingClientRect();
      const x = Math.floor((clientX - rect.left) * target.width / rect.width);
      const y = Math.floor((clientY - rect.top) * target.height / rect.height);
      const width = Math.min(target.width, layer.data.canvas.width);
      const height = Math.min(target.height, layer.data.canvas.height);
      if (x < 0 || y < 0 || x >= width || y >= height) return;

      const composite = target.getContext('2d').getImageData(0, 0, width, height);
      const pixels = layer.data.getImageData(0, 0, width, height);
      const rgb = Number.parseInt(hex.slice(1), 16);
      const color = [rgb >> 16, (rgb >> 8) & 255, rgb & 255, 255];
      if (!fillConnectedPixels(composite, pixels, x, y, color)) return;

      recordEdit(layer.layerId, captureLayer(layer.data));
      history.current.revision++;
      setSelection(null);
      layer.data.putImageData(pixels, 0, 0);
      drawLayers();
      updateLayer(layer.layerId);
    }
  }));

  useEffect(() => {
    const handleHistoryShortcut = event => {
      const isUndoKey = event.code === 'KeyZ' || event.key.toLowerCase() === 'z';
      if (event.defaultPrevented || !event.ctrlKey || event.altKey ||
          event.metaKey || !isUndoKey) return;
      if (event.target instanceof HTMLElement &&
          (event.target.isContentEditable ||
           event.target.matches('textarea, input:is(:not([type]), [type="text"], [type="search"], [type="email"], [type="url"], [type="tel"], [type="password"], [type="number"])'))) return;
      if (activeStroke.current || selectionDrag.current) return;

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
        setSelection(null);
        drawLayers();
        updateLayer(entry.layerId);
        break;
      }
    };

    window.addEventListener('keydown', handleHistoryShortcut);
    return () => window.removeEventListener('keydown', handleHistoryShortcut);
  }, [drawLayers, layerList, updateLayer]);

  function selectionPoint(event, layer) {
    const target = canvas.current;
    const rect = target.getBoundingClientRect();
    const width = Math.min(target.width, layer.canvas.width);
    const height = Math.min(target.height, layer.canvas.height);
    return {
      x: Math.max(0, Math.min(width, Math.round((event.clientX - rect.left) * target.width / rect.width))),
      y: Math.max(0, Math.min(height, Math.round((event.clientY - rect.top) * target.height / rect.height))),
      width,
      height
    };
  }

  function startSelection(event, layer) {
    if (event.target !== canvas.current || !layer?.visible) {
      setSelection(null);
      return;
    }

    const start = selectionPoint(event, layer.data);
    const drag = { pointerId: event.pointerId, layerId: layer.layerId, layer: layer.data, start };
    if (selectedArea && start.x >= selectedArea.x && start.x < selectedArea.x + selectedArea.width &&
        start.y >= selectedArea.y && start.y < selectedArea.y + selectedArea.height) {
      const { x, y, width, height } = selectedArea;
      const cutout = new OffscreenCanvas(width, height);
      cutout.getContext('2d').drawImage(layer.data.canvas, x, y, width, height, 0, 0, width, height);
      drag.original = selectedArea;
      drag.cutout = cutout;
      drag.preview = new OffscreenCanvas(layer.data.canvas.width, layer.data.canvas.height).getContext('2d');
      drag.preview.drawImage(layer.data.canvas, 0, 0);
    } else {
      setSelection(null);
    }

    selectionDrag.current = drag;
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function updateSelection(event, drag) {
    const { start, original, preview } = drag;
    const point = selectionPoint(event, drag.layer);
    if (!original) {
      const width = Math.abs(point.x - start.x);
      const height = Math.abs(point.y - start.y);
      const area = width && height ? {
        layerId: drag.layerId, x: Math.min(start.x, point.x), y: Math.min(start.y, point.y), width, height
      } : null;
      setSelection(area);
      return area;
    }

    const x = Math.max(0, Math.min(point.width - original.width, original.x + point.x - start.x));
    const y = Math.max(0, Math.min(point.height - original.height, original.y + point.y - start.y));
    preview.clearRect(0, 0, preview.canvas.width, preview.canvas.height);
    preview.drawImage(drag.layer.canvas, 0, 0);
    if (x !== original.x || y !== original.y) {
      preview.clearRect(original.x, original.y, original.width, original.height);
      preview.drawImage(drag.cutout, x, y);
    }
    const area = { ...original, x, y };
    setSelection(area);
    drawLayers();
    return area;
  }

  function finishSelection(event, drag) {
    const layer = layers.getLayer(drag.layerId);
    const valid = event.type === 'pointerup' && toolInfo.tool === 'select' &&
      layers.activeId === drag.layerId && layer?.visible && layer.data === drag.layer;
    const area = valid ? updateSelection(event, drag) : drag.original ?? null;
    selectionDrag.current = null;
    setSelection(area);

    if (valid && drag.original && (area.x !== drag.original.x || area.y !== drag.original.y)) {
      recordEdit(drag.layerId, captureLayer(drag.layer));
      history.current.revision++;
      drag.layer.putImageData(captureLayer(drag.preview), 0, 0);
      updateLayer(drag.layerId);
    }
    if (drag.preview) drawLayers();
  }

  const updatePointer = e => {
    pointer.x=(e.clientX-window.innerWidth/2-pos.x)/scale;
    pointer.y=(e.clientY-window.innerHeight/2-pos.y)/scale;
  }
  // ---------------------

  const onPointerDown = e => {
    // ------ 추가-2 ------
    if(e.button !== 0 || activeStroke.current || selectionDrag.current) return;
    const layer = layers.getLayer();
    if (toolInfo.tool === 'select') {
      startSelection(e, layer);
      return;
    }
    setSelection(null);
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
    const drag = selectionDrag.current;
    if (drag) {
      if (drag.pointerId === e.pointerId) updateSelection(e, drag);
      return;
    }
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
    const drag = selectionDrag.current;
    if (drag) {
      if (drag.pointerId === e.pointerId) finishSelection(e, drag);
      return;
    }
    const stroke = activeStroke.current;
    if (!stroke || stroke.pointerId !== e.pointerId) return;
    activeStroke.current = null;

    const layer = layers.getLayer(stroke.layerId);
    if (!layer) return;

    const state = history.current;
    recordEdit(stroke.layerId, stroke.pixels);
    updateLayer(stroke.layerId);
    const revision = state.revision;

    let data=await predict(canvas.current)
    if (revision !== state.revision) return;
    const category = ["명암", "선화", "채색"][data];
    if (category) updateLayer(stroke.layerId, { name: `(${category})`, category });
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
      <canvas ref={canvas} className="drawcanvas" width={CANVAS_SIZE} height={CANVAS_SIZE}
        style={{transform: `translate(calc(-50% + ${pos.x}px), calc(-50% + ${pos.y}px))scale(${scale})`}}
      ></canvas>
      {selectedArea && (
        <div
          className="canvas-selection"
          style={{
            left: `calc(50% + ${pos.x + (selectedArea.x - CANVAS_SIZE / 2) * scale}px)`,
            top: `calc(50% + ${pos.y + (selectedArea.y - CANVAS_SIZE / 2) * scale}px)`,
            width: selectedArea.width * scale,
            height: selectedArea.height * scale
          }}
        />
      )}
    </div>
  );
}

export default DrawCanvas;
