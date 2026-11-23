import { useState, useRef, useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect } from 'react'


import { canAllocateCanvas, canvasImageError, hasVisiblePixels } from '../../services/canvasImage'
import { createLayer, EMPTY_LAYER_CATEGORY } from '../../repositories/layerRepository'
import { classifyImage } from '../../model/classificationClient'
import { prepareSymmetryBrush, updateSymmetryPreview } from '../../services/canvasSymmetry'

const HISTORY_LIMIT = 20;
const SELECTION_TOOLS = ['도형', '글자', '대칭'];
const CLASSIFICATION_IDLE_MS = 450;
const HISTORY_TAP_MAX_MS = 300;
const HISTORY_TAP_SLOP_PX = 10;

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

function drawStrokeDot(ctx, { x, y }, { width, color, opacity, operation }) {
  ctx.globalCompositeOperation = operation;
  ctx.globalAlpha = opacity;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, width / 2, 0, Math.PI * 2);
  ctx.fill();
}

function drawStrokeSegment(ctx, from, to) {
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
}

function createShapeMask({ width, height, eraseMask, background }) {
  const mask = new OffscreenCanvas(width, height);
  const ctx = mask.getContext('2d');
  const image = ctx.createImageData(width, height);
  for (let pixel = 0; pixel < eraseMask.length; pixel++) {
    const offset = pixel * 4;
    if (background) image.data.set(background, offset);
    image.data[offset + 3] = eraseMask[pixel];
  }
  ctx.putImageData(image, 0, 0);
  return mask;
}

function eraseOriginalShape(ctx, { area, mask, background }) {
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = background ? 'source-over' : 'destination-out';
  ctx.drawImage(mask, area.x, area.y, area.width, area.height);
  ctx.restore();
}

function paintConvertedShape(ctx, { vertices, color, opacity, strokeWidth }) {
  const path = new Path2D();
  path.moveTo(vertices[0].x, vertices[0].y);
  for (let i = 1; i < vertices.length; i++) path.lineTo(vertices[i].x, vertices[i].y);
  path.closePath();

  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = opacity;
  ctx.fillStyle = ctx.strokeStyle = `rgb(${color.join(',')})`;
  if (strokeWidth > 0) {
    ctx.lineWidth = strokeWidth;
    ctx.lineJoin = 'round';
    ctx.stroke(path);
  } else {
    ctx.fill(path);
  }
  ctx.restore();
}

function shapeBounds({ vertices, strokeWidth }) {
  const padding = strokeWidth / 2 + 2;
  const xs = vertices.map(point => point.x);
  const ys = vertices.map(point => point.y);
  return {
    left: Math.floor(Math.min(...xs) - padding),
    top: Math.floor(Math.min(...ys) - padding),
    right: Math.ceil(Math.max(...xs) + padding),
    bottom: Math.ceil(Math.max(...ys) + padding)
  };
}

function updateShapePreview(previous, shape) {
  const { area, source } = shape;
  const matches = previous?.area === area && previous.source === source;
  const ctx = matches ? previous.ctx : new OffscreenCanvas(source.width, source.height).getContext('2d');
  if (matches) {
    // 이전 도형이 차지했던 범위만 원본에서 복구한다.
    const { x, y, width, height } = previous.bounds;
    if (width > 0 && height > 0) {
      ctx.save();
      const clip = new Path2D();
      clip.rect(x, y, width, height);
      ctx.clip(clip);
      ctx.clearRect(x, y, width, height);
      ctx.drawImage(source, x, y, width, height, x, y, width, height);
      eraseOriginalShape(ctx, shape);
      ctx.restore();
    }
  } else {
    ctx.drawImage(source, 0, 0);
    eraseOriginalShape(ctx, shape);
  }
  paintConvertedShape(ctx, shape);
  const bounds = shapeBounds(shape);
  const x = Math.max(0, bounds.left);
  const y = Math.max(0, bounds.top);
  const width = Math.max(0, Math.min(source.width, bounds.right) - x);
  const height = Math.max(0, Math.min(source.height, bounds.bottom) - y);
  return { area, source, ctx, bounds: { x, y, width, height } };
}

function shapeExteriorClip(shape, width, height) {
  const bounds = shapeBounds(shape);
  const left = Math.min(0, bounds.left);
  const top = Math.min(0, bounds.top);
  const right = Math.max(width, bounds.right);
  const bottom = Math.max(height, bounds.bottom);
  if (left === 0 && top === 0 && right === width && bottom === height) return null;
  return `M${left},${top}H${right}V${bottom}H${left}Z M0,0H${width}V${height}H0Z`;
}

function extendSymmetryAxis({ axis: [first, second], area }) {
  const dx = second.x - first.x;
  const dy = second.y - first.y;
  const length = Math.hypot(area.width, area.height) / Math.hypot(dx, dy);
  return { x1: first.x - dx * length, y1: first.y - dy * length,
    x2: second.x + dx * length, y2: second.y + dy * length };
}

function pinchMetrics(touches, rect) {
  const [first, second] = touches.values();
  return {
    x: (first.x + second.x) / 2 - rect.left - rect.width / 2,
    y: (first.y + second.y) / 2 - rect.top - rect.height / 2,
    distance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y))
  };
}

