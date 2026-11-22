import { canvasImageError, prepareCanvas, restoreCanvasPng } from './canvasImage'

// 화면을 포함한 상시 RGBA 버퍼 상한. 인코딩·디코딩 사본의 메모리는 별도다.
export const MAX_LAYER_BUFFER_PIXELS = 67_108_864

export function createLayerCanvas(display, width, height, onContextLost) {
  const output = prepareCanvas(display, width, height)
  const originals = new Map()

  function getOriginal(layerId, allocate = true) {
    const existing = originals.get(layerId)
    if (existing || !allocate) return existing
    if ((originals.size + 2) * width * height > MAX_LAYER_BUFFER_PIXELS) {
      throw Object.assign(new Error('레이어용 메모리 한도에 도달했습니다. 현재 그림은 유지됩니다. 작은 작품을 사용하거나 필요한 레이어를 정리해 주세요.'), { code: 'canvas/layer-capacity' })
    }
    // DOM에 표시하지 않는 원본. 빈 레이어는 첫 펜 입력까지 버퍼를 만들지 않는다.
    const canvas = display.ownerDocument.createElement('canvas')
    canvas.width = width
    canvas.height = height
    try {
      prepareCanvas(canvas, width, height)
    } catch (error) {
      canvas.width = 0
      canvas.height = 0
      throw error
    }
    canvas.addEventListener('contextlost', onContextLost)
    originals.set(layerId, canvas)
    return canvas
  }

  function remove(layerId) {
    const canvas = originals.get(layerId)
    if (!canvas) return
    originals.delete(layerId)
    canvas.removeEventListener('contextlost', onContextLost)
    canvas.width = 0
    canvas.height = 0
  }

  function compose(layers, preview) {
    if (output.isContextLost?.()) throw canvasImageError('그림판 메모리를 복구하려면 그림을 다시 불러와 주세요.')
    output.clearRect(0, 0, width, height)
    // 목록은 위에서 아래다. 합성은 가장 뒤에 있는 레이어부터 그린다.
    try {
      for (let index = layers.length - 1; index >= 0; index--) {
        const { layerId, visible, opacity } = layers[index]
        const original = preview?.layerId === layerId ? preview.canvas : getOriginal(layerId, false)
        if (visible && opacity > 0 && original) {
          output.globalAlpha = opacity
          output.drawImage(original, 0, 0)
        }
      }
    } finally {
      output.globalAlpha = 1
    }
  }

  function release() {
    for (const layerId of originals.keys()) remove(layerId)
  }

  async function restore({ layers, contents }, signal) {
    signal.throwIfAborted()
    release()
    output.clearRect(0, 0, width, height)
    try {
      for (const content of contents) {
        signal.throwIfAborted()
        await restoreCanvasPng(getOriginal(content.layerId), content, width, height, signal)
      }
      signal.throwIfAborted()
      compose(layers)
    } catch (error) {
      release()
      throw error
    }
  }

  return { getOriginal, compose, restore, remove, release }
}
