import cvModule from '@techstark/opencv-js'

export async function findOcrLoops({ data, width, height }) {
  const cv = await cvModule
  const mask = new cv.Mat(height, width, cv.CV_8UC1)
  const contours = new cv.MatVector()
  const hierarchy = new cv.Mat()
  const polygon = new cv.Mat()

  try {
    const pixels = mask.data
    for (let i = 0; i < pixels.length; i++) {
      const offset = i * 4
      pixels[i] = Math.min(data[offset], data[offset + 1], data[offset + 2]) < 225 ? 255 : 0
    }
    cv.findContours(mask, contours, hierarchy, cv.RETR_CCOMP, cv.CHAIN_APPROX_SIMPLE)
    const loops = []
    for (let i = 0; i < contours.size(); i++) {
      if (hierarchy.data32S[i * 4 + 3] === -1) continue
      const hole = contours.get(i)
      try {
        const { size } = cv.minAreaRect(hole)
        const shortSide = Math.min(size.width, size.height)
        const longSide = Math.max(size.width, size.height)
        if (shortSide < 8 || longSide > shortSide * 1.6) continue
        const areaRatio = cv.contourArea(hole) / (shortSide * longSide)
        cv.approxPolyDP(hole, polygon, cv.arcLength(hole, true) * 0.022, true)
        let shape
        if (polygon.rows >= 5 && areaRatio >= 0.65 && areaRatio <= 0.85) shape = 'round'
        if (polygon.rows === 4 && areaRatio >= 0.89) shape = 'square'
        if (!shape) continue
        const { x, width: loopWidth } = cv.boundingRect(hole)
        loops.push({ left: x / width, right: (x + loopWidth) / width, shape })
      } finally {
        hole.delete()
      }
    }
    return loops
  } finally {
    polygon.delete()
    hierarchy.delete()
    contours.delete()
    mask.delete()
  }
}
