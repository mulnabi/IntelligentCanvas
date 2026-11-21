const { randomUUID } = require('node:crypto')
const { FieldPath, FieldValue, Timestamp } = require('firebase-admin/firestore')
const { getAuth } = require('firebase-admin/auth')
const { getStorage } = require('firebase-admin/storage')
const { HttpsError } = require('firebase-functions/v2/https')
const { getLocalApp, getLocalFirestore } = require('../repositories/localFirestore')
const { withArtworkSession } = require('../repositories/editSessionRepository')
const { requireCallable, holdsSession, validProof } = require('./editSessions')
const { maxPngBytes, sha256, validatePng } = require('./syncPng')
const { buildRevision } = require('./artworkRevisions')

const validId = value => typeof value === 'string' && /^[\w-]{1,128}$/.test(value) && !Object.hasOwn(Object.prototype, value)
const integer = (n, min, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(n) && n >= min && n <= max
const invalid = message => new HttpsError('invalid-argument', message)
const conflict = () => new HttpsError('failed-precondition', '세션 또는 서버 버전이 달라 동기화를 중단했습니다.')
const missing = () => new HttpsError('not-found', '확정된 서버 작품을 찾지 못했습니다.')
const artworkRef = (uid, id) => getLocalFirestore().collection('users').doc(uid).collection('artworks').doc(id)
const root = (uid, id) => `users/${uid}/artworks/${id}`

function bucket() {
  const app = getLocalApp()
  if (process.env.FIREBASE_STORAGE_EMULATOR_HOST !== '127.0.0.1:9199'
    || process.env.STORAGE_EMULATOR_HOST !== 'http://127.0.0.1:9199') {
    // SDK는 STORAGE_EMULATOR_HOST를 사용한다. 분리 실행 시 Firebase가 주입한 URL도 확인한다.
    if (process.env.FIREBASE_STORAGE_EMULATOR_HOST !== '127.0.0.1:9199'
      || process.env.CLOUD_STORAGE_EMULATOR_HOST !== 'http://127.0.0.1:9199') throw conflict()
    process.env.STORAGE_EMULATOR_HOST = 'http://127.0.0.1:9199'
  }
  return getStorage(app).bucket('intelligentcanvas-stage5a-local.invalid')
}

function normalizeMeta(meta) {
  const { title, widthPx, heightPx, backgroundColor } = meta || {}
  if (typeof title !== 'string' || !title.trim() || title.length > 200
    || !integer(widthPx, 1, 8192) || !integer(heightPx, 1, 8192) || widthPx * heightPx > 16_777_216
    || typeof backgroundColor !== 'string' || !/^#[0-9a-f]{6}$/i.test(backgroundColor)) throw invalid('작품 메타데이터를 확인해 주세요.')
  return { title: title.trim(), widthPx, heightPx, backgroundColor }
}

function normalizeLayers(layers) {
  if (!Array.isArray(layers) || !layers.length || layers.length > 64) throw invalid('레이어는 1~64개여야 합니다.')
  const ids = new Set()
  return layers.map((row, sortOrder) => {
    const { layerId, name, opacity, visible, isTemporary, category, image } = row || {}
    if (!validId(layerId) || ids.has(layerId) || typeof name !== 'string' || !name.trim() || name.length > 80
      || !Number.isFinite(opacity) || opacity < 0 || opacity > 1 || typeof visible !== 'boolean'
      || typeof isTemporary !== 'boolean' || !(category === null || typeof category === 'string' && category.length <= 80)
      || (image !== null && (!image || typeof image.hash !== 'string' || !/^[a-f0-9]{64}$/.test(image.hash)
        || !integer(image.size, 45, maxPngBytes)))) throw invalid('레이어 또는 PNG 정보가 올바르지 않습니다.')
    ids.add(layerId)
    return { layerId, name, sortOrder, opacity, visible, isTemporary, category, image: image ? { hash: image.hash, size: image.size } : null }
  })
}

const createServerArtwork = requireCallable(['meta'], async (uid, { artworkId, meta }) => {
  const model = normalizeMeta(meta)
  const ref = artworkRef(uid, artworkId)
  return ref.firestore.runTransaction(async tx => {
    const current = await tx.get(ref)
    if (current.exists) {
      const data = current.data()
      if (data.ownerUid !== uid || data.state === 'deleted' || !data.publication) throw conflict()
      return { serverVersion: data.serverVersion, publication: data.publication }
    }
    const now = FieldValue.serverTimestamp()
    tx.create(ref, { ...model, artworkId, ownerUid: uid, state: 'active', publication: 'pending',
      serverVersion: 0, schemaVersion: 1, createdAt: now, updatedAt: now })
    return { serverVersion: 0, publication: 'pending' }
  })
})

function withSave(uid, data, op, editing = true) {
  if (!validId(data.requestId) || !validProof(data.proof)) throw invalid('저장 요청 또는 편집 자격 증명을 확인해 주세요.')
  return withArtworkSession(uid, data.artworkId, async (session, _, context) => {
    if (!holdsSession(session, data.proof)) throw new HttpsError('permission-denied', '현재 세션 자격 증명이 필요합니다.')
    if (editing && session.localChangesPending !== true) throw conflict()
    if (!context.data.publication) throw conflict()
    const ref = context.artwork.collection('saveReceipts').doc(data.requestId)
    const receipt = (await context.tx.get(ref)).data()
    if (receipt && receipt.sessionId !== session.sessionId) throw conflict()
    return op({ ...context, held: session, ref, receipt })
  })
}

function validatePrepared(context, requestId) {
  const { receipt, data, held } = context
  if (!receipt || receipt.status !== 'prepared' || receipt.expectedServerVersion !== data.serverVersion
    || held.openRequestId !== requestId) throw conflict()
}

const prepareArtworkSave = requireCallable(['proof', 'requestId', 'expectedServerVersion', 'localVersion', 'meta', 'layers'], (uid, input) => {
  const { requestId, expectedServerVersion, localVersion } = input
  if (!integer(expectedServerVersion, 0) || !integer(localVersion, 1)) throw invalid('저장 버전을 확인해 주세요.')
  const meta = normalizeMeta(input.meta)
  const layers = normalizeLayers(input.layers)
  const fingerprint = sha256(JSON.stringify({ expectedServerVersion, localVersion, meta, layers }))
  return withSave(uid, input, context => {
    const { tx, data, held, ref, receipt, session } = context
    if (receipt?.fingerprint !== undefined && receipt.fingerprint !== fingerprint) throw conflict()
    if (receipt?.status === 'committed') return { committed: receipt.result }
    if (data.widthPx !== meta.widthPx || data.heightPx !== meta.heightPx) throw invalid('동기화 중 작품의 원본 크기를 바꿀 수 없습니다.')
    if (data.serverVersion !== expectedServerVersion || (held.openRequestId && held.openRequestId !== requestId)
      || localVersion <= (held.lastCommit?.localVersion ?? 0)) throw conflict()
    const previous = new Map((data.layerManifest ?? []).map(layer => [layer.layerId, layer]))
    const uploads = layers.filter(layer => {
      const image = previous.get(layer.layerId)?.image
      return layer.image && (image?.hash !== layer.image.hash || image.size !== layer.image.size)
    }).map(layer => layer.layerId)
    if (!receipt) {
      tx.create(ref, { status: 'prepared', fingerprint, expectedServerVersion, localVersion, meta, layers,
        uploads, stage: {}, sessionId: held.sessionId, preparedAt: FieldValue.serverTimestamp() })
      tx.update(session, { openRequestId: requestId })
    }
    return { uploadLayerIds: uploads.filter(id => !receipt?.stage?.[id]) }
  })
})

async function uploadPng(uid, input, bytes) {
  if (!validId(input.artworkId) || !validId(input.layerId)) throw invalid('작품과 레이어를 확인해 주세요.')
  const plan = await withSave(uid, input, context => {
    validatePrepared(context, input.requestId)
    if (!context.receipt.uploads.includes(input.layerId)) throw invalid('업로드가 예약된 레이어만 보낼 수 있습니다.')
    return context.receipt
  })
  if (!plan) throw missing()
  const layer = plan.layers.find(row => row.layerId === input.layerId)
  validatePng(bytes, layer.image, plan.meta)
  if (plan.stage[input.layerId]) return { uploaded: true }
  // 요청·레이어가 같아도 동시 업로드는 각자의 새 경로에 쓴다.
  const path = `${root(uid, input.artworkId)}/staging/${input.requestId}/${input.layerId}/${randomUUID()}/raster.png`
  await bucket().file(path).save(bytes, { resumable: false, contentType: 'image/png', preconditionOpts: { ifGenerationMatch: 0 } })
  const result = await withSave(uid, input, context => {
    validatePrepared(context, input.requestId)
    if (!context.receipt.stage[input.layerId]) context.tx.update(context.ref, {
      stage: { ...context.receipt.stage, [input.layerId]: path },
    })
    return { uploaded: true }
  })
  if (!result) throw missing()
  return result
}

const finalizeArtworkSave = requireCallable(['proof', 'requestId'], async (uid, input) => {
  const prepared = await withSave(uid, input, context => {
    if (context.receipt?.status === 'committed') return { committed: context.receipt.result }
    validatePrepared(context, input.requestId)
    return { plan: context.receipt, previous: context.data.layerManifest ?? [] }
  })
  if (!prepared || prepared.committed) return prepared?.committed ?? null
  const { plan, previous } = prepared
  if (plan.uploads.some(id => !plan.stage[id])) throw new HttpsError('failed-precondition', '아직 업로드하지 않은 PNG가 있습니다.')
  const previousById = new Map(previous.map(layer => [layer.layerId, layer]))
  const manifest = []
  for (const layer of plan.layers) {
    if (!layer.image) manifest.push({ ...layer, pngPath: null, currentRevisionId: null })
    else if (!plan.uploads.includes(layer.layerId)) {
      const old = previousById.get(layer.layerId)
      manifest.push({ ...layer, pngPath: old.pngPath, currentRevisionId: old.currentRevisionId })
    } else {
      const [bytes] = await bucket().file(plan.stage[layer.layerId]).download()
      validatePng(bytes, layer.image, plan.meta)
      const currentRevisionId = randomUUID()
      const pngPath = `${root(uid, input.artworkId)}/layers/${layer.layerId}/${currentRevisionId}/raster.png`
      await bucket().file(pngPath).save(bytes, { resumable: false, contentType: 'image/png', preconditionOpts: { ifGenerationMatch: 0 } })
      manifest.push({ ...layer, pngPath, currentRevisionId })
    }
  }
  return withSave(uid, input, context => {
    if (context.receipt?.status === 'committed') return context.receipt.result
    validatePrepared(context, input.requestId)
    const { tx, data, artwork, session, ref } = context
    const result = { requestId: input.requestId, localVersion: plan.localVersion, serverVersion: data.serverVersion + 1 }
    const now = FieldValue.serverTimestamp()
    const revision = buildRevision(data, plan.meta, manifest, result, now)
    tx.update(artwork, { ...plan.meta, publication: 'ready', layerManifest: manifest, serverVersion: result.serverVersion, updatedAt: now })
    const nextIds = new Set(manifest.map(layer => layer.layerId))
    for (const layer of previous) if (!nextIds.has(layer.layerId)) tx.delete(artwork.collection('layers').doc(layer.layerId))
    for (const layer of manifest) tx.set(artwork.collection('layers').doc(layer.layerId), { ...layer, updatedAt: now })
    if (revision) tx.create(artwork.collection('revisions').doc(revision.revisionId), revision)
    tx.set(ref, { status: 'committed', result, fingerprint: plan.fingerprint, sessionId: plan.sessionId, committedAt: now })
    tx.update(session, { lastCommit: result, openRequestId: FieldValue.delete(), updatedAt: now })
    return result
  })
})

const publicArtwork = data => ({
  artworkId: data.artworkId, title: data.title, widthPx: data.widthPx, heightPx: data.heightPx,
  backgroundColor: data.backgroundColor, serverVersion: data.serverVersion,
  createdAt: data.createdAt?.toMillis() ?? 0, updatedAt: data.updatedAt?.toMillis() ?? 0,
})

async function getReady(uid, id) {
  const snap = await artworkRef(uid, id).get()
  const data = snap.data()
  if (data?.ownerUid !== uid || data.publication !== 'ready' || data.state === 'deleted') throw missing()
  return data
}

const getServerArtwork = requireCallable([], async (uid, { artworkId }) => {
  const data = await getReady(uid, artworkId)
  return { ...publicArtwork(data), layers: data.layerManifest.map(({ pngPath: _path, ...layer }) => layer) }
})

const deleteServerArtwork = requireCallable(['requestId', 'expectedServerVersion'], (uid, { artworkId, requestId, expectedServerVersion }) => {
  if (!validId(requestId) || !integer(expectedServerVersion, 1)) throw invalid('삭제 요청과 작품 버전을 확인해 주세요.')
  const ref = artworkRef(uid, artworkId)
  return ref.firestore.runTransaction(async tx => {
    const data = (await tx.get(ref)).data()
    if (data?.ownerUid !== uid || data.publication !== 'ready') throw missing()
    const result = { artworkId, serverVersion: expectedServerVersion + 1 }
    if (data.state === 'deleted') {
      if (data.deletion?.requestId === requestId && data.serverVersion === result.serverVersion) return result
      throw conflict()
    }
    if (data.state !== 'active' || data.serverVersion !== expectedServerVersion
      || !integer(result.serverVersion, 2)) throw conflict()
    const session = await tx.get(ref.collection('editSession').doc('current'))
    if (session.exists && (session.get('status') !== 'released' || session.get('localChangesPending') || session.get('openRequestId'))) {
      throw new HttpsError('failed-precondition', '서버 저장을 마치고 편집 세션을 반납한 뒤 삭제해 주세요.')
    }
    const now = FieldValue.serverTimestamp()
    tx.update(ref, { state: 'deleted', deletedAt: now, updatedAt: now, serverVersion: result.serverVersion,
      deletion: { requestId } })
    return result
  })
})

async function getDeletedServerArtworks(request) {
  const uid = request.auth?.uid
  if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.')
  const ids = request.data?.artworkIds
  if (!Array.isArray(ids) || !ids.length || ids.length > 40 || !ids.every(validId)) {
    throw invalid('삭제 상태를 확인할 작품을 지정해 주세요.')
  }
  const snapshots = await getLocalFirestore().getAll(...[...new Set(ids)].map(id => artworkRef(uid, id)),
    { fieldMask: ['ownerUid', 'state', 'serverVersion'] })
  return snapshots.filter(row => row.get('ownerUid') === uid && row.get('state') === 'deleted')
    .map(row => ({ artworkId: row.id, serverVersion: row.get('serverVersion') }))
}

const listArtworkRevisions = requireCallable([], async (uid, { artworkId }) => {
  await getReady(uid, artworkId)
  const recent = await artworkRef(uid, artworkId).collection('revisions').orderBy('serverVersion', 'desc').limit(30).get()
  return recent.docs.map(doc => {
    const row = doc.data()
    return { ...row, createdAt: row.createdAt.toMillis() }
  })
})

// 분리된 staging 경로의 확정/폐기 요청만 정리한다. 확정 원본 경로는 검사 대상에도 포함하지 않는다.
const cleanupArtworkStaging = requireCallable(['requestId', 'execute'], async (uid, { artworkId, requestId, execute }) => {
  if (!validId(requestId) || (execute !== undefined && typeof execute !== 'boolean')) throw invalid('정리할 요청을 확인해 주세요.')
  const prefix = `${root(uid, artworkId)}/staging/${requestId}/`
  const candidatePaths = await withArtworkSession(uid, artworkId, async (held, _, { tx, artwork, data }) => {
    const receipt = (await tx.get(artwork.collection('saveReceipts').doc(requestId))).data()
    const closedAt = receipt?.status === 'committed' ? receipt.committedAt
      : receipt?.status === 'abandoned' ? receipt.abandonedAt : null
    if (!closedAt || held?.openRequestId === requestId || Date.now() - closedAt.toMillis() < 86_400_000) return false
    return (data.layerManifest ?? []).map(layer => layer.pngPath)
  })
  if (candidatePaths === null) throw missing()
  if (candidatePaths === false) return { eligible: false, candidates: 0, deleted: 0, skipped: 0, more: false }
  const referenced = new Set(candidatePaths)
  const [files, next] = await bucket().getFiles({ prefix, autoPaginate: false, maxResults: 200 })
  const candidates = files.filter(file => file.name.startsWith(prefix) && !referenced.has(file.name)
    && /^[\w-]{1,128}\/[a-f0-9-]{36}\/raster\.png$/.test(file.name.slice(prefix.length))
    && /^\d+$/.test(file.metadata.generation ?? ''))
  let deleted = 0
  let skipped = 0
  if (execute === true) {
    for (const file of candidates) {
      try {
        await file.delete({ ifGenerationMatch: file.metadata.generation })
        deleted++
      } catch (error) {
        if (![404, 412].includes(Number(error.code))) throw error
        skipped++
      }
    }
  }
  return { eligible: true, candidates: candidates.length, deleted, skipped, more: Boolean(next) }
})

async function listServerArtworks(request) {
  const uid = request.auth?.uid
  if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.')
  const { sort = 'updatedAt', cursor = null } = request.data ?? {}
  if (!['updatedAt', 'createdAt', 'title'].includes(sort)) throw invalid('서버 작품 정렬을 확인해 주세요.')
  const direction = sort === 'title' ? 'asc' : 'desc'
  let query = getLocalFirestore().collection('users').doc(uid).collection('artworks')
    .where('ownerUid', '==', uid).where('state', '==', 'active').where('publication', '==', 'ready')
    .orderBy(sort, direction).orderBy(FieldPath.documentId(), direction)
  if (cursor !== null) {
    if (!cursor || cursor.sort !== sort || cursor.uid !== uid || !validId(cursor.id)) throw invalid('목록 위치를 확인해 주세요.')
    let value = cursor.value
    if (sort === 'title') {
      if (typeof value !== 'string' || value.length > 200) throw invalid('목록 위치를 확인해 주세요.')
    } else {
      if (!Number.isSafeInteger(value?.seconds) || !integer(value?.nanoseconds, 0, 999_999_999)
        || value.seconds < -62_135_596_800 || value.seconds > 253_402_300_799) throw invalid('목록 시각을 확인해 주세요.')
      value = new Timestamp(value.seconds, value.nanoseconds)
    }
    query = query.startAfter(value, cursor.id)
  }
  const pageSize = 20
  const snap = await query.select('artworkId', 'title', 'widthPx', 'heightPx', 'backgroundColor',
    'serverVersion', 'createdAt', 'updatedAt').limit(pageSize + 1).get()
  const page = snap.docs.slice(0, pageSize)
  let nextCursor = null
  if (snap.size > pageSize) {
    const last = page.at(-1)
    const value = last.get(sort)
    nextCursor = { uid, sort, id: last.id,
      value: sort === 'title' ? value : { seconds: value.seconds, nanoseconds: value.nanoseconds } }
  }
  return { rows: page.map(doc => publicArtwork(doc.data())), nextCursor }
}

function binary(method, operation) {
  return async (req, res) => {
    try {
      if (req.method !== method) return res.sendStatus(405)
      const authorization = /^Bearer (\S+)$/.exec(req.get('Authorization') || '')
      let uid
      try { if (authorization) uid = (await getAuth(getLocalApp()).verifyIdToken(authorization[1])).uid } catch { /* 응답에 토큰 정보 없음 */ }
      if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.')
      await operation(uid, req, res)
    } catch (error) {
      if (error instanceof HttpsError) return res.status(error.httpErrorCode.status).json({ code: error.code, message: error.message })
      return res.status(503).json({ code: 'unavailable', message: '파일을 처리하지 못했습니다. 다시 시도해 주세요.' })
    }
  }
}

const uploadArtworkPng = binary('POST', async (uid, req, res) => {
  if (req.get('Content-Type') !== 'image/png') throw invalid('PNG 원본만 업로드할 수 있습니다.')
  let proof
  try { proof = JSON.parse(req.get('X-Edit-Proof') || '') } catch { throw invalid('편집 자격 증명을 확인해 주세요.') }
  res.json(await uploadPng(uid, { ...req.query, proof }, req.rawBody))
})

const downloadArtworkPng = binary('GET', async (uid, req, res) => {
  const { artworkId, layerId, version } = req.query
  if (!validId(artworkId) || !validId(layerId) || typeof version !== 'string' || !/^\d+$/.test(version)) throw invalid('레이어 경로를 확인해 주세요.')
  const data = await getReady(uid, artworkId)
  if (String(data.serverVersion) !== version) throw conflict()
  const layer = data.layerManifest.find(row => row.layerId === layerId)
  if (!layer?.pngPath) throw missing()
  const [bytes] = await bucket().file(layer.pngPath).download()
  validatePng(bytes, layer.image, data)
  res.set('Cache-Control', 'no-store').type('image/png').send(bytes)
})

module.exports = { createServerArtwork, prepareArtworkSave, finalizeArtworkSave, listServerArtworks, getServerArtwork,
  deleteServerArtwork, getDeletedServerArtworks,
  listArtworkRevisions, cleanupArtworkStaging,
  uploadArtworkPng, downloadArtworkPng }
