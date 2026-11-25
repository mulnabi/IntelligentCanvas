import * as ort from 'onnxruntime-web'
import modelUrl from './word_ocr.onnx?url'
import language from './ocr_bigrams.json'
import { findInkBounds } from './inkBounds.js'

ort.env.wasm.numThreads = 1
let session
const width = 896
const height = 112
const plane = width * height
const means = [0.485, 0.456, 0.406]
const deviations = [0.229, 0.224, 0.225]
const classCount = language.chars.length + 2
const pairs = new Map(language.pairs.map(([a, b, count]) => [a * classCount + b, count]))
const loopJamo = [['ᄋ', 'ᄆ'], ['ᆼ', 'ᆷ']]
  .filter(pair => pair.every(char => language.chars.includes(char)))
  .map(pair => pair.map(char => language.chars.indexOf(char) + 2))

async function deskew(bitmap, bounds) {
  if (bounds.width < 1.8 * bounds.height) return null

  const { default: cvModule } = await import('@techstark/opencv-js')
  const cv = await cvModule
  const scale = Math.min(1, width / bounds.width)
  const w = Math.max(1, Math.round(bounds.width * scale))
  const h = Math.max(1, Math.round(bounds.height * scale))
  const crop = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true })
  crop.drawImage(bitmap, bounds.x, bounds.y, bounds.width, bounds.height, 0, 0, w, h)
  const { data } = crop.getImageData(0, 0, w, h)
  const mask = new cv.Mat(h, w, cv.CV_8UC1)
  let angle
  try {
    const pixels = mask.data
    for (let i = 0; i < pixels.length; i++) {
      const p = i * 4
      pixels[i] = (255 - Math.min(data[p], data[p + 1], data[p + 2])) * data[p + 3] > 2550 ? 255 : 0
    }
    const { m00, mu11, mu20, mu02 } = cv.moments(mask, true)
    if (!m00 || mu20 <= mu02) return null
    angle = Math.atan2(2 * mu11, mu20 - mu02) / 2
  } finally {
    mask.delete()
  }
  const degrees = Math.abs(angle) * 180 / Math.PI
  if (degrees < 3 || degrees > 12) return null

  const sin = Math.abs(Math.sin(angle))
  const cos = Math.abs(Math.cos(angle))
  const rotated = new OffscreenCanvas(Math.ceil(w * cos + h * sin), Math.ceil(h * cos + w * sin))
  const ctx = rotated.getContext('2d', { willReadFrequently: true })
  ctx.translate(rotated.width / 2, rotated.height / 2)
  ctx.rotate(-angle)
  ctx.drawImage(crop.canvas, -w / 2, -h / 2)
  const ink = findInkBounds(ctx.getImageData(0, 0, rotated.width, rotated.height))
  return ink ? { image: rotated, bounds: ink } : null
}

async function prepare(bitmap) {
  const ctx = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true })
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, width, height)
  // 올가미 여백이 글씨를 작게 만들지 않도록 실제 획만 잘라 비율을 유지한다.
  const source = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')
  source.drawImage(bitmap, 0, 0)
  const bounds = findInkBounds(source.getImageData(0, 0, bitmap.width, bitmap.height))
  if (!bounds) return null
  const corrected = await deskew(bitmap, bounds).catch(() => null)
  const input = corrected?.bounds ?? bounds
  const scale = Math.min((width - 8) / input.width, (height - 8) / input.height)
  const w = Math.max(1, Math.round(input.width * scale))
  const h = Math.max(1, Math.round(input.height * scale))
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(corrected?.image ?? bitmap, input.x, input.y, input.width, input.height,
    4, Math.floor((height - h) / 2), w, h)
  const image = ctx.getImageData(0, 0, width, height)
  const rgba = image.data
  const data = new Float32Array(plane * 3)
  let hasInk = false
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < plane; i++) {
      const value = rgba[i * 4 + c]
      if (value < 255) hasInk = true
      data[c * plane + i] = (value / 255 - means[c]) / deviations[c]
    }
  }
  return hasInk ? { pixels: new ort.Tensor('float32', data, [1, 3, height, width]), image, bounds } : null
}

function findAmbiguousFrames(logits) {
  const frames = new Map()
  for (let start = 0; start < logits.length; start += classCount) {
    const row = logits.subarray(start, start + classCount)
    const best = Math.max(...row)
    const candidates = loopJamo.filter(([round, square]) =>
      Math.max(row[round], row[square]) === best && Math.abs(row[round] - row[square]) <= 0.9)
    if (candidates.length === 1) frames.set(start, candidates[0])
  }
  return frames
}

function applyLoopHints(logits, frames, loops) {
  let adjusted
  for (const [start, [round, square]] of frames) {
    const position = (start + classCount / 2) / logits.length
    const matches = loops.filter(({ left, right }) => left <= position && position <= right)
    if (matches.length !== 1) continue
    const preferred = matches[0].shape === 'round' ? round : square
    const other = preferred === round ? square : round
    if (logits[start + preferred] >= logits[start + other]) continue
    adjusted ??= logits.slice()
    adjusted[start + preferred] += 1.2
  }
  return adjusted
}

function logAdd(a, b) {
  if (a === -Infinity) return b
  if (b === -Infinity) return a
  return Math.max(a, b) + Math.log1p(Math.exp(-Math.abs(a - b)))
}

// Each time step adds the same log-softmax normalizer to every path.
// Ranking the beams using raw logits therefore gives the same transcription.
function decodeTokens(logits) {
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
  return beams[0].tokens
}

export function decodeWord(logits, adjustedLogits) {
  let tokens = decodeTokens(logits)
  if (adjustedLogits) {
    const adjusted = decodeTokens(adjustedLogits)
    // Keep the original sequence unless every edit is an ㅇ/ㅁ substitution.
    if (tokens.length === adjusted.length && tokens.every((id, index) =>
      id === adjusted[index] || loopJamo.some(pair => pair.includes(id) && pair.includes(adjusted[index])))) {
      tokens = adjusted
    }
  }
  return tokens.map(id => language.chars[id - 2] ?? '�').join('').normalize('NFC')
}

export async function recognizeWord(bitmap) {
  const input = await prepare(bitmap)
  if (!input) return { text: '', bounds: null }
  session ??= ort.InferenceSession.create(modelUrl, { executionProviders: ['wasm'] }).catch(error => {
    session = undefined
    throw error
  })
  const { logits } = await (await session).run({ pixels: input.pixels })
  const frames = findAmbiguousFrames(logits.data)
  let adjusted
  if (frames.size) {
    const loops = await import('./ocrLoopContours.js')
      .then(({ findOcrLoops }) => findOcrLoops(input.image)).catch(() => [])
    adjusted = applyLoopHints(logits.data, frames, loops)
  }
  return { text: decodeWord(logits.data, adjusted), bounds: input.bounds }
}
