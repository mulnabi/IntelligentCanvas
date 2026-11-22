import * as ort from 'onnxruntime-web/wasm'
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url'
import encoderUrl from './vit_encoder.onnx?url'
import headUrl from './vit_head.onnx?url'

ort.env.wasm.numThreads = 1
// The WASM-only bundle embeds its matching JavaScript loader.
ort.env.wasm.wasmPaths = { wasm: wasmUrl }

let sessions
function loadSessions() {
  sessions ??= (async () => {
    const encoder = await ort.InferenceSession.create(encoderUrl, { executionProviders: ['wasm'] })
    try {
      const head = await ort.InferenceSession.create(headUrl, { executionProviders: ['wasm'] })
      return { encoder, head }
    } catch (error) {
      await encoder.release()
      throw error
    }
  })().catch(error => {
    sessions = undefined
    throw error
  })
  return sessions
}

function imageToTensor(canvas) {
  const temp = new OffscreenCanvas(224,224)
  const ctx = temp.getContext('2d', {willReadFrequently: true})

  ctx.fillStyle = 'white'
  ctx.fillRect(0,0,224,224)

  const scale = Math.min(224/canvas.width,224/canvas.height)
  const w = canvas.width*scale
  const h = canvas.height*scale

  ctx.drawImage(canvas,(224-w)/2,(224-h)/2,w,h)

  const pixels = ctx.getImageData(0,0,224,224).data
  const data = new Float32Array(3*224*224)

  for (let i = 0; i < 224*224; i++) {
    data[i] = pixels[i*4]/127.5-1
    data[i+224*224] = pixels[i*4+1]/127.5-1
    data[i+224*224*2] = pixels[i*4+2]/127.5-1
  }
  return new ort.Tensor('float32',data,[1,3,224,224])
}

export async function predict(input, isCurrent) {
  if (!isCurrent()) return
  const tensor = imageToTensor(input)
  const { encoder, head } = await loadSessions()
  if (!isCurrent()) return
  const encoded = await encoder.run({
    [encoder.inputNames[0]]: tensor
  })
  if (!isCurrent()) return
  const classified = await head.run({
    [head.inputNames[0]]: encoded[encoder.outputNames[0]]
  })
  const output = classified[head.outputNames[0]].data
  return output.indexOf(Math.max(...output))
}
