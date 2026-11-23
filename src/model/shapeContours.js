import cvModule from '@techstark/opencv-js'

function sampleBackground({ data, width, height }) {
  const corners = [0, width - 1, width * (height - 1), width * height - 1]
  const color = Array.from(data.subarray(0, 3))
  const opaqueCorners = corners.every(pixel => {
    const offset = pixel * 4
    return data[offset + 3] >= 250 && color.every((value, channel) => Math.abs(data[offset + channel] - value) <= 12)
  })
  if (!opaqueCorners) return null
  // An outline can reach all four corners while leaving transparent pixels inside.
  for (let offset = 3; offset < data.length; offset += 4) {
    if (data[offset] < 250) return null
  }
  return color
}

export async function traceShape(image) {
  const cv = await cvModule
  const { data, width, height } = image
  const background = sampleBackground(image)
  const resources = []
  const track = resource => {
    resources.push(resource)
    return resource
  }

  try {
    const mask = track(new cv.Mat(height, width, cv.CV_8UC1))
    const maskPixels = mask.data
    for (let pixel = 0; pixel < maskPixels.length; pixel++) {
      const offset = pixel * 4
      const alpha = data[offset + 3]
      const contrast = !background || background.some((channel, index) =>
        Math.abs(data[offset + index] - channel) * alpha / 255 > 16)
      maskPixels[pixel] = alpha >= 8 && contrast ? 255 : 0
    }

    const geometry = track(new cv.Mat())
    // Join small pen gaps for tracing, while keeping the erase mask tied to the original pixels.
    const kernelSize = Math.min(7, 2 * Math.max(1, Math.round(Math.min(width, height) * 0.008)) + 1)
    const kernel = track(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(kernelSize, kernelSize)))
    cv.morphologyEx(mask, geometry, cv.MORPH_CLOSE, kernel)
    const components = track(new cv.Mat())
    cv.connectedComponents(geometry, components, 8, cv.CV_32S)
    const contours = track(new cv.MatVector())
    const hierarchy = track(new cv.Mat())
    cv.findContours(geometry, contours, hierarchy, cv.RETR_CCOMP, cv.CHAIN_APPROX_SIMPLE)

    let largestIndex = -1
    let outerArea = 0
    for (let index = 0; index < contours.size(); index++) {
      if (hierarchy.data32S[index * 4 + 3] !== -1) continue
      const contour = contours.get(index)
      const area = cv.contourArea(contour)
      contour.delete()
      if (area > outerArea) {
        largestIndex = index
        outerArea = area
      }
    }
    if (largestIndex < 0 || outerArea < 9) return null

    const contour = track(contours.get(largestIndex))
    const bounds = cv.boundingRect(contour)
    const perimeter = cv.arcLength(contour, true)
    let largestHoleArea = 0
    let holePerimeter = 0
    for (let index = 0; index < contours.size(); index++) {
      if (hierarchy.data32S[index * 4 + 3] !== largestIndex) continue
      const hole = contours.get(index)
      const holeArea = cv.contourArea(hole)
      if (holeArea > largestHoleArea) {
        largestHoleArea = holeArea
        holePerimeter = cv.arcLength(hole, true)
      }
      hole.delete()
    }

    const labels = components.data32S
    const foreground = mask.data
    const component = labels[contour.data32S[1] * width + contour.data32S[0]]
    if (!component) return null
    const eraseMask = new Uint8Array(width * height)
    let maxAlpha = 0
    let color = null
    let inkArea = 0
    for (let pixel = 0; pixel < eraseMask.length; pixel++) {
      if (labels[pixel] !== component || !foreground[pixel]) continue
      eraseMask[pixel] = 255
      inkArea++
      const offset = pixel * 4
      if (data[offset + 3] > maxAlpha) {
        maxAlpha = data[offset + 3]
        color = Array.from(data.subarray(offset, offset + 3))
      }
    }
    if (!color) return null

    const hull = track(new cv.Mat())
    cv.convexHull(contour, hull)
    const hullArea = cv.contourArea(hull)
    const hullPerimeter = cv.arcLength(hull, true)
    const hasHole = largestHoleArea >= Math.max(9, outerArea * 0.05)
    let strokeWidth = hasHole ? Math.max(1, 2 * (outerArea - largestHoleArea) / (perimeter + holePerimeter)) : 0
    if (!hasHole && inkArea < hullArea * 0.7 && 2 * inkArea / perimeter < Math.min(bounds.width, bounds.height) * 0.24) {
      // A narrow outline can have an open gap and therefore no contour hole.
      const ink = track(new cv.Mat(height, width, cv.CV_8UC1))
      ink.data.set(eraseMask)
      const distance = track(new cv.Mat())
      cv.distanceTransform(ink, distance, cv.DIST_L2, 3)
      if (cv.minMaxLoc(distance).maxVal < Math.min(bounds.width, bounds.height) * 0.14) {
        strokeWidth = Math.max(1, 2 * inkArea / perimeter - 1)
      }
    }

    const polygon = track(new cv.Mat())
    const openOutline = strokeWidth > 0 && !hasHole
    const boundary = openOutline ? hull : contour
    const boundaryPerimeter = openOutline ? hullPerimeter : perimeter
    let isTriangle = false
    if (strokeWidth > 0 || outerArea >= hullArea * 0.86) {
      cv.approxPolyDP(hull, polygon, Math.max(1, hullPerimeter * 0.027), true)
      isTriangle = polygon.total() === 3 && cv.contourArea(polygon) >= hullArea * 0.76
      if (!isTriangle && hull.total() >= 3) {
        // Fit three edges around rounded corners only when the added area stays small.
        cv.approxPolyN(hull, polygon, 3, 0.22, false)
        isTriangle = polygon.total() === 3 && cv.contourArea(polygon) <= hullArea * 1.22
      }
    }
    if (!isTriangle) {
      let epsilon = Math.max(0.75, boundaryPerimeter * 0.018)
      do {
        cv.approxPolyDP(boundary, polygon, epsilon, true)
        epsilon *= 1.4
      } while (polygon.total() > 24)
    }
    if (polygon.total() < 3) return null

    const vertices = Array.from({ length: polygon.total() }, (_, index) => {
      const x = polygon.data32S[index * 2]
      const y = polygon.data32S[index * 2 + 1]
      const inset = (value, start, size) => start + size / 2 +
        (value - start - size / 2) * Math.max(0, 1 - strokeWidth / size)
      return {
        x: Math.max(0, Math.min(1, inset(x, bounds.x, bounds.width) / width)),
        y: Math.max(0, Math.min(1, inset(y, bounds.y, bounds.height) / height))
      }
    })
    return { vertices, eraseMask, width, height, color, background, opacity: maxAlpha / 255, strokeWidth }
  } finally {
    for (const resource of resources.reverse()) resource.delete()
  }
}
