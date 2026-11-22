export function fillConnectedPixels(composite, destination, x, y, color) {
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

// Bound the memory retained by full-layer undo snapshots.
const HISTORY_BYTES = 32 * 1024 * 1024
const HISTORY_LIMIT = 20

export function capturePixels(context) {
  const { width, height } = context.canvas
  if (width * height * 4 > HISTORY_BYTES) return
  return context.getImageData(0, 0, width, height)
}

export function recordEdit(history, layerId, pixels) {
  history.redo.length = 0
  if (!pixels) {
    history.undo.length = 0
    return
  }
  history.undo.push({ layerId, pixels })
  let bytes = history.undo.reduce((sum, entry) => sum + entry.pixels.data.byteLength, 0)
  while (bytes > HISTORY_BYTES || history.undo.length > HISTORY_LIMIT) {
    bytes -= history.undo.shift().pixels.data.byteLength
  }
}
