import { useState, useRef, useCallback, useEffect, useImperativeHandle } from 'react'


import { canAllocateCanvas, canvasImageError } from '../../services/canvasImage'

const HISTORY_LIMIT = 20;


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

function DrawCanvas({
  canvasApi, toolInfo, strokeSize, artwork, activeLayer, layers: layerList, ready, locked, readOnly,
  canDraw, getLayerCanvas, compose, onStrokeStart, onStrokeEnd, onRenderError, onInputError, changeLayers
}) {
  const { width: canvasWidth, height: canvasHeight, backgroundColor } = artwork;
  const allocated = canAllocateCanvas(canvasWidth, canvasHeight);
  const activeId = activeLayer?.layerId;
  const getLayer = (id = activeId, allocate = false) => {
    const layer = layerList.find(item => item.layerId === id);
    if (!layer) return null;
    const data = getLayerCanvas(id, allocate)?.getContext('2d');
    if (data?.isContextLost?.()) throw canvasImageError('Layer canvas context lost');
    return { ...layer, data };
  };
  const [scale, setScale] = useState(() => Math.min(window.innerWidth / canvasWidth * 0.8, window.innerHeight / canvasHeight * 0.8, 5));
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const pointer = useRef({ x: 0, y: 0 }).current;

  // ------ 추가-1 ------
  const canvas = useRef(null);
  const activeStroke = useRef(null);
  const selectionDrag = useRef(null);
  const [selection, setSelection] = useState(null);
  const history = useRef({ undo: [], redo: [], revision: 0 });

  const selectedArea = toolInfo.tool === 'select' && selection?.layerId === activeId &&
    activeLayer?.visible ? selection : null;
  const drawLayers = useCallback(() => {
    const drag = selectionDrag.current;
    compose(drag?.preview ? { layerId: drag.layerId, canvas: drag.preview.canvas } : undefined);
  }, [compose]);

  function commitEdit(layerId, pixels) {
    recordEdit(layerId, pixels);
    onStrokeEnd(layerId, true);
  }

  async function classifyLayer(layerId) {
    const revision = history.current.revision;
    const target = canvas.current;
    if (!target) return;
    // Snapshot before loading the model so later canvas edits cannot change the input.
    try {
      const snapshot = new OffscreenCanvas(224, 224);
      const ctx = snapshot.getContext('2d');
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, 224, 224);
      const scale = 224 / Math.max(target.width, target.height);
      const width = target.width * scale;
      const height = target.height * scale;
      ctx.drawImage(target, (224 - width) / 2, (224 - height) / 2, width, height);
      const { predict } = await import('../../model/model');
      const prediction = await predict(snapshot);
      if (revision !== history.current.revision || !canDraw()) return;
      const category = ["명암", "선화", "채색"][prediction];
      if (category) changeLayers(current => {
        if (!current.some(layer => layer.layerId === layerId && layer.category !== category)) return;
        return { layers: current.map(layer => layer.layerId === layerId
          ? { ...layer, name: `(${category})`, category } : layer) };
      });
    } catch (error) {
      console.error('레이어 자동 분류 실패', error);
    }
  }

  function recordEdit(layerId, pixels) {
    const state = history.current;
    state.undo.push({ layerId, pixels, canvas: getLayerCanvas(layerId, false) });
    const limit = Math.max(1, Math.min(HISTORY_LIMIT, Math.floor(64 * 1024 * 1024 / pixels.data.byteLength)));
    if (state.undo.length > limit) state.undo.shift();
    state.redo.length = 0;
  }

  useImperativeHandle(canvasApi, () => ({
    getCanvas: () => canvas.current,
    finishStroke,
    getSelection() {
      if (!selectedArea || selectionDrag.current) return null;
      const { layerId, x, y, width, height } = selectedArea;
      const ctx = getLayer(layerId)?.data;
      return ctx ? { layerId, x, y, pixels: ctx.getImageData(x, y, width, height) } : null;
    },
    fillAt: (clientX, clientY, hex) => guardInput(() => {
      const target = canvas.current;
      if (!canDraw() || !target || activeStroke.current || selectionDrag.current ||
          document.elementFromPoint(clientX, clientY) !== target) return;

      if (!activeLayer?.visible) return;
      const layer = getLayer(activeId, true);
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

      const before = captureLayer(layer.data);
      history.current.revision++;
      setSelection(null);
      layer.data.putImageData(pixels, 0, 0);
      drawLayers();
      commitEdit(layer.layerId, before);
      void classifyLayer(layer.layerId);
    })
  }));

  useEffect(() => {
    const handleHistoryShortcut = event => {
      const isUndoKey = event.code === 'KeyZ' || event.key.toLowerCase() === 'z';
      if (event.defaultPrevented || !event.ctrlKey || event.altKey ||
          event.metaKey || !isUndoKey) return;
      if (event.target instanceof HTMLElement &&
          (event.target.isContentEditable ||
           event.target.matches('textarea, input:is(:not([type]), [type="text"], [type="search"], [type="email"], [type="url"], [type="tel"], [type="password"], [type="number"])'))) return;
      if (!canDraw() || activeStroke.current || selectionDrag.current) return;

      const state = history.current;
      const from = event.shiftKey ? state.redo : state.undo;
      const to = event.shiftKey ? state.undo : state.redo;
      event.preventDefault();

      while (from.length > 0) {
        const entry = from.at(-1);
        const layer = getLayer(entry.layerId);
        if (!layer?.data || layer.data.canvas !== entry.canvas) { from.pop(); continue; }

        const currentPixels = captureLayer(layer.data);
        layer.data.putImageData(entry.pixels, 0, 0);
        from.pop();
        to.push({ ...entry, pixels: currentPixels });
        state.revision++;
        setSelection(null);
        drawLayers();
        onStrokeEnd(entry.layerId, true);
        break;
      }
    };

    const handleKey = event => guardInput(() => handleHistoryShortcut(event));
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  });

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
    if (event.target !== canvas.current || !layer?.visible || !layer.data) {
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
    const layer = getLayer(drag.layerId);
    const valid = canDraw() && event.type === 'pointerup' && toolInfo.tool === 'select' &&
      activeId === drag.layerId && layer?.visible && layer.data === drag.layer;
    const area = valid ? updateSelection(event, drag) : drag.original ?? null;
    selectionDrag.current = null;
    setSelection(area);

    if (valid && drag.original && (area.x !== drag.original.x || area.y !== drag.original.y)) {
      const before = captureLayer(drag.layer);
      history.current.revision++;
      drag.layer.putImageData(captureLayer(drag.preview), 0, 0);
      commitEdit(drag.layerId, before);
    }
    if (drag.preview) drawLayers();
  }

  const updatePointer = event => {
    const rect = canvas.current.getBoundingClientRect();
    pointer.x = (event.clientX - rect.left) * canvasWidth / rect.width;
    pointer.y = (event.clientY - rect.top) * canvasHeight / rect.height;
  };

  const onPointerDown = e => {
    // ------ 추가-2 ------
    if (!canDraw() || !allocated || e.button !== 0 || activeStroke.current ||
        selectionDrag.current || !activeLayer?.visible || e.target !== canvas.current) return;
    const layer = getLayer(activeId, toolInfo.tool === 'pen');
    if (toolInfo.tool === 'select') {
      startSelection(e, layer);
      return;
    }
    if (!layer?.data) return;
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
      pixels, target: e.currentTarget
    };
    onStrokeStart();
    onInputError(null);

    layerCanvas.globalCompositeOperation = toolInfo.tool === 'eraser' ? 'destination-out' : 'source-over';
    layerCanvas.lineWidth = strokeSize;
    layerCanvas.lineCap = 'round';
    layerCanvas.strokeStyle = toolInfo.color;
    layerCanvas.fillStyle = toolInfo.color;

    layerCanvas.beginPath();
    layerCanvas.arc(pointer.x,pointer.y,strokeSize / 2,0,Math.PI*2);
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
    if (!canDraw()) { finishStroke(); return; }

    const { layerCanvas } = stroke;
    layerCanvas.beginPath();
    layerCanvas.moveTo(x,y);
    layerCanvas.lineTo(pointer.x,pointer.y);
    layerCanvas.stroke();
    drawLayers()
    // ---------------------
  }

  function finishStroke() {
    const drag = selectionDrag.current;
    if (drag) {
      selectionDrag.current = null;
      setSelection(drag.original ?? null);
      if (drag.preview) compose();
    }
    const stroke = activeStroke.current;
    if (!stroke) return;
    activeStroke.current = null;
    if (stroke.target.hasPointerCapture(stroke.pointerId)) stroke.target.releasePointerCapture(stroke.pointerId);
    let changed = true;
    try {
      const after = captureLayer(stroke.layerCanvas);
      changed = after.data.some((value, index) => value !== stroke.pixels.data[index]);
    } catch (error) {
      onStrokeEnd(stroke.layerId, true);
      onRenderError(error);
      return;
    }
    if (changed) {
      recordEdit(stroke.layerId, stroke.pixels);
      void classifyLayer(stroke.layerId);
    }
    onStrokeEnd(stroke.layerId, changed);
  }

  const onPointerUp = event => {
    const drag = selectionDrag.current;
    if (drag) {
      if (drag.pointerId === event.pointerId) finishSelection(event, drag);
      return;
    }
    if (activeStroke.current?.pointerId === event.pointerId) finishStroke();
  };

  function guardInput(action) {
    try {
      action();
    } catch (error) {
      finishStroke();
      if (error.code === 'canvas/layer-capacity') onInputError(error);
      else onRenderError(error);
    }
  }

  useEffect(() => {
    const target = canvas.current;
    const onContextLost = () => {
      finishStroke();
      onRenderError(canvasImageError('Drawing canvas context lost'));
    };
    target.addEventListener('contextlost', onContextLost);
    return () => target.removeEventListener('contextlost', onContextLost);
  });

  return (
    <div className="drawarea" onWheel={e => {
      if (!ready || locked) return;
      updatePointer(e);
      const delta = e.deltaY > 0 ? scale/20 : -scale/20;
      let scaleValue = Math.min(Math.max(scale + delta, 0.1), 5);
      setPos({
        x: pos.x + (pointer.x - canvasWidth / 2)*(scale-scaleValue),
        y: pos.y + (pointer.y - canvasHeight / 2)*(scale-scaleValue)
      });
      setScale(scaleValue);
    }}
    onPointerDown={event => guardInput(() => onPointerDown(event))}
    onPointerMove={event => guardInput(() => onPointerMove(event))}
    onPointerUp={event => guardInput(() => onPointerUp(event))}
    onPointerCancel={event => guardInput(() => onPointerUp(event))}
    onLostPointerCapture={event => guardInput(() => onPointerUp(event))}
    >
      <canvas ref={canvas} className="drawcanvas" width={allocated ? canvasWidth : 1} height={allocated ? canvasHeight : 1}
        data-ready={ready && !locked} data-read-only={readOnly} aria-busy={!ready || locked}
        style={{background: backgroundColor, transform: `translate(calc(-50% + ${pos.x}px), calc(-50% + ${pos.y}px))scale(${scale})`}}
      ></canvas>
      {selectedArea && (
        <div
          className="canvas-selection"
          style={{
            left: `calc(50% + ${pos.x + (selectedArea.x - canvasWidth / 2) * scale}px)`,
            top: `calc(50% + ${pos.y + (selectedArea.y - canvasHeight / 2) * scale}px)`,
            width: selectedArea.width * scale,
            height: selectedArea.height * scale
          }}
        />
      )}
    </div>
  );
}

export default DrawCanvas;
