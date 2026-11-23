import { predict, toolClassify } from './model'

let queue = Promise.resolve()

self.onmessage = ({ data: { id, kind, bitmap } }) => {
  queue = queue.then(async () => {
    try {
      const result = await (kind === 'tool' ? toolClassify : predict)(bitmap)
      self.postMessage({ id, result })
    } catch (error) {
      self.postMessage({ id, error: error instanceof Error ? error.message : String(error) })
    } finally {
      bitmap.close()
    }
  })
}
