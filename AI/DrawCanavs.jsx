import { useState, useRef, useCallback, useEffect, useImperativeHandle } from 'react'


import { canAllocateCanvas, canvasImageError } from '../../services/canvasImage'
import { createLayer } from '../../repositories/layerRepository'
import { classifyImage } from '../../model/classificationClient'
import { findInkBounds } from '../../model/inkBounds'

const HISTORY_LIMIT = 20;
const SELECTION_TOOLS = ['도형', '글자', '대칭'];
const CLASSIFICATION_IDLE_MS = 450;

function queueStrokeClassification(queue, job) {
  clearTimeout(queue.timer);
  queue.pending = job;
  queue.timer = setTimeout(() => {
    queue.timer = null;
    runPendingClassification(queue);
  }, CLASSIFICATION_IDLE_MS);
}

async function runPendingClassification(queue) {
  if (queue.timer !== null || queue.running || !queue.pending) return;
  const job = queue.pending;
  queue.pending = null;
  queue.running = true;
  try {
    await job();
  } finally {
    queue.running = false;
    void runPendingClassification(queue);
  }
}

function cancelPendingClassification(queue) {
  clearTimeout(queue.timer);
  queue.timer = null;
  queue.pending = null;
}


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
  canvasApi, toolInfo, strokeSize, penOpacity = 1, artwork, activeLayer, layers: layerList, ready, locked, readOnly,
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
  const [toolSuggestion, setToolSuggestion] = useState(null);
  const selectionRequest = useRef(0);
  const classificationQueue = useRef({ timer: null, pending: null, running: false });
  const history = useRef({ undo: [], redo: [], revision: 0 });
  const selectionBatch = useRef(null);
  const [splitPrompt, setSplitPrompt] = useState(null);

  const selectedArea = toolInfo.tool === 'select' && selection?.layerId === activeId &&
    activeLayer?.visible ? selection : null;
  const suggestedTool = toolSuggestion?.area === selectedArea ? toolSuggestion : null;
  const drawLayers = useCallback(() => {
    const drag = selectionDrag.current;
    compose(drag?.preview ? { layerId: drag.layerId, canvas: drag.preview.canvas } : undefined);
  }, [compose]);

  function commitEdit(layerId, pixels) {
    recordEdit(layerId, pixels);
    onStrokeEnd(layerId, true);
  }

  function createClassificationInput() {
    const snapshot = new OffscreenCanvas(224, 224);
    const ctx = snapshot.getContext('2d');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, 224, 224);
    return ctx;
  }

  async function predictCategory(snapshot) {
    const prediction = await classifyImage(snapshot, 'layer');
    return ["명암", "선화", "채색"][prediction];
  }

  function prepareLayerInput(source) {
    const ctx = createClassificationInput();
    const scale = 224 / Math.max(source.width, source.height);
    const width = source.width * scale;
    const height = source.height * scale;
    ctx.drawImage(source, (224 - width) / 2, (224 - height) / 2, width, height);
    return ctx.canvas;
  }

  function setLayerCategory(layerId, category) {
    changeLayers(current => {
      const layer = current.find(item => item.layerId === layerId);
      if (!layer || layer.category === category) return;
      const hasGeneratedName = layer.category ? layer.name === `(${layer.category})`
        : /^레이어 \d+$/.test(layer.name) || layer.name === '기존 그림';
      const name = hasGeneratedName ? `(${category})` : layer.name;
      return { layers: current.map(item => item === layer ? { ...item, name, category } : item) };
    });
  }

  async function classifyLayer(layerId) {
    const revision = history.current.revision;
    try {
      const source = getLayerCanvas(layerId, false);
      if (!source?.width || !source.height) return;
      const category = await predictCategory(prepareLayerInput(source));
      if (revision !== history.current.revision || !canDraw()) return;
      if (category) setLayerCategory(layerId, category);
    } catch (error) {
      console.error('레이어 자동 분류 실패', error);
    }
  }

  function clearSelectionBatch() {
    selectionBatch.current = null;
    setSplitPrompt(null);
  }

  function keepStrokesOnLayer() {
    if (!splitPrompt || splitPrompt.layerId !== activeId || !canDraw() ||
        activeStroke.current || selectionDrag.current) return;
    setLayerCategory(activeId, splitPrompt.category);
    clearSelectionBatch();
  }

  function trackLayerSelection(id) {
    if (activeStroke.current || selectionDrag.current) finishStroke();
    cancelPendingClassification(classificationQueue.current);
    const category = layerList.find(layer => layer.layerId === id)?.category;
    selectionBatch.current = category ? { layerId: id, category, revision: 0 } : null;
    history.current.revision++;
    setSplitPrompt(null);
    selectionRequest.current++;
    setToolSuggestion(null);
  }

  async function suggestSelectionTool(area, source) {
    const request = ++selectionRequest.current;
    try {
      const scale = Math.min(224 / area.width, 224 / area.height);
      const preview = new OffscreenCanvas(
        Math.max(1, Math.round(area.width * scale)),
        Math.max(1, Math.round(area.height * scale))
      );
      const ctx = preview.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(source, area.x, area.y, area.width, area.height, 0, 0, preview.width, preview.height);
      const { data } = ctx.getImageData(0, 0, preview.width, preview.height);
      if (!data.some((value, index) => index % 4 === 3 && value > 0)) return;

      const toolId = await classifyImage(preview, 'tool');
      if (request === selectionRequest.current && SELECTION_TOOLS[toolId]) {
        setToolSuggestion({ area, toolId, confirmed: false });
      }
    } catch (error) {
      console.error('선택 영역 도구 분류 실패', error);
    }
  }

  async function readSelectedWord(suggestion) {
    const area = suggestion.area;
    const source = getLayerCanvas(area.layerId, false);
    if (!canDraw() || source == null || area !== selectedArea || selectionDrag.current) return;
    const request = ++selectionRequest.current;
    const revision = history.current.revision;
    setToolSuggestion({ ...suggestion, confirmed: true, phase: 'reading' });
    try {
      const crop = new OffscreenCanvas(area.width, area.height);
      crop.getContext('2d').drawImage(source, area.x, area.y, area.width, area.height,
        0, 0, area.width, area.height);
      const bounds = findInkBounds(crop.getContext('2d').getImageData(0, 0, area.width, area.height));
      const text = await classifyImage(crop, 'ocr');
      if (selectionRequest.current !== request || history.current.revision !== revision) return;
      setToolSuggestion({ ...suggestion, confirmed: true, phase: 'review', text, source, revision, bounds });
    } catch (error) {
      console.error('글자 인식 실패', error);
      if (selectionRequest.current === request) {
        setToolSuggestion({ ...suggestion, confirmed: true, phase: 'error' });
      }
    }
  }

  function applySelectedWord(suggestion) {
    const { area, source, revision } = suggestion;
    const text = suggestion.text.trim();
    if (!text || area !== selectedArea || !canDraw() || selectionDrag.current || activeStroke.current ||
        revision !== history.current.revision || source !== getLayerCanvas(area.layerId, false)) return;
    const ctx = source.getContext('2d');
    const before = captureLayer(ctx);
    const { x, y, width, height } = area;
    const bounds = suggestion.bounds || { x: 0, y: 0, width, height };
    const family = 'sans-serif';
    ctx.save();
    try {
      ctx.beginPath();
      ctx.rect(x, y, width, height);
      ctx.clip();
      ctx.clearRect(x, y, width, height);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.fillStyle = toolInfo.color;
      // 실제 글리프 크기로 맞춰 작은 글씨와 큰 글씨의 크기를 유지한다.
      // fillText의 maxWidth 압축 대신 글꼴 크기를 줄여 글자 비율을 지킨다.
      ctx.textBaseline = 'alphabetic';
      ctx.font = `100px ${family}`;
      const measured = ctx.measureText(text);
      const inkWidth = measured.actualBoundingBoxLeft + measured.actualBoundingBoxRight;
      const inkHeight = measured.actualBoundingBoxAscent + measured.actualBoundingBoxDescent;
      const size = Math.max(1, 100 * Math.min(
        bounds.width / Math.max(1, inkWidth),
        bounds.height / Math.max(1, inkHeight)
      ));
      ctx.font = `${size}px ${family}`;
      ctx.textBaseline = 'alphabetic';
      const fitted = ctx.measureText(text);
      const fittedWidth = fitted.actualBoundingBoxLeft + fitted.actualBoundingBoxRight;
      const fittedHeight = fitted.actualBoundingBoxAscent + fitted.actualBoundingBoxDescent;
      ctx.fillText(text,
        x + bounds.x + (bounds.width - fittedWidth) / 2 + fitted.actualBoundingBoxLeft,
        y + bounds.y + (bounds.height - fittedHeight) / 2 + fitted.actualBoundingBoxAscent);
    } catch (error) {
      ctx.putImageData(before, 0, 0);
      throw error;
    } finally {
      ctx.restore();
    }
    clearSelectionBatch();
    history.current.revision++;
    setToolSuggestion(null);
    setSelection(null);
    commitEdit(area.layerId, before);
    drawLayers();
  }

  function prepareStrokeInput({ points, width, color, opacity }) {
    const radius = width / 2;
    let left = canvasWidth, top = canvasHeight, right = 0, bottom = 0;
    for (const { x, y } of points) {
      left = Math.min(left, x - radius);
      top = Math.min(top, y - radius);
      right = Math.max(right, x + radius);
      bottom = Math.max(bottom, y + radius);
    }
    left = Math.max(0, left);
    top = Math.max(0, top);
    right = Math.min(canvasWidth, right);
    bottom = Math.min(canvasHeight, bottom);
    if (left >= right || top >= bottom) return null;

    const ctx = createClassificationInput();
    const scale = 192 / Math.max(right - left, bottom - top);
    ctx.translate(112 - (left + right) * scale / 2, 112 - (top + bottom) * scale / 2);
    ctx.scale(scale, scale);
    ctx.beginPath();
    ctx.rect(0, 0, canvasWidth, canvasHeight);
    ctx.clip();
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.globalAlpha = opacity;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const [first, ...rest] = points;
    ctx.beginPath();
    ctx.arc(first.x, first.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);
    for (const point of rest) ctx.lineTo(point.x, point.y);
    ctx.stroke();
    return ctx.canvas;
  }

  async function classifyBatch(batch, stroke) {
    const revision = ++batch.revision;
    try {
      const input = prepareStrokeInput(stroke);
      if (!input) return;
      const category = await predictCategory(input);
      if (selectionBatch.current === batch && revision > (batch.mismatchRevision ?? 0) &&
          category && category !== batch.category) {
        batch.mismatchRevision = revision;
        setSplitPrompt({ layerId: batch.layerId, category });
      }
    } catch (error) {
      console.error('레이어 자동 분류 실패', error);
    }
  }

  function splitRecentStrokes() {
    const batch = selectionBatch.current;
    if (!batch || !splitPrompt || batch.layerId !== activeId || !canDraw() ||
        activeStroke.current || selectionDrag.current) return;

    const temp = { ...createLayer(`임시 레이어 (${splitPrompt.category})`), category: splitPrompt.category, isTemporary: true };
    changeLayers((current, selectedId) => {
      const index = current.findIndex(layer => layer.layerId === batch.layerId && layer.visible);
      if (index < 0 || selectedId !== batch.layerId) return;
      const source = getLayerCanvas(batch.layerId, false)?.getContext('2d');
      if (source?.canvas !== batch.source) return;
      const destination = getLayerCanvas(temp.layerId, true)?.getContext('2d');
      if (!destination) return;
      const before = captureLayer(source);
      const emptyTemp = captureLayer(destination);
      destination.drawImage(batch.overlay.canvas, 0, 0);
      source.putImageData(batch.baseline, 0, 0);
      const next = [...current];
      next.splice(index, 0, { ...temp, opacity: current[index].opacity });
      recordEdit(batch.layerId, before, [{ layerId: temp.layerId, canvas: destination.canvas, pixels: emptyTemp }]);
      history.current.revision++;
      clearSelectionBatch();
      return { layers: next, activeId: temp.layerId, changedPixelIds: [batch.layerId, temp.layerId] };
    });
  }

  function recordEdit(layerId, pixels, additional = []) {
    const state = history.current;
    state.undo.push({ layerId, pixels, canvas: getLayerCanvas(layerId, false), additional });
    const maxSnapshots = Math.max(1, Math.floor(64 * 1024 * 1024 / pixels.data.byteLength));
    let snapshots = 0;
    for (let i = state.undo.length - 1; i >= 0; i--) {
      snapshots += 1 + state.undo[i].additional.length;
      if (i < state.undo.length - 1 && (snapshots > maxSnapshots || state.undo.length - i > HISTORY_LIMIT)) {
        state.undo.splice(0, i + 1);
        break;
      }
    }
    state.redo.length = 0;
  }

  useImperativeHandle(canvasApi, () => ({
    getCanvas: () => canvas.current,
    finishStroke,
    trackLayerSelection,
    getSelection() {
      if (!selectedArea || selectionDrag.current) return null;
      const { layerId, x, y, width, height } = selectedArea;
      const ctx = getLayer(layerId)?.data;
      if (!ctx) return null;
      const pixels = ctx.getImageData(x, y, width, height);
      return suggestedTool?.confirmed
        ? { layerId, x, y, pixels, toolId: suggestedTool.toolId }
        : { layerId, x, y, pixels };
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

      clearSelectionBatch();
      const before = captureLayer(layer.data);
      history.current.revision++;
      setSelection(null);
      layer.data.putImageData(pixels, 0, 0);
      drawLayers();
      commitEdit(layer.layerId, before);
      scheduleLayerClassification(layer.layerId);
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
        const additional = entry.additional.flatMap(part => {
          const ctx = getLayer(part.layerId)?.data;
          return ctx?.canvas === part.canvas ? [{ part, ctx, pixels: captureLayer(ctx) }] : [];
        });
        layer.data.putImageData(entry.pixels, 0, 0);
        for (const { part, ctx } of additional) ctx.putImageData(part.pixels, 0, 0);
        from.pop();
        to.push({ ...entry, pixels: currentPixels, additional: additional.map(({ part, pixels }) => ({ ...part, pixels })) });
        state.revision++;
        clearSelectionBatch();
        setSelection(null);
        drawLayers();
        onStrokeEnd(entry.layerId, true);
        for (const { part } of additional) onStrokeEnd(part.layerId, true);
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
      x: Math.round((event.clientX - rect.left) * target.width / rect.width),
      y: Math.round((event.clientY - rect.top) * target.height / rect.height),
      width,
      height
    };
  }

  function startSelection(event, layer) {
    selectionRequest.current++;
    setToolSuggestion(null);
    if (event.target !== canvas.current || !layer?.visible || !layer.data) {
      setSelection(null);
      return;
    }

    const point = selectionPoint(event, layer.data);
    const start = {
      x: Math.max(0, Math.min(point.width, point.x)),
      y: Math.max(0, Math.min(point.height, point.y))
    };
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
      const x = Math.max(0, Math.min(point.width, point.x));
      const y = Math.max(0, Math.min(point.height, point.y));
      const width = Math.abs(x - start.x);
      const height = Math.abs(y - start.y);
      const area = width && height ? {
        layerId: drag.layerId, x: Math.min(start.x, x), y: Math.min(start.y, y), width, height
      } : null;
      setSelection(area);
      return area;
    }

    const x = original.x + point.x - start.x;
    const y = original.y + point.y - start.y;
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
    if (valid && drag.original && (area.x !== drag.original.x || area.y !== drag.original.y)) {
      clearSelectionBatch();
      const before = captureLayer(drag.layer);
      history.current.revision++;
      drag.layer.putImageData(captureLayer(drag.preview), 0, 0);
      commitEdit(drag.layerId, before);
      const x = Math.max(0, area.x);
      const y = Math.max(0, area.y);
      const width = Math.min(canvas.current.width, drag.layer.canvas.width, area.x + area.width) - x;
      const height = Math.min(canvas.current.height, drag.layer.canvas.height, area.y + area.height) - y;
      setSelection(width > 0 && height > 0 ? { ...area, x, y, width, height } : null);
    } else {
      setSelection(area);
      if (valid && area && !drag.original) void suggestSelectionTool(area, drag.layer.canvas);
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
    const opacity = toolInfo.tool === 'pen' ? penOpacity : 1;
    if (!layer?.data || opacity === 0) return;
    cancelPendingClassification(classificationQueue.current);
    setSelection(null);
    const layerCanvas = layer.data;
    const pixels = captureLayer(layerCanvas);
    let batch = selectionBatch.current;
    if (batch && (batch.layerId !== layer.layerId || toolInfo.tool !== 'pen')) {
      clearSelectionBatch();
      batch = null;
    }
    if (!batch && toolInfo.tool === 'pen' && layer.category) {
      batch = { layerId: layer.layerId, category: layer.category, revision: 0 };
      selectionBatch.current = batch;
    }
    if (batch) {
      if (!batch.overlay) {
        batch.overlay = new OffscreenCanvas(layerCanvas.canvas.width, layerCanvas.canvas.height).getContext('2d');
        batch.baseline = pixels;
        batch.source = layerCanvas.canvas;
      }
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    updatePointer(e);
    history.current.revision++;
    activeStroke.current = {
      pointerId: e.pointerId,
      layerId: layer.layerId,
      layerCanvas,
      pixels, batch, target: e.currentTarget,
      classificationStroke: batch ? { points: [{ x: pointer.x, y: pointer.y }], width: strokeSize, color: toolInfo.color, opacity } : null,
      contexts: batch ? [layerCanvas, batch.overlay] : [layerCanvas]
    };
    onStrokeStart();
    onInputError(null);

    for (const ctx of activeStroke.current.contexts) {
      ctx.globalCompositeOperation = toolInfo.tool === 'eraser' ? 'destination-out' : 'source-over';
      ctx.globalAlpha = opacity;
      ctx.lineWidth = strokeSize;
      ctx.lineCap = 'round';
      ctx.strokeStyle = toolInfo.color;
      ctx.fillStyle = toolInfo.color;
      ctx.beginPath();
      ctx.arc(pointer.x, pointer.y, strokeSize / 2, 0, Math.PI * 2);
      ctx.fill();
    }
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

    stroke.classificationStroke?.points.push({ x: pointer.x, y: pointer.y });
    for (const ctx of stroke.contexts) {
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(pointer.x, pointer.y);
      ctx.stroke();
    }
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
    for (const ctx of stroke.contexts) ctx.globalAlpha = 1;
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
    }
    onStrokeEnd(stroke.layerId, changed);
    if (stroke.batch && selectionBatch.current === stroke.batch) {
      queueStrokeClassification(classificationQueue.current, () => {
        if (!activeStroke.current && selectionBatch.current === stroke.batch && canDraw()) {
          return classifyBatch(stroke.batch, stroke.classificationStroke);
        }
      });
    } else if (changed) {
      scheduleLayerClassification(stroke.layerId);
    }
  }

  function scheduleLayerClassification(layerId) {
    const revision = history.current.revision;
    queueStrokeClassification(classificationQueue.current, () => {
      if (!activeStroke.current && revision === history.current.revision && canDraw()) {
        return classifyLayer(layerId);
      }
    });
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
    const queue = classificationQueue.current;
    const editHistory = history.current;
    return () => {
      cancelPendingClassification(queue);
      editHistory.revision++;
    };
  }, []);

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
      {suggestedTool && !suggestedTool.confirmed ? (
        <div className="canvas-action-prompt">
          <p role="status">선택 영역이 {SELECTION_TOOLS[suggestedTool.toolId]}로 분류되었습니다. {SELECTION_TOOLS[suggestedTool.toolId]} 도구를 사용하시겠습니까?</p>
          <button type="button" disabled={locked || readOnly} onClick={() => {
            if (suggestedTool.toolId === 1) void readSelectedWord(suggestedTool);
            else setToolSuggestion({ ...suggestedTool, confirmed: true });
          }}>확인</button>
          <button type="button" onClick={() => setToolSuggestion(null)}>취소</button>
        </div>
      ) : suggestedTool?.phase ? (
        <div className="canvas-action-prompt canvas-ocr-prompt">
          {suggestedTool.phase === 'reading' && <p role="status">선택한 글자를 읽는 중…</p>}
          {suggestedTool.phase === 'review' && <>
            <label>인식 결과 <input type="text" value={suggestedTool.text}
              placeholder="글자를 입력하세요" onChange={event =>
                setToolSuggestion({ ...suggestedTool, text: event.target.value })} /></label>
            {!suggestedTool.text.trim() && <span role="status">글자를 찾지 못했습니다. 직접 입력하거나 다시 선택해 주세요.</span>}
            <button type="button" disabled={locked || readOnly || !suggestedTool.text.trim()}
              onClick={() => guardInput(() => applySelectedWord(suggestedTool))}>글자 적용</button>
          </>}
          {suggestedTool.phase === 'error' && <>
            <p role="alert">글자를 읽지 못했습니다.</p>
            <button type="button" disabled={locked || readOnly}
              onClick={() => void readSelectedWord(suggestedTool)}>다시 시도</button>
          </>}
          <button type="button" onClick={() => { selectionRequest.current++; setToolSuggestion(null); }}>취소</button>
        </div>
      ) : splitPrompt?.layerId === activeId && activeLayer?.visible && (
        <div className="canvas-action-prompt">
          <p role="status">잘못된 레이어에서 작성 중입니다. 임시 레이어로 분리하시겠습니까?</p>
          <button type="button" disabled={locked || readOnly} onClick={() => guardInput(splitRecentStrokes)}>확인</button>
          <button type="button" disabled={locked || readOnly} onClick={keepStrokesOnLayer}>취소</button>
        </div>
      )}
    </div>
  );
}

export default DrawCanvas;
