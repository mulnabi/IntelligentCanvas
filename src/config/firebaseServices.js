import { connectFunctionsEmulator, getFunctions } from 'firebase/functions'
import { connectStorageEmulator, getStorage } from 'firebase/storage'
import { app, firebaseEnvironment } from './firebase'
import { firebaseEmulators } from './firebaseEnvironment'

function connectServices() {
  const storage = getStorage(app, `gs://${firebaseEnvironment.config.storageBucket}`)
  const functions = getFunctions(app, firebaseEnvironment.functionsRegion)
  if (firebaseEnvironment.mode === 'emulator') {
    connectStorageEmulator(storage, firebaseEmulators.host, firebaseEmulators.storagePort)
    connectFunctionsEmulator(functions, firebaseEmulators.host, firebaseEmulators.functionsPort)
  }
  return { app, storage, functions }
}

const cached = import.meta.hot?.data.firebaseServices
const clients = cached?.app === app ? cached : connectServices()
if (import.meta.hot) import.meta.hot.data.firebaseServices = clients

export const { storage, functions } = clients
export const artworkFunctionUrl = name => new URL(`${firebaseEnvironment.functionsBaseUrl}/${name}`)
