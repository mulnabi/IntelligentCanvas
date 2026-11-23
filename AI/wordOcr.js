import * as ort from 'onnxruntime-web'
import modelUrl from './word_ocr.onnx?url'
import language from './ocr_bigrams.json'
import { findInkBounds } from './inkBounds'

ort.env.wasm.numThreads = 1
let session
const width = 896
const height = 112
const plane = width * height
const means = [0.485, 0.456, 0.406]
const deviations = [0.229, 0.224, 0.225]
const classCount = language.chars.length + 2
const pairs = new Map(language.pairs.map(([a, b, count]) => [a * classCount + b, count]))

function prepare(bitmap) {
  const ctx = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true })
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, width, height)
  // 올가미 여백이 글씨를 작게 만들지 않도록 실제 획만 잘라 비율을 유지한다.
  const source = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')
  source.drawImage(bitmap, 0, 0)
  const bounds = findInkBounds(source.getImageData(0, 0, bitmap.width, bitmap.height))
  if (!bounds) return null
  const scale = Math.min((width - 8) / bounds.width, (height - 8) / bounds.height)
  const w = Math.max(1, Math.round(bounds.width * scale))
  const h = Math.max(1, Math.round(bounds.height * scale))
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, bounds.x, bounds.y, bounds.width, bounds.height,
    4, Math.floor((height - h) / 2), w, h)
  const rgba = ctx.getImageData(0, 0, width, height).data
  const data = new Float32Array(plane * 3)
  let hasInk = false
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < plane; i++) {
      const value = rgba[i * 4 + c]
      if (value < 255) hasInk = true
      data[c * plane + i] = (value / 255 - means[c]) / deviations[c]
    }
  }
  return hasInk ? new ort.Tensor('float32', data, [1, 3, height, width]) : null
}

function logAdd(a, b) {
  if (a === -Infinity) return b
  if (b === -Infinity) return a
  return Math.max(a, b) + Math.log1p(Math.exp(-Math.abs(a - b)))
}

// Each time step adds the same log-softmax normalizer to every path.
// Ranking the beams using raw logits therefore gives the same transcription.
export function decodeWord(logits) {
  let beams = [{ tokens: [], blank: 0, text: -Infinity }]
  for (let start = 0; start < logits.length; start += classCount) {
    const row = logits.subarray(start, start + classCount)
    const ids = Array.from(row.keys()).sort((a, b) => row[b] - row[a]).slice(0, 8)
    const candidates = new Map()
    function add(tokens, blank, text) {
      const key = tokens.join(',')
      const old = candidates.get(key)
      if (old) {
        old.blank = logAdd(old.blank, blank)
        old.text = logAdd(old.text, text)
      } else candidates.set(key, { tokens, blank, text })
    }
    for (const beam of beams) {
      const total = logAdd(beam.blank, beam.text)
      const last = beam.tokens.at(-1) ?? -1
      add(beam.tokens, total + row[0], -Infinity)
      for (const id of ids) {
        if (id === 0) continue
        const count = (pairs.get(last * classCount + id) ?? 0) + 0.1
        const denominator = (language.totals[last] ?? 0) + 0.1 * classCount
        const bonus = 0.15 * (Math.log(count / denominator) + 3.5)
        if (id === last) add(beam.tokens, -Infinity, beam.text + row[id])
        add([...beam.tokens, id], -Infinity, (id === last ? beam.blank : total) + row[id] + bonus)
      }
    }
    beams = [...candidates.values()].sort((a, b) =>
      logAdd(b.blank, b.text) - logAdd(a.blank, a.text)).slice(0, 10)
  }
  return beams[0].tokens.map(id => language.chars[id - 2] ?? '�').join('').normalize('NFC')
}

export async function recognizeWord(bitmap) {
  const pixels = prepare(bitmap)
  if (!pixels) return ''
  session ??= ort.InferenceSession.create(modelUrl, { executionProviders: ['wasm'] }).catch(error => {
    session = undefined
    throw error
  })
  const { logits } = await (await session).run({ pixels })
  return decodeWord(logits.data)
}
