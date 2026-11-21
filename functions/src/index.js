// 이 소스의 함수들은 Emulator의 Firebase Admin 설정에 의존한다.
// 운영 함수 검색 과정에는 별도 운영 진입점이 준비될 때까지 함수가 노출되지 않는다.
if (process.env.FUNCTIONS_EMULATOR === 'true') {
  const { onCall, onRequest } = require('firebase-functions/v2/https')
  const { checkServerEnvironment } = require('./services/serverEnvironment')
  const editSessions = require('./services/editSessions')
  const { uploadArtworkPng, downloadArtworkPng, ...artworkSync } = require('./services/artworkSync')

  const options = {
    region: 'asia-northeast3',
    cors: /^http:\/\/(127\.0\.0\.1|localhost)(:[0-9]+)?$/,
  }
  exports.checkServerEnvironment = onCall(options, checkServerEnvironment)
  for (const [name, handler] of Object.entries(editSessions)) exports[name] = onCall(options, handler)
  for (const [name, handler] of Object.entries(artworkSync)) exports[name] = onCall(options, handler)
  exports.uploadArtworkPng = onRequest(options, uploadArtworkPng)
  exports.downloadArtworkPng = onRequest(options, downloadArtworkPng)
}
