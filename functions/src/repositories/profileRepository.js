const { getApps, initializeApp } = require('firebase-admin/app')
const { getFirestore } = require('firebase-admin/firestore')

const projectId = 'ai-drawing-a9177'
const appName = 'local-server-check'

function localAdminAvailable() {
  return process.env.FUNCTIONS_EMULATOR === 'true'
    && process.env.GCLOUD_PROJECT === projectId
    && process.env.FIRESTORE_EMULATOR_HOST === '127.0.0.1:8080'
    && process.env.FIREBASE_AUTH_EMULATOR_HOST === '127.0.0.1:9099'
}

async function hasOwnProfile(authenticatedUid) {
  if (!localAdminAvailable()) throw new Error('Local Emulator configuration required')
  const app = getApps().find(app => app.name === appName) ?? initializeApp({ projectId }, appName)
  const profile = await getFirestore(app).collection('users').doc(authenticatedUid).get()
  return profile.exists && profile.get('uid') === authenticatedUid
}

module.exports = { hasOwnProfile, localAdminAvailable }
