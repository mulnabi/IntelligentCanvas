import * as ort from 'onnxruntime-web'
import modelUrl from './ocr_korean.onnx?url'
import dictionary from './ppocrv5_korean_dict.txt?raw'

ort.env.wasm.numThreads = 1
const chars = ['', ...dictionary.replace(/\r?\n$/, '').split(/\r?\n/), ' ']
let session

function whiteCanvas(width, height) {
  const ctx = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true })
  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, width, height)
  return ctx
}

function prepare(bitmap) {
  const source = whiteCanvas(bitmap.width, bitmap.height)
  source.drawImage(bitmap, 0, 0)
  const { width, height, data } = source.getImageData(0, 0, bitmap.width, bitmap.height)
  let left = width, top = height, right = -1, bottom = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = 4 * (y * width + x)
      if (data[i] === 255 && data[i+1] === 255 && data[i+2] === 255) continue
      left = Math.min(left, x)
      right = Math.max(right, x)
      top = Math.min(top, y)
      bottom = y
    }
  }
  if (right < 0) return null
  const w = right-left+1, h = bottom-top+1
  const pad = Math.max(1, Math.round(h * .06))
  const outWidth = Math.min(3200, Math.max(8, Math.ceil(48 * (w+2*pad)/(h+2*pad))))
  const ctx = whiteCanvas(outWidth, 48)
  const sx = outWidth/(w+2*pad), sy = 48/(h+2*pad)
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source.canvas, left, top, w, h, pad*sx, pad*sy, w*sx, h*sy)
  const rgba = ctx.getImageData(0,0,outWidth,48).data
  const plane = outWidth*48
  const input = new Float32Array(plane*3)
  for (let c=0; c<3; c++) {
    for (let i=0; i<plane; i++) input[c*plane+i] = rgba[i*4+2-c]/127.5-1
  }
  return new ort.Tensor('float32', input, [1,3,48,outWidth])
}

export function decodeWord(data, count) {
  if (count !== chars.length) throw new Error('OCR 문자 사전이 모델과 일치하지 않습니다.')
  let previous = 0, text = ''
  for (let i=0; i<data.length; i+=count) {
    let best = 0
    for (let j=1; j<count; j++) if (data[i+j]>data[i+best]) best=j
    if (best !== previous) text += chars[best]
    previous=best
  }
  return text.trim().normalize('NFC')
}

export async function recognizeWord(bitmap) {
  const input = prepare(bitmap)
  if (!input) return ''
  session ??= ort.InferenceSession.create(modelUrl, {executionProviders:['wasm']}).catch(error=>{
    session=undefined
    throw error
  })
  const model=await session
  const values=await model.run({[model.inputNames[0]]:input})
  const output=values[model.outputNames[0]]
  return decodeWord(output.data,output.dims[2])
}
