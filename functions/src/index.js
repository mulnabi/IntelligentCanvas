const { modeName } = require('./productionConfig')

if (process.env[modeName] === 'production') {
  module.exports = require('./production')
} else if (process.env.FUNCTIONS_EMULATOR === 'true') {
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
