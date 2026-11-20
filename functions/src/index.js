const { onCall } = require('firebase-functions/v2/https')
const { checkServerEnvironment } = require('./services/serverEnvironment')

exports.checkServerEnvironment = onCall({
  region: 'asia-northeast3',
  cors: /^http:\/\/(127\.0\.0\.1|localhost)(:[0-9]+)?$/,
}, checkServerEnvironment)
