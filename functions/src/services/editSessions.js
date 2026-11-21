const { createHash, randomBytes, randomUUID, timingSafeEqual } = require('node:crypto')
const { FieldValue } = require('firebase-admin/firestore')
const { HttpsError } = require('firebase-functions/v2/https')
const { localAdminAvailable } = require('../repositories/localFirestore')
const { withArtworkSession } = require('../repositories/editSessionRepository')

const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
const digest = secret => createHash('sha256').update(secret).digest()
const validProof = value => value && id(value.sessionId) && id(value.deviceId)
  && Number.isSafeInteger(value.generation) && value.generation > 0
  && typeof value.token === 'string' && /^[a-zA-Z0-9_-]{43}$/.test(value.token)
  && Object.keys(value).length === 4

function holdsSession(session, proof) {
  return session?.status === 'active' && proof && session.sessionId === proof.sessionId
    && session.deviceId === proof.deviceId && session.generation === proof.generation
    && /^[a-f0-9]{64}$/.test(session.tokenHash)
    && timingSafeEqual(Buffer.from(session.tokenHash, 'hex'), digest(proof.token))
}

function callable(fields, operation) {
  return async request => {
    const uid = request.auth?.uid
    if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.')
    if (!localAdminAvailable()) throw new HttpsError('failed-precondition', '로컬 Emulator 연결이 필요합니다.')
    const data = request.data
    if (!data || Array.isArray(data) || typeof data !== 'object' || !id(data.artworkId)
      || Object.keys(data).some(key => key !== 'artworkId' && !fields.includes(key))
      || (fields.includes('deviceId') && !id(data.deviceId))
      || (data.proof !== undefined && !validProof(data.proof))) {
      throw new HttpsError('invalid-argument', '작품 또는 세션 정보가 올바르지 않습니다.')
    }
    const result = await operation(uid, data)
    if (result === null) throw new HttpsError('not-found', '편집할 수 있는 서버 작품을 찾지 못했습니다.')
    return result
  }
}

function issueSession(deviceId, operation) {
  // 트랜잭션이 재실행되어도 이 호출의 자격 증명은 동일하다.
  const token = randomBytes(32).toString('base64url')
  const sessionId = randomUUID()
  return operation((session, set) => {
    const generation = (session?.generation ?? 0) + 1
    if (!Number.isSafeInteger(generation) || generation < 1) throw new HttpsError('failed-precondition', '세션 세대를 확인하지 못했습니다.')
    const time = FieldValue.serverTimestamp()
    set({ sessionId, deviceId, generation, status: 'active', tokenHash: digest(token).toString('hex'),
      localChangesPending: false, acquiredAt: time, updatedAt: time })
    return { sessionId, deviceId, generation, token }
  })
}

const acquireEditSession = callable(['deviceId'], (uid, { artworkId, deviceId }) => {
  return issueSession(deviceId, issue => withArtworkSession(uid, artworkId, (session, set) => {
    if (session && session.status !== 'released') throw new HttpsError('already-exists', '다른 세션에서 편집 중입니다.')
    return issue(session, set)
  }))
})

const sessionRef = session => digest(session.sessionId).toString('hex')
const getEditSessionStatus = callable(['proof', 'details'], (uid, { artworkId, proof, details }) =>
  withArtworkSession(uid, artworkId, (session, _, { data }) => {
    const active = session?.status === 'active'
    const held = active && holdsSession(session, proof)
    const response = held ? { status: 'held', localChangesPending: session.localChangesPending === true }
      : { status: active ? 'occupied' : 'available' }
    if (details !== true) return response
    return { ...response, ...(held ? { openRequestId: session.openRequestId ?? null } : {}), serverVersion: data.serverVersion ?? null,
      generation: session?.generation ?? 0, sessionRef: active ? sessionRef(session) : null,
      canRecover: active && !held && data.publication === 'ready' }
  }))

const forceRecoverEditSession = callable(['deviceId', 'confirmed', 'sessionRef', 'generation'], (uid, input) => {
  if (input.confirmed !== true || typeof input.sessionRef !== 'string' || !/^[a-f0-9]{64}$/.test(input.sessionRef)
    || !Number.isSafeInteger(input.generation) || input.generation < 1) {
    throw new HttpsError('invalid-argument', '현재 편집 세션의 강제 복구를 확인해 주세요.')
  }
  return issueSession(input.deviceId, issue => withArtworkSession(uid, input.artworkId, async (session, set, { tx, artwork, data }) => {
    if (data.publication !== 'ready' || session?.status !== 'active'
      || session.generation !== input.generation || sessionRef(session) !== input.sessionRef) {
      throw new HttpsError('failed-precondition', '편집 세션이 바뀌었습니다. 상태를 확인한 뒤 다시 선택해 주세요.')
    }
    if (session.openRequestId) {
      const ref = artwork.collection('saveReceipts').doc(session.openRequestId)
      const receipt = (await tx.get(ref)).data()
      if (receipt?.status === 'prepared' && receipt.sessionId === session.sessionId) {
        tx.update(ref, { status: 'abandoned', abandonedAt: FieldValue.serverTimestamp() })
      }
    }
    const proof = issue(session, set)
    tx.create(artwork.collection('sessionRecoveries').doc(String(proof.generation)), {
      previousSessionRef: input.sessionRef, previousGeneration: session.generation,
      generation: proof.generation, createdAt: FieldValue.serverTimestamp(),
    })
    return proof
  }))
})

function holderOperation(operation, fields = []) {
  return callable(['proof', ...fields], (uid, { artworkId, proof, ...input }) =>
    withArtworkSession(uid, artworkId, (session, set, context) => {
      if (!holdsSession(session, proof)) throw new HttpsError('permission-denied', '현재 편집 세션을 확인할 수 없습니다.')
      return operation(session, set, context, input)
    }))
}

const beginEditSessionChanges = holderOperation((session, set, { data }, { expectedServerVersion }) => {
  if (data.publication && data.serverVersion !== expectedServerVersion) {
    throw new HttpsError('failed-precondition', '최신 서버 작품을 내려받은 뒤 수정해 주세요.')
  }
  if (!session.localChangesPending) set({ ...session, localChangesPending: true, updatedAt: FieldValue.serverTimestamp() })
  return { localChangesPending: true }
}, ['expectedServerVersion'])

const releaseEditSession = holderOperation((session, set, { data }, { confirmation }) => {
  if (session.localChangesPending !== false) {
    const last = session.lastCommit
    if (session.openRequestId || !last || !confirmation
      || confirmation.requestId !== last.requestId || confirmation.localVersion !== last.localVersion
      || confirmation.serverVersion !== last.serverVersion || data.serverVersion !== last.serverVersion) {
      throw new HttpsError('failed-precondition', '서버 동기화 확인 전에는 편집 세션을 반납할 수 없습니다.')
    }
  }
  const { tokenHash: _tokenHash, ...released } = session
  set({ ...released, status: 'released', localChangesPending: false, updatedAt: FieldValue.serverTimestamp() })
  return { status: 'released' }
}, ['confirmation'])

module.exports = { acquireEditSession, getEditSessionStatus, beginEditSessionChanges, releaseEditSession, forceRecoverEditSession }
Object.defineProperties(module.exports, {
  requireCallable: { value: callable }, holdsSession: { value: holdsSession }, validProof: { value: validProof },
})
