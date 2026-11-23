let queue = Promise.resolve()

self.onmessage = ({ data: { id, kind, bitmap } }) => {
  queue = queue.then(async () => {
    try {
      let result
      if (kind === 'ocr') {
        const { recognizeWord } = await import('./wordOcr')
        result = await recognizeWord(bitmap)
      } else {
        const { predict, toolClassify } = await import('./model')
        result = await (kind === 'tool' ? toolClassify : predict)(bitmap)
      }
      self.postMessage({ id, result })
    } catch (error) {
      self.postMessage({ id, error: error instanceof Error ? error.message : String(error) })
    } finally {
      bitmap.close()
    }
  })
}