function pinchViewport(start, current) {
  const scale = Math.min(5, Math.max(0.1, start.scale * current.distance / start.distance));
  const ratio = scale / start.scale;
  return {
    scale,
    pos: {
      x: current.x - (start.x - start.pos.x) * ratio,
      y: current.y - (start.y - start.pos.y) * ratio
    }
  };
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
  const surface = useRef(null);
  const activeStroke = useRef(null);
  const selectionDrag = useRef(null);
  const touchGesture = useRef({ pointers: new Map(), pinching: false, start: null, view: null, tap: null });
  const [selection, setSelection] = useState(null);
  const [toolSuggestion, setToolSuggestion] = useState(null);
  const [shapeDraft, setShapeDraft] = useState(null);
  const [symmetryDraft, setSymmetryDraft] = useState(null);
  const symmetryFrame = useRef(null);
  const shapeClipId = useId();
  const shapePreview = useRef(null);
  const shapeDrag = useRef(null);
  const selectionRequest = useRef(0);
  const classificationQueue = useRef({ timer: null, pending: null, running: false });
  const history = useRef({ undo: [], redo: [], revision: 0 });
  const layerReview = useRef(null);
  const [reviewPrompt, setReviewPrompt] = useState(null);
  const latestLayers = useRef(layerList);

  useLayoutEffect(() => {
    latestLayers.current = layerList;
  }, [layerList]);

  const layerSelection = selection?.layerId === activeId && activeLayer?.visible ? selection : null;
  const selectedArea = toolInfo.tool === 'select' ? layerSelection : null;
  const suggestedTool = toolSuggestion?.area === selectedArea ? toolSuggestion : null;
  const editedShape = shapeDraft?.area === selectedArea ? shapeDraft : null;
  const editedSymmetry = symmetryDraft?.area === layerSelection ? symmetryDraft : null;
  const shownSelection = editedSymmetry?.area ?? selectedArea;
  const editPreview = editedShape ?? editedSymmetry;
  const shapePoints = editedShape?.vertices.map(point => `${point.x},${point.y}`).join(' ');
  const exteriorClip = editedShape && shapeExteriorClip(editedShape, canvasWidth, canvasHeight);
  const drawLayers = useCallback(() => {
    const drag = selectionDrag.current;
    compose(drag?.preview ? { layerId: drag.layerId, canvas: drag.preview.canvas } : undefined);
  }, [compose]);

  useLayoutEffect(() => {
    if (!editPreview) {
      if (shapePreview.current) {
        shapePreview.current = null;
        drawLayers();
      }
      return;
    }

    const frame = requestAnimationFrame(() => {
      if (editPreview.revision !== history.current.revision) return;
      try {
        const previous = shapePreview.current;
        const preview = editedShape
          ? updateShapePreview(previous?.bounds ? previous : null, editedShape)
          : updateSymmetryPreview(previous, editPreview);
        shapePreview.current = preview;
        compose({ layerId: editPreview.area.layerId, canvas: preview.ctx.canvas });
      } catch (error) {
        shapePreview.current = null;
        drawLayers();
        console.error('선택 영역 미리보기 실패', error);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [editPreview, editedShape, compose, drawLayers]);

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

  function prepareLayerInput(source, opacity) {
    const ctx = createClassificationInput();
    const scale = 224 / Math.max(source.width, source.height);
    const width = source.width * scale;
    const height = source.height * scale;
    ctx.globalAlpha = opacity;
    ctx.drawImage(source, (224 - width) / 2, (224 - height) / 2, width, height);
    return ctx.canvas;
  }

  function setLayerCategory(layerId, category) {
    changeLayers(current => {
      const layer = current.find(item => item.layerId === layerId);
      if (!layer || layer.category === category) return;
      const hasGeneratedName = layer.name === `(${layer.category ?? EMPTY_LAYER_CATEGORY})` ||
        ((!layer.category || layer.category === EMPTY_LAYER_CATEGORY) &&
          (/^레이어 \d+$/.test(layer.name) || layer.name === '기존 그림'));
      const name = hasGeneratedName && category ? `(${category})` : layer.name;
      return { layers: current.map(item => item === layer ? { ...item, name, category } : item) };
    });
  }

  async function classifyLayer(layerId, stroke) {
    const revision = history.current.revision;
    try {
      const source = getLayerCanvas(layerId, false);
      const opacity = latestLayers.current.find(layer => layer.layerId === layerId)?.opacity;
      if (!source?.width || !source.height || !opacity) return;
      const input = stroke ? prepareStrokeInput(stroke, opacity) : prepareLayerInput(source, opacity);
      if (!input) return;
      const category = await predictCategory(input);
      if (revision !== history.current.revision || !canDraw() ||
          latestLayers.current.find(layer => layer.layerId === layerId)?.opacity !== opacity) return;
      if (!category) return;
      const review = layerReview.current;
      if (stroke && review?.layerId === layerId && review.strokes.at(-1) === stroke) {
        if (category !== review.category) setReviewPrompt({ review, category });
        return;
      }
      setLayerCategory(layerId, category);
    } catch (error) {
      console.error('레이어 자동 분류 실패', error);
    }
  }

  function clearLayerReview() {
    layerReview.current = null;
    setReviewPrompt(null);
  }

  function trackLayerSelection(id) {
    if (activeStroke.current || selectionDrag.current) finishStroke();
    cancelPendingClassification(classificationQueue.current);
    history.current.revision++;
    selectionRequest.current++;
    setToolSuggestion(null);
    discardShape();
    setSymmetryDraft(null);
    const category = latestLayers.current.find(layer => layer.layerId === id)?.category;
    clearLayerReview();
    if (category && category !== EMPTY_LAYER_CATEGORY) {
      layerReview.current = { layerId: id, category, strokes: [] };
    }
  }

  function resolveLayerReview(separate) {
    const review = layerReview.current;
    if (!review || reviewPrompt?.review !== review || review.layerId !== activeId ||
        !canDraw() || activeStroke.current || selectionDrag.current || !activeLayer?.visible) return;
    const { category } = reviewPrompt;
    if (!separate) {
      history.current.revision++;
      cancelPendingClassification(classificationQueue.current);
      setLayerCategory(review.layerId, category);
      clearLayerReview();
      return;
    }

    changeLayers((current, selectedId) => {
      const index = current.findIndex(layer => layer.layerId === review.layerId);
      const source = getLayerCanvas(review.layerId, false);
      if (index < 0 || selectedId !== review.layerId || source !== review.source) return;
      const temp = { ...createLayer(`임시 레이어 (${category})`, category),
        isTemporary: true, opacity: current[index].opacity };
      const sourceCtx = source.getContext('2d');
      const before = captureLayer(sourceCtx);
      const target = getLayerCanvas(temp.layerId, true);
      const targetCtx = target?.getContext('2d');
      if (!targetCtx) return;
      const blank = targetCtx.createImageData(target.width, target.height);

      for (const stroke of review.strokes) {
        const { points } = stroke;
        drawStrokeDot(targetCtx, points[0], { ...stroke, operation: 'source-over' });
        for (let i = 1; i < points.length; i++) drawStrokeSegment(targetCtx, points[i - 1], points[i]);
      }
      targetCtx.globalAlpha = 1;
      sourceCtx.putImageData(review.baseline, 0, 0);
      recordEdit(review.layerId, before, [{ layerId: temp.layerId, canvas: target, pixels: blank }]);
      history.current.revision++;
      cancelPendingClassification(classificationQueue.current);
      clearLayerReview();
      const layers = [...current];
      layers.splice(index, 0, temp);
      return { layers, activeId: temp.layerId, changedPixelIds: [review.layerId, temp.layerId] };
    });
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

  async function confirmSuggestedTool() {
    if (!suggestedTool || suggestedTool.loading || !canDraw()) return;
    if (suggestedTool.toolId === 2) {
      beginSymmetry();
      return;
    }
    if (suggestedTool.toolId !== 0) {
      setToolSuggestion({ ...suggestedTool, confirmed: true });
      return;
    }

    const { area } = suggestedTool;
    const source = getLayerCanvas(area.layerId, false);
    if (!source) return;
    const request = ++selectionRequest.current;
    const revision = history.current.revision;
    setToolSuggestion({ ...suggestedTool, loading: true, error: null });
    try {
      const ratio = Math.min(1, 768 / Math.max(area.width, area.height));
      const input = new OffscreenCanvas(
        Math.max(1, Math.round(area.width * ratio)),
        Math.max(1, Math.round(area.height * ratio))
      );
      input.getContext('2d').drawImage(source, area.x, area.y, area.width, area.height, 0, 0, input.width, input.height);
      const shape = await classifyImage(input, 'shape');
      if (request !== selectionRequest.current || revision !== history.current.revision) return;
      if (!shape) {
        setToolSuggestion({ ...suggestedTool, error: '변환할 도형의 외곽선을 찾지 못했습니다.' });
        return;
      }
      setShapeDraft({
        area, source, revision, mask: createShapeMask(shape),
        color: shape.color, background: shape.background, opacity: shape.opacity,
        vertices: shape.vertices.map(point => ({
          x: area.x + point.x * area.width,
          y: area.y + point.y * area.height
        })),
        strokeWidth: shape.strokeWidth * Math.max(area.width / shape.width, area.height / shape.height)
      });
      setToolSuggestion(null);
    } catch (error) {
      if (request !== selectionRequest.current || revision !== history.current.revision) return;
      console.error('OpenCV 도형 변환 실패', error);
      setToolSuggestion({ ...suggestedTool, error: '도형을 변환하지 못했습니다. 다시 시도해 주세요.' });
    }
  }

  function updateVertex(index, x, y) {
    setShapeDraft(draft => {
      if (!draft) return draft;
      const vertices = draft.vertices.map((point, i) => i === index ? { x, y } : point);
      return { ...draft, vertices };
    });
  }

  function startShapeDrag(event, index = null) {
    if (!editedShape) return;
    startEditorDrag(event, index !== null, (dx, dy) => {
      if (index === null) {
        const vertices = editedShape.vertices.map(point => ({ x: point.x + dx, y: point.y + dy }));
        setShapeDraft(draft => draft ? { ...draft, vertices } : draft);
      } else {
        const point = editedShape.vertices[index];
        updateVertex(index, point.x + dx, point.y + dy);
      }
    });
  }

  function startEditorDrag(event, focus, update) {
    event.stopPropagation();
    if (event.button !== 0 || shapeDrag.current || activeStroke.current || !canDraw()) return;
    if (event.cancelable) event.preventDefault();
    if (focus) event.currentTarget.focus({ preventScroll: true });
    const { pointerId, clientX, clientY } = event;
    const move = next => {
      if (next.pointerId !== pointerId) return;
      next.stopPropagation();
      update((next.clientX - clientX) / scale, (next.clientY - clientY) / scale);
    };
    const end = next => {
      if (next.pointerId !== pointerId) return;
      if (next.type === 'pointerup') move(next);
      stopShapeDrag();
    };
    shapeDrag.current = {
      release: () => {
        window.removeEventListener('pointermove', move, true);
        window.removeEventListener('pointerup', end, true);
        window.removeEventListener('pointercancel', end, true);
      } };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', end, true);
    window.addEventListener('pointercancel', end, true);
  }

  function stopShapeDrag() {
    const drag = shapeDrag.current;
    shapeDrag.current = null;
    drag?.release();
  }

  function discardShape() {
    stopShapeDrag();
    setShapeDraft(null);
  }

  function beginSymmetry() {
    if (!selectedArea?.settled || !canDraw() || selectionDrag.current || editPreview) return;
    const source = getLayerCanvas(selectedArea.layerId, false);
    if (!source) return;
    const { x, y, width, height } = selectedArea;
    const center = x + width / 2;
    selectionRequest.current++;
    setToolSuggestion(null);
    setSymmetryDraft({
      area: selectedArea, source, revision: history.current.revision, sourceSide: 1,
      axis: [{ x: center, y: y + height * 0.15 }, { x: center, y: y + height * 0.85 }]
    });
  }

  function moveSymmetryPoint(index, x, y) {
    if (activeStroke.current) return;
    setSymmetryDraft(draft => {
      if (!draft) return draft;
      const { area, axis } = draft;
      const point = {
        x: Math.max(area.x, Math.min(area.x + area.width, x)),
        y: Math.max(area.y, Math.min(area.y + area.height, y))
      };
      const other = axis[1 - index];
      if (Math.hypot(point.x - other.x, point.y - other.y) < 0.5) return draft;
      return { ...draft, axis: axis.map((current, i) => i === index ? point : current) };
    });
  }

  function discardSymmetry() {
    if (activeStroke.current?.symmetry) finishStroke();
    stopShapeDrag();
    setSymmetryDraft(null);
  }

  function applySymmetry() {
    if (!editedSymmetry || !canDraw() || shapeDrag.current || activeStroke.current) return;
    const { area, source, revision } = editedSymmetry;
    if (source !== getLayerCanvas(area.layerId, false) || revision !== history.current.revision) {
      discardSymmetry();
      return;
    }
    const preview = updateSymmetryPreview(shapePreview.current, editedSymmetry);
    const ctx = source.getContext('2d');
    const before = captureLayer(ctx);
    const { x, y, width, height } = area;
    let after;
    ctx.save();
    try {
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(x, y, width, height);
      ctx.drawImage(preview.ctx.canvas, x, y, width, height, x, y, width, height);
      after = captureLayer(ctx);
    } catch (error) {
      ctx.putImageData(before, 0, 0);
      throw error;
    } finally {
      ctx.restore();
    }
    history.current.revision++;
    commitEdit(area.layerId, before);
    discardSymmetry();
    setSelection(null);
    drawLayers();
    updateClassification(area.layerId, after);
  }

  function applyShape() {
    if (!editedShape || !canDraw() || shapeDrag.current) return;
    const { area, source, revision } = editedShape;
    const currentSource = getLayerCanvas(area.layerId, false);
    if (currentSource !== source || revision !== history.current.revision) {
      discardShape();
      return;
    }

    const ctx = source.getContext('2d');
    const before = captureLayer(ctx);
    let after;
    try {
      eraseOriginalShape(ctx, editedShape);
      paintConvertedShape(ctx, editedShape);
      after = captureLayer(ctx);
    } catch (error) {
      ctx.putImageData(before, 0, 0);
      throw error;
    }
    history.current.revision++;
    commitEdit(area.layerId, before);
    discardShape();
    setSelection(null);
    drawLayers();
    updateClassification(area.layerId, after);
  }

  function prepareStrokeInput({ points, width, color, opacity }, layerOpacity) {
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

    const strokeCanvas = new OffscreenCanvas(224, 224);
    const ctx = strokeCanvas.getContext('2d');
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

    const input = createClassificationInput();
    input.globalAlpha = layerOpacity;
    input.drawImage(strokeCanvas, 0, 0);
    return input.canvas;
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
      if (!canDraw() || !target || editPreview || activeStroke.current || selectionDrag.current ||
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
      updateClassification(layer.layerId, pixels);
    })
  }));

  function applyHistory(redo) {
    if (!canDraw() || editedSymmetry || activeStroke.current || selectionDrag.current || touchGesture.current.pinching) return;

    const state = history.current;
    const from = redo ? state.redo : state.undo;
    const to = redo ? state.undo : state.redo;
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
      setSelection(null);
      drawLayers();
      onStrokeEnd(entry.layerId, true);
      updateClassification(entry.layerId, entry.pixels);
      for (const { part } of additional) {
        onStrokeEnd(part.layerId, true);
        updateClassification(part.layerId, part.pixels);
      }
      return;
    }
  }

  useEffect(() => {
    const handleHistoryShortcut = event => {
      const isUndoKey = event.code === 'KeyZ' || event.key.toLowerCase() === 'z';
      if (event.defaultPrevented || !event.ctrlKey || event.altKey ||
          event.metaKey || !isUndoKey) return;
      if (event.target instanceof HTMLElement &&
          (event.target.isContentEditable ||
           event.target.matches('textarea, input:is(:not([type]), [type="text"], [type="search"], [type="email"], [type="url"], [type="tel"], [type="password"], [type="number"])'))) return;
      if (!canDraw() || activeStroke.current || selectionDrag.current) return;

      event.preventDefault();
      applyHistory(event.shiftKey);
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
    discardShape();
    setSymmetryDraft(null);
    if (!layer?.visible || !layer.data) {
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
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  }

  function updateSelection(event, drag) {
    const { start, original, preview } = drag;
    const point = selectionPoint(event, drag.layer);
    if (!original) {
      const x = Math.max(0, Math.min(start.x, point.x));
      const y = Math.max(0, Math.min(start.y, point.y));
      const width = Math.min(point.width, Math.max(start.x, point.x)) - x;
      const height = Math.min(point.height, Math.max(start.y, point.y)) - y;
      const area = width > 0 && height > 0 ? {
        layerId: drag.layerId, x, y, width, height
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
    const area = { ...original, x, y, settled: false };
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
      const before = captureLayer(drag.layer);
      history.current.revision++;
      const after = captureLayer(drag.preview);
      drag.layer.putImageData(after, 0, 0);
      commitEdit(drag.layerId, before);
      updateClassification(drag.layerId, after);
      const x = Math.max(0, area.x);
      const y = Math.max(0, area.y);
      const width = Math.min(canvas.current.width, drag.layer.canvas.width, area.x + area.width) - x;
      const height = Math.min(canvas.current.height, drag.layer.canvas.height, area.y + area.height) - y;
      setSelection(width > 0 && height > 0 ? { ...area, x, y, width, height, settled: true } : null);
    } else {
      const settled = area && { ...area, settled: true };
      setSelection(settled);
      if (valid && settled && !drag.original) void suggestSelectionTool(settled, drag.layer.canvas);
    }
    if (drag.preview) drawLayers();
  }

  const updatePointer = event => {
    const rect = canvas.current.getBoundingClientRect();
    pointer.x = (event.clientX - rect.left) * canvasWidth / rect.width;
    pointer.y = (event.clientY - rect.top) * canvasHeight / rect.height;
  };

  function queueSymmetryStrokePreview(stroke) {
    if (symmetryFrame.current !== null) return;
    symmetryFrame.current = requestAnimationFrame(() => {
      symmetryFrame.current = null;
      if (activeStroke.current !== stroke || stroke.symmetry.revision !== history.current.revision) return;
      guardInput(() => {
        const preview = updateSymmetryPreview(shapePreview.current, stroke.symmetry);
        shapePreview.current = preview;
        compose({ layerId: stroke.layerId, canvas: preview.ctx.canvas });
      });
    });
  }

  function startSymmetryStroke(event) {
    if (shapeDrag.current) return;
    updatePointer(event);
    const { area, source, working: previousWorking } = editedSymmetry;
    const { x, y, width, height } = area;
    if (pointer.x < x || pointer.x >= x + width || pointer.y < y || pointer.y >= y + height) return;
    const erasing = toolInfo.tool === 'eraser';
    const opacity = erasing ? 1 : penOpacity;
    if (opacity === 0) return;

    const working = previousWorking ?? new OffscreenCanvas(width, height);
    const ctx = working.getContext('2d');
    if (!previousWorking) ctx.drawImage(source, x, y, width, height, 0, 0, width, height);
    const before = previousWorking && event.pointerType === 'touch' ? captureLayer(ctx) : null;
    const brush = prepareSymmetryBrush(editedSymmetry);
    if (event.cancelable) event.preventDefault();
    const { pointerId } = event;
    const move = next => {
      if (next.pointerId !== pointerId) return;
      next.stopPropagation();
      guardInput(() => handlePointerMove(next));
    };
    const end = next => {
      if (next.pointerId !== pointerId) return;
      next.stopPropagation();
      guardInput(() => handlePointerEnd(next));
    };
    const stroke = {
      pointerId, layerId: area.layerId, target: event.currentTarget,
      layerCanvas: ctx, symmetry: { ...editedSymmetry, working }, previousWorking, before, brush,
      release: () => {
        window.removeEventListener('pointermove', move, true);
        window.removeEventListener('pointerup', end, true);
        window.removeEventListener('pointercancel', end, true);
      }
    };
    activeStroke.current = stroke;
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', end, true);
    window.addEventListener('pointercancel', end, true);
    ctx.save();
    ctx.translate(-x, -y);
    ctx.clip(brush.clip);
    drawStrokeDot(ctx, brush.fold(pointer), {
      width: strokeSize, color: toolInfo.color, opacity, operation: erasing ? 'destination-out' : 'source-over'
    });
    queueSymmetryStrokePreview(stroke);
  }

  function finishSymmetryStroke(stroke, canceled = false) {
    stroke.release();
    cancelAnimationFrame(symmetryFrame.current);
    symmetryFrame.current = null;
    stroke.layerCanvas.restore();
    if (canceled && stroke.before) stroke.layerCanvas.putImageData(stroke.before, 0, 0);
    const working = canceled ? stroke.previousWorking : stroke.symmetry.working;
    setSymmetryDraft(draft => draft?.area === stroke.symmetry.area ? { ...draft, working } : draft);
  }

  const onPointerDown = e => {
    // ------ 추가-2 ------
    const onCanvas = e.target === canvas.current;
    const selecting = toolInfo.tool === 'select';
    if (!canDraw() || !allocated || editedShape || e.button !== 0 || activeStroke.current ||
        selectionDrag.current || !activeLayer?.visible ||
        (!onCanvas && !(selecting && e.target === e.currentTarget))) return;
    if (editedSymmetry) {
      if (onCanvas) startSymmetryStroke(e);
      return;
    }
    const layer = getLayer(activeId, toolInfo.tool === 'pen');
    if (selecting) {
      if (e.cancelable) e.preventDefault();
      startSelection(e, layer);
      return;
    }
    const opacity = toolInfo.tool === 'pen' ? penOpacity : 1;
    if (!layer?.data || opacity === 0) return;
    if (e.cancelable) e.preventDefault();
    cancelPendingClassification(classificationQueue.current);
    setSelection(null);
    const layerCanvas = layer.data;
    const pixels = captureLayer(layerCanvas);
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    updatePointer(e);
    history.current.revision++;
    activeStroke.current = {
      pointerId: e.pointerId,
      layerId: layer.layerId,
      layerCanvas,
      pixels, target: e.currentTarget,
      classificationStroke: toolInfo.tool === 'pen' && layer.category && layer.category !== EMPTY_LAYER_CATEGORY
        ? { points: [{ x: pointer.x, y: pointer.y }], width: strokeSize, color: toolInfo.color, opacity }
        : null
    };
    onStrokeStart();
    onInputError(null);

    const style = { width: strokeSize, color: toolInfo.color, opacity,
      operation: toolInfo.tool === 'eraser' ? 'destination-out' : 'source-over' };
    drawStrokeDot(layerCanvas, pointer, style);
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

    if (stroke.symmetry) {
      const from = { x, y };
      const crossing = stroke.brush.split(from, pointer);
      if (crossing) {
        drawStrokeSegment(stroke.layerCanvas, stroke.brush.fold(from), crossing);
        drawStrokeSegment(stroke.layerCanvas, crossing, stroke.brush.fold(pointer));
      } else {
        drawStrokeSegment(stroke.layerCanvas, stroke.brush.fold(from), stroke.brush.fold(pointer));
      }
      queueSymmetryStrokePreview(stroke);
      return;
    }

    stroke.classificationStroke?.points.push({ x: pointer.x, y: pointer.y });
    drawStrokeSegment(stroke.layerCanvas, { x, y }, pointer);
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
    if (stroke.symmetry) {
      finishSymmetryStroke(stroke);
      return;
    }
    stroke.layerCanvas.globalAlpha = 1;
    let after;
    try {
      after = captureLayer(stroke.layerCanvas);
    } catch (error) {
      onStrokeEnd(stroke.layerId, true);
      onRenderError(error);
      return;
    }
    const changed = after.data.some((value, index) => value !== stroke.pixels.data[index]);
    if (changed) {
      recordEdit(stroke.layerId, stroke.pixels);
      const review = layerReview.current;
      if (stroke.classificationStroke && review?.layerId === stroke.layerId) {
        review.baseline ??= stroke.pixels;
        review.source ??= stroke.layerCanvas.canvas;
        review.strokes.push(stroke.classificationStroke);
      }
    }
    onStrokeEnd(stroke.layerId, changed);
    if (changed) updateClassification(stroke.layerId, after, stroke.classificationStroke);
  }

  function updateClassification(layerId, pixels, stroke) {
    if (!stroke && layerReview.current?.layerId === layerId) clearLayerReview();
    if (!hasVisiblePixels(pixels)) {
      cancelPendingClassification(classificationQueue.current);
      setLayerCategory(layerId, EMPTY_LAYER_CATEGORY);
    } else {
      scheduleLayerClassification(layerId, stroke);
    }
  }

  function scheduleLayerClassification(layerId, stroke) {
    if (layerList.find(layer => layer.layerId === layerId)?.category === EMPTY_LAYER_CATEGORY) {
      setLayerCategory(layerId, null);
    }
    const revision = history.current.revision;
    queueStrokeClassification(classificationQueue.current, () => {
      if (!activeStroke.current && revision === history.current.revision && canDraw()) {
        return classifyLayer(layerId, stroke);
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

  function cancelTouchEdit(pointerId) {
    const stroke = activeStroke.current;
    if (stroke?.pointerId === pointerId) {
      activeStroke.current = null;
      if (stroke.symmetry) {
        finishSymmetryStroke(stroke, true);
        return;
      }
      stroke.layerCanvas.putImageData(stroke.pixels, 0, 0);
      stroke.layerCanvas.globalAlpha = 1;
      onStrokeEnd(stroke.layerId, false);
      drawLayers();
    } else if (selectionDrag.current?.pointerId === pointerId) {
      finishStroke();
    }
  }

  function beginPinch(gesture, target) {
    gesture.start = {
      ...pinchMetrics(gesture.pointers, target.getBoundingClientRect()),
      ...gesture.view
    };
  }

  function handlePointerDown(event) {
    const gesture = touchGesture.current;
    if (event.pointerType !== 'touch') {
      if (!gesture.pinching) onPointerDown(event);
      return;
    }
    if (!ready || locked || !allocated ||
        (event.target !== canvas.current && event.target !== event.currentTarget)) return;
    const drawingId = activeStroke.current?.pointerId ?? selectionDrag.current?.pointerId;
    if (drawingId != null && !gesture.pointers.has(drawingId)) return;

    if (event.cancelable) event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    if (gesture.pointers.size === 0) {
      gesture.tap = { startTime: event.timeStamp, fingers: 0, moved: false, released: false, canceled: false };
    }
    if (gesture.tap.released) gesture.tap.canceled = true;
    gesture.pointers.set(event.pointerId, {
      x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY
    });
    gesture.tap.fingers = Math.max(gesture.tap.fingers, gesture.pointers.size);
    if (gesture.pointers.size >= 2) {
      if (!gesture.pinching) {
        gesture.pinching = true;
        gesture.view = { scale, pos };
        if (drawingId != null) cancelTouchEdit(drawingId);
      }
      if (!gesture.start) beginPinch(gesture, event.currentTarget);
    } else if (!gesture.pinching) {
      onPointerDown(event);
    }
  }

  function updateTouchPosition(gesture, event) {
    const point = gesture.pointers.get(event.pointerId);
    point.x = event.clientX;
    point.y = event.clientY;
    if (Math.hypot(point.x - point.startX, point.y - point.startY) > HISTORY_TAP_SLOP_PX) {
      gesture.tap.moved = true;
    }
  }

  function handlePointerMove(event) {
    const gesture = touchGesture.current;
    if (event.pointerType === 'touch') {
      if (!gesture.pointers.has(event.pointerId)) return;
      updateTouchPosition(gesture, event);
    }
    if (gesture.pinching) {
      if (event.pointerType !== 'touch' || !gesture.start || !gesture.tap.moved || !ready || locked) return;
      const view = pinchViewport(gesture.start, pinchMetrics(gesture.pointers, event.currentTarget.getBoundingClientRect()));
      gesture.view = view;
      setPos(view.pos);
      setScale(view.scale);
      return;
    }
    const drawingId = activeStroke.current?.pointerId ?? selectionDrag.current?.pointerId;
    if (event.pointerType === 'mouse' && drawingId === event.pointerId && !(event.buttons & 1)) {
      onPointerUp(event);
      return;
    }
    onPointerMove(event);
  }

  function handlePointerEnd(event) {
    if (event.type === 'lostpointercapture' && event.target !== event.currentTarget) return;
    if (event.type === 'lostpointercapture' && (event.buttons & 1) &&
        activeStroke.current?.symmetry && activeStroke.current.pointerId === event.pointerId) return;
    const gesture = touchGesture.current;
    if (event.pointerType === 'touch') {
      if (!gesture.pointers.has(event.pointerId)) return;
      const tap = gesture.tap;
      if (event.type === 'pointerup') updateTouchPosition(gesture, event);
      else tap.canceled = true;
      tap.released = true;
      const pairChanged = [...gesture.pointers.keys()].slice(0, 2).includes(event.pointerId);
      gesture.pointers.delete(event.pointerId);
      if (gesture.pinching) {
        if (gesture.pointers.size === 0) {
          gesture.pinching = false;
          gesture.start = null;
          gesture.view = null;
          gesture.tap = null;
          if (!tap.canceled && !tap.moved && event.timeStamp - tap.startTime <= HISTORY_TAP_MAX_MS &&
              (tap.fingers === 2 || tap.fingers === 3)) {
            applyHistory(tap.fingers === 3);
          }
        } else if (gesture.pointers.size < 2) {
          gesture.start = null;
        } else if (pairChanged) {
          beginPinch(gesture, event.currentTarget);
        }
        return;
      }
      gesture.tap = null;
      if (event.type !== 'pointerup') {
        cancelTouchEdit(event.pointerId);
        return;
      }
    }
    onPointerUp(event);
  }

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
    const frame = symmetryFrame;
    const stroke = activeStroke;
    return () => {
      cancelPendingClassification(queue);
      editHistory.revision++;
      cancelAnimationFrame(frame.current);
      stroke.current?.release?.();
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

  useEffect(() => {
    const onBlur = () => guardInput(() => {
      stopShapeDrag();
      const gesture = touchGesture.current;
      const drawingId = activeStroke.current?.pointerId ?? selectionDrag.current?.pointerId;
      if (drawingId != null && gesture.pointers.has(drawingId)) cancelTouchEdit(drawingId);
      else finishStroke();
      const pointers = [...gesture.pointers.keys()];
      gesture.pointers.clear();
      gesture.pinching = false;
      gesture.start = null;
      gesture.view = null;
      gesture.tap = null;
      for (const id of pointers) {
        if (surface.current?.hasPointerCapture(id)) surface.current.releasePointerCapture(id);
      }
    });
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  });

  useEffect(() => {
    const drag = shapeDrag;
    return () => { drag.current?.release(); };
  }, []);

  return (
    <div className="drawarea">
      <div ref={surface} className="drawing-surface" onWheel={e => {
        if (!ready || locked || touchGesture.current.pinching || activeStroke.current?.symmetry) return;
        updatePointer(e);
        const delta = e.deltaY > 0 ? scale/20 : -scale/20;
        const scaleValue = Math.min(Math.max(scale + delta, 0.1), 5);
        setPos({
          x: pos.x + (pointer.x - canvasWidth / 2)*(scale-scaleValue),
          y: pos.y + (pointer.y - canvasHeight / 2)*(scale-scaleValue)
        });
        setScale(scaleValue);
      }}
      onPointerDown={event => guardInput(() => handlePointerDown(event))}
      onPointerMove={event => guardInput(() => handlePointerMove(event))}
      onPointerUp={event => guardInput(() => handlePointerEnd(event))}
      onPointerCancel={event => guardInput(() => handlePointerEnd(event))}
      onLostPointerCapture={event => guardInput(() => handlePointerEnd(event))}
      >
        <canvas ref={canvas} className="drawcanvas" width={allocated ? canvasWidth : 1} height={allocated ? canvasHeight : 1}
          data-ready={ready && !locked} data-read-only={readOnly} aria-busy={!ready || locked}
          style={{background: backgroundColor, transform: `translate(calc(-50% + ${pos.x}px), calc(-50% + ${pos.y}px))scale(${scale})`}}
        />
      </div>
      {shownSelection && !editedShape && (
        <div
          className="canvas-selection"
          style={{
            left: `calc(50% + ${pos.x + (shownSelection.x - canvasWidth / 2) * scale}px)`,
            top: `calc(50% + ${pos.y + (shownSelection.y - canvasHeight / 2) * scale}px)`,
            width: shownSelection.width * scale,
            height: shownSelection.height * scale
          }}
        />
      )}
      {editedShape && (
        <div className="shape-editor" style={{
          left: `calc(50% + ${pos.x}px)`, top: `calc(50% + ${pos.y}px)`,
          width: canvasWidth * scale, height: canvasHeight * scale
        }}>
          <svg viewBox={`0 0 ${canvasWidth} ${canvasHeight}`} aria-hidden="true">
            {exteriorClip && <>
              <defs><clipPath id={shapeClipId}><path d={exteriorClip} clipRule="evenodd" /></clipPath></defs>
              <polygon points={shapePoints} clipPath={`url(#${shapeClipId})`}
                pointerEvents="none" opacity={editedShape.opacity * activeLayer.opacity}
                fill={editedShape.strokeWidth ? 'none' : `rgb(${editedShape.color.join(',')})`}
                stroke={editedShape.strokeWidth ? `rgb(${editedShape.color.join(',')})` : 'none'}
                strokeWidth={editedShape.strokeWidth} strokeLinejoin="round" strokeDasharray="none" />
            </>}
            <polygon className="shape-body" points={shapePoints}
              vectorEffect="non-scaling-stroke"
              onPointerDown={event => startShapeDrag(event)} />
          </svg>
          {editedShape.vertices.map((point, index) => (
            <button key={index} type="button" className="shape-vertex" aria-label={`정점 ${index + 1}`}
              disabled={locked || readOnly}
              style={{ left: point.x * scale, top: point.y * scale }}
              onPointerDown={event => startShapeDrag(event, index)}
              onKeyDown={event => {
                const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
                if (!delta) return;
                event.preventDefault();
                const step = event.shiftKey ? 10 : 1;
                updateVertex(index, point.x + delta[0] * step, point.y + delta[1] * step);
              }} />
          ))}
        </div>
      )}
      {editedSymmetry && (
        <div className="shape-editor symmetry-editor" style={{
          left: `calc(50% + ${pos.x}px)`, top: `calc(50% + ${pos.y}px)`,
          width: canvasWidth * scale, height: canvasHeight * scale
        }}>
          <svg viewBox={`0 0 ${canvasWidth} ${canvasHeight}`} aria-hidden="true">
            <defs><clipPath id={shapeClipId}><rect x={editedSymmetry.area.x} y={editedSymmetry.area.y}
              width={editedSymmetry.area.width} height={editedSymmetry.area.height} /></clipPath></defs>
            <line {...extendSymmetryAxis(editedSymmetry)} clipPath={`url(#${shapeClipId})`} vectorEffect="non-scaling-stroke" />
          </svg>
          {editedSymmetry.axis.map((point, index) => (
            <button key={index} type="button" className="shape-vertex" aria-label={`대칭축 점 ${index + 1}`}
              disabled={locked || readOnly} style={{ left: point.x * scale, top: point.y * scale }}
              onPointerDown={event => startEditorDrag(event, true, (dx, dy) => moveSymmetryPoint(index, point.x + dx, point.y + dy))}
              onKeyDown={event => {
                const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
                if (!delta) return;
                event.preventDefault();
                const step = event.shiftKey ? 10 : 1;
                moveSymmetryPoint(index, point.x + delta[0] * step, point.y + delta[1] * step);
              }} />
          ))}
        </div>
      )}
      {editedSymmetry ? (
        <div className="canvas-action-prompt symmetry-actions">
          <p>선택 영역에 그리면 반대쪽에도 그려집니다. 축의 양 끝을 끌어 방향을 조절하세요.</p>
          <button type="button" disabled={locked || readOnly} onClick={() => {
            if (!activeStroke.current) setSymmetryDraft(draft => ({ ...draft, sourceSide: -draft.sourceSide }));
          }}>반대쪽 기준</button>
          <button type="button" disabled={locked || readOnly} onClick={() => guardInput(applySymmetry)}>적용</button>
          <button type="button" onClick={discardSymmetry}>취소</button>
        </div>
      ) : editedShape ? (
        <div className="canvas-action-prompt">
          <p>도형 안쪽을 끌어 이동하거나 정점을 끌어 모양을 바꾸세요.</p>
          <button type="button" disabled={locked || readOnly} onClick={() => guardInput(applyShape)}>적용</button>
          <button type="button" onClick={discardShape}>취소</button>
        </div>
      ) : suggestedTool && !suggestedTool.confirmed ? (
        <div className="canvas-action-prompt">
          <p role="status">{suggestedTool.error || (suggestedTool.loading ? '도형 외곽선을 분석하고 있습니다…'
            : `선택 영역이 ${SELECTION_TOOLS[suggestedTool.toolId]}로 분류되었습니다. ${SELECTION_TOOLS[suggestedTool.toolId]} 도구를 사용하시겠습니까?`)}</p>
          <button type="button" disabled={locked || readOnly || suggestedTool.loading} onClick={confirmSuggestedTool}>
            {suggestedTool.error ? '다시 시도' : '확인'}
          </button>
          <button type="button" onClick={() => { selectionRequest.current++; setToolSuggestion(null); }}>취소</button>
        </div>
      ) : reviewPrompt?.review.layerId === activeId && activeLayer?.visible ? (
        <div className="canvas-action-prompt">
          <p role="status">현재 레이어는 {reviewPrompt.review.category}, 새 획은 {reviewPrompt.category}입니다. 임시 레이어로 분리하시겠습니까?</p>
          <button type="button" disabled={locked || readOnly} onClick={() => guardInput(() => resolveLayerReview(true))}>분리</button>
          <button type="button" disabled={locked || readOnly} onClick={() => guardInput(() => resolveLayerReview(false))}>현재 레이어에 유지</button>
        </div>
      ) : null}
    </div>
  );
}

export default DrawCanvas;
