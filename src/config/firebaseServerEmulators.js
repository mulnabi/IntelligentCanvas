import { httpsCallable } from 'firebase/functions'
import { assertEmulatorEnvironment } from './firebase'
import { functions, storage } from './firebaseServices'

assertEmulatorEnvironment()

export { storage, functions }
export const checkServerEnvironment = httpsCallable(functions, 'checkServerEnvironment', { timeout: 15000 })
