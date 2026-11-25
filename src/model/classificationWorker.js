let queue = Promise.resolve()

async function fillRegion({ id, image, x, y }) {
  try {
    const { findFillRegion } = await import('./fillRegion')
    const result = await findFillRegion(image, x, y)
    self.postMessage({ id, result }, [result.mask.buffer])
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) })
  }
}

self.onmessage = ({ data: request }) => {
  const { id, kind, bitmap } = request
  if (kind === 'fill') {
    void fillRegion(request)
    return
  }
  queue = queue.then(async () => {
    try {
      if (kind === 'ocr') {
        const { recognizeWord } = await import('./wordOcr')
        self.postMessage({ id, result: await recognizeWord(bitmap) })
        return
      }
      if (kind === 'shape') {
        const { traceShape } = await import('./shapeContours')
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        ctx.drawImage(bitmap, 0, 0)
        const result = await traceShape(ctx.getImageData(0, 0, canvas.width, canvas.height))
        self.postMessage({ id, result }, result ? [result.eraseMask.buffer] : [])
        return
      }
      // 첫 요청을 받은 뒤 모델 초기화를 기다린다.
      const { predict, toolClassify } = await import('./model')
      const result = await (kind === 'tool' ? toolClassify : predict)(bitmap)
      self.postMessage({ id, result })
    } catch (error) {
      self.postMessage({ id, error: error instanceof Error ? error.message : String(error) })
    } finally {
      bitmap.close()
    }
  })
}
