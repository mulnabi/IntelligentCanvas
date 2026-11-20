import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions'
import { connectStorageEmulator, getStorage } from 'firebase/storage'
import { app, assertEmulatorEnvironment, firebaseEmulators } from './firebase'

assertEmulatorEnvironment()

export const localStorageBucket = 'intelligentcanvas-stage5a-local.invalid'
export const functionsRegion = 'asia-northeast3'

function connectServerEmulators() {
  const host = '127.0.0.1'
  const storage = getStorage(app, `gs://${localStorageBucket}`)
  const functions = getFunctions(app, functionsRegion)
  connectStorageEmulator(storage, host, firebaseEmulators.storagePort)
  connectFunctionsEmulator(functions, host, firebaseEmulators.functionsPort)
  return { app, storage, functions }
}

const cached = import.meta.hot?.data.serverEmulators
const clients = cached?.app === app ? cached : connectServerEmulators()
if (import.meta.hot) import.meta.hot.data.serverEmulators = clients

export const storage = clients.storage
export const functions = clients.functions
export const checkServerEnvironment = httpsCallable(functions, 'checkServerEnvironment', { timeout: 15000 })
