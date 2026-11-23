let queue = Promise.resolve()

self.onmessage = ({ data: { id, kind, bitmap } }) => {
  queue = queue.then(async () => {
    try {
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
