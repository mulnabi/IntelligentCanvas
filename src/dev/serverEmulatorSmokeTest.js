import { deleteObject, getBytes, ref, uploadBytes } from 'firebase/storage'
import { auth } from '../config/firebase'
import { checkServerEnvironment, storage } from '../config/firebaseServerEmulators'

export async function runServerEmulatorSmokeTest() {
  await auth.authStateReady()
  const uid = auth.currentUser?.uid
  if (!uid) throw new Error('앱에서 먼저 로그인해 주세요.')
  const { data } = await checkServerEnvironment({})
  if (!data?.ok || data.uid !== uid) throw new Error('Functions에서 다른 인증 사용자가 반환되었습니다.')

  const object = ref(storage, `_emulatorChecks/${uid}/${crypto.randomUUID()}.txt`)
  const message = 'IntelligentCanvas 5-A'
  await uploadBytes(object, new Blob([message], { type: 'text/plain' }))
  try {
    const received = new TextDecoder().decode(await getBytes(object, 256))
    if (received !== message) throw new Error('Storage에서 읽은 테스트 파일이 원본과 다릅니다.')
  } finally {
    await deleteObject(object)
  }
  return { functions: 'ok', firestoreProfileExists: data.profileExists, storage: 'ok', testObjectRemoved: true }
}
