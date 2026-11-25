function premultipliedPixel(data, offset) {
  const alpha = data[offset + 3];
  return [data[offset] * alpha / 255, data[offset + 1] * alpha / 255, data[offset + 2] * alpha / 255, alpha];
}

function edgeCoverage(pixel, outer, seed) {
  const delta = outer.map((value, channel) => value - seed[channel]);
  const strongest = delta.reduce((best, value, channel) => Math.abs(value) > Math.abs(delta[best]) ? channel : best, 0);
  if (Math.abs(delta[strongest]) < 12) return 0;
  const coverage = (pixel[strongest] - seed[strongest]) / delta[strongest];
  // A blended edge lies between the seed and the stronger boundary color.
  if (coverage <= 0 || coverage >= 0.98 || pixel.some((value, channel) =>
    Math.abs(value - seed[channel] - coverage * delta[channel]) > 8)) return 0;
  return Math.max(1, Math.round(coverage * 255));
}

async function dilatedMask(mask, width, height) {
  const { default: cvModule } = await import('@techstark/opencv-js');
  const cv = await cvModule;
  const core = new cv.Mat(height, width, cv.CV_8UC1);
  const expanded = new cv.Mat();
  const kernel = cv.getStructuringElement(cv.MORPH_CROSS, new cv.Size(3, 3));
  try {
    core.data.set(mask);
    cv.dilate(core, expanded, kernel);
    return expanded.data.slice();
  } finally {
    kernel.delete();
    expanded.delete();
    core.delete();
  }
}

export async function findFillRegion({ data, width, height }, x, y) {
  const start = y * width + x;
  const offset = start * 4;
  const [red, green, blue, alpha] = data.subarray(offset, offset + 4);
  const mask = new Uint8Array(width * height);
  const queue = new Uint32Array(mask.length);
  let tail = 0;

  function visit(pixel) {
    if (mask[pixel]) return;
    const i = pixel * 4;
    if (data[i + 3] !== alpha ||
        (alpha !== 0 && (data[i] !== red || data[i + 1] !== green || data[i + 2] !== blue))) return;
    mask[pixel] = 255;
    queue[tail++] = pixel;
  }

  visit(start);
  for (let head = 0; head < tail; head++) {
    const pixel = queue[head];
    const column = pixel % width;
    if (column > 0) visit(pixel - 1);
    if (column < width - 1) visit(pixel + 1);
    if (pixel >= width) visit(pixel - width);
    if (pixel < mask.length - width) visit(pixel + width);
  }
  if (tail === mask.length) return { mask, hasEdge: false };

  const expanded = await dilatedMask(mask, width, height).catch(() => null);
  const seed = premultipliedPixel(data, offset);
  let hasEdge = false;
  for (let pixel = 0; pixel < mask.length; pixel++) {
    if (mask[pixel] || (expanded && !expanded[pixel])) continue;
    const column = pixel % width;
    const left = column > 0 && mask[pixel - 1] === 255;
    const right = column < width - 1 && mask[pixel + 1] === 255;
    const top = pixel >= width && mask[pixel - width] === 255;
    const bottom = pixel < mask.length - width && mask[pixel + width] === 255;
    if (!left && !right && !top && !bottom) continue;
    const pixelAlpha = data[pixel * 4 + 3];
    let coverage = 0;
    if (alpha === 0) {
      if (pixelAlpha < 255) coverage = pixelAlpha;
    } else {
      const edge = premultipliedPixel(data, pixel * 4);
      if (left && column < width - 1) coverage = edgeCoverage(edge, premultipliedPixel(data, (pixel + 1) * 4), seed);
      if (!coverage && right && column > 0) coverage = edgeCoverage(edge, premultipliedPixel(data, (pixel - 1) * 4), seed);
      if (!coverage && top && pixel < mask.length - width) coverage = edgeCoverage(edge, premultipliedPixel(data, (pixel + width) * 4), seed);
      if (!coverage && bottom && pixel >= width) coverage = edgeCoverage(edge, premultipliedPixel(data, (pixel - width) * 4), seed);
    }
    if (coverage > 0) {
      mask[pixel] = coverage;
      hasEdge = true;
    }
  }
  return { mask, hasEdge };
}
