const { inflateSync } = require('node:zlib')
const { createHash } = require('node:crypto')
const { HttpsError } = require('firebase-functions/v2/https')

const maxPngBytes = 8 * 1024 * 1024
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const magic = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = (n & 1 ? 0xedb88320 : 0) ^ (n >>> 1)
  return n
})

function validatePng(bytes, { hash, size }, { widthPx, heightPx }) {
  function invalid() { throw new HttpsError('invalid-argument', 'PNG의 원본 크기 또는 무결성을 확인하지 못했습니다.') }
  if (!Buffer.isBuffer(bytes) || bytes.length !== size || size < 45 || size > maxPngBytes
    || !bytes.subarray(0, 8).equals(magic) || sha256(bytes) !== hash) invalid()
  const chunks = []
  let rowBytes = 0
  let ended = false
  let afterImage = false
  let hasPalette = false
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset)
    const start = offset + 8
    const end = start + length
    if (end + 4 > bytes.length) invalid()
    const tag = bytes.toString('ascii', offset + 4, start)
    if (!/^[A-Za-z]{4}$/.test(tag)) invalid()
    let crc = 0xffffffff
    for (let i = offset + 4; i < end; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]) & 255]
    if (((crc ^ 0xffffffff) >>> 0) !== bytes.readUInt32BE(end)) invalid()
    if (tag === 'IHDR') {
      if (offset !== 8 || length !== 13 || bytes.readUInt32BE(start) !== widthPx
        || bytes.readUInt32BE(start + 4) !== heightPx || bytes[start + 8] !== 8
        || ![2, 6].includes(bytes[start + 9]) || bytes[start + 10] || bytes[start + 11] || bytes[start + 12]) invalid()
      rowBytes = widthPx * (bytes[start + 9] === 6 ? 4 : 3) + 1
    } else if (!rowBytes) invalid()
    else if (tag === 'IDAT') {
      if (afterImage) invalid()
      chunks.push(bytes.subarray(start, end))
    } else if (tag === 'PLTE') {
      if (hasPalette || chunks.length || !length || length % 3 || length > 768) invalid()
      hasPalette = true
    }
    else if (tag === 'IEND') {
      if (length || end + 4 !== bytes.length) invalid()
      ended = true
      break
    } else if (/^[A-Z]/.test(tag)) invalid()
    if (chunks.length && tag !== 'IDAT') afterImage = true
    offset = end + 4
  }
  if (!ended || !chunks.length) invalid()
  let raw
  try { raw = inflateSync(Buffer.concat(chunks), { maxOutputLength: rowBytes * heightPx }) } catch { invalid() }
  if (raw.length !== rowBytes * heightPx) invalid()
  for (let row = 0; row < heightPx; row++) if (raw[row * rowBytes] > 4) invalid()
}

module.exports = { maxPngBytes, sha256, validatePng }
