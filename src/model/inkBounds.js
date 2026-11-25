// 투명한 캔버스는 흰 바탕에 합성한 색으로 검사한다.
export function findInkBounds(image) {
  const { data, width, height } = image
  let left = width, top = height, right = -1, bottom = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const alpha = data[i + 3] / 255
      const darkest = Math.min(data[i], data[i + 1], data[i + 2])
      if (255 - (255 - darkest) * alpha >= 245) continue
      left = Math.min(left, x)
      top = Math.min(top, y)
      right = Math.max(right, x)
      bottom = Math.max(bottom, y)
    }
  }
  return right < left ? null : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 }
}
