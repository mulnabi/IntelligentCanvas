const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https')
const { error: logError } = require('firebase-functions/logger')
const { resolveProductionConfig } = require('./productionConfig')
const { configureProductionAdmin, assertAdminAvailable } = require('./repositories/firebaseAdmin')
const editSessions = require('./services/editSessions')
const artworkSync = require('./services/artworkSync')

const settings = resolveProductionConfig(process.env)
configureProductionAdmin(settings)
// SDK가 원소 하나인 배열을 고정 CORS 응답 문자열로 바꾸므로 정확히 일치하는 패턴을 사용한다.
const cors = new RegExp('^' + settings.origin.replace(/[.*+?{}^$()|[\]\\]/g, '\\$&') + '$')
const options = { region: settings.region, cors, serviceAccount: settings.serviceAccount, invoker: 'public' }

function checkRequest(request) {
  assertAdminAvailable()
  const origin = request.get('Origin')
  if (origin && origin !== settings.origin) {
    throw new HttpsError('permission-denied', '허용되지 않은 웹 오리진입니다.')
  }
}

function safeError(operation, cause) {
  if (cause instanceof HttpsError) return cause
  logError('Artwork operation failed', { operation })
  return new HttpsError('internal', '요청을 처리하지 못했습니다.')
}

const callables = {
  acquireEditSession: editSessions.acquireEditSession,
  getEditSessionStatus: editSessions.getEditSessionStatus,
  beginEditSessionChanges: editSessions.beginEditSessionChanges,
  releaseEditSession: editSessions.releaseEditSession,
  forceRecoverEditSession: editSessions.forceRecoverEditSession,
  createServerArtwork: artworkSync.createServerArtwork,
  prepareArtworkSave: artworkSync.prepareArtworkSave,
  finalizeArtworkSave: artworkSync.finalizeArtworkSave,
  listServerArtworks: artworkSync.listServerArtworks,
  getServerArtwork: artworkSync.getServerArtwork,
  deleteServerArtwork: artworkSync.deleteServerArtwork,
  getDeletedServerArtworks: artworkSync.getDeletedServerArtworks,
  listArtworkRevisions: artworkSync.listArtworkRevisions,
}

// PNG 검증은 압축을 풀기 때문에 인스턴스 한 개의 동시 메모리 사용량을 제한한다.
const imageOptions = { ...options, concurrency: 1, memory: '512MiB' }
for (const [name, operation] of Object.entries(callables)) {
  exports[name] = onCall(name === 'finalizeArtworkSave' ? imageOptions : options, async request => {
    try {
      checkRequest(request.rawRequest)
      return await operation(request)
    } catch (cause) {
      throw safeError(name, cause)
    }
  })
}

for (const name of ['uploadArtworkPng', 'downloadArtworkPng']) {
  exports[name] = onRequest(imageOptions, async (request, response) => {
    try {
      checkRequest(request)
      await artworkSync[name](request, response)
    } catch (cause) {
      const failure = safeError(name, cause)
      response.status(failure.httpErrorCode.status).json({ code: failure.code, message: failure.message })
    }
  })
}
