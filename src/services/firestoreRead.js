import { onSnapshot } from 'firebase/firestore'
import { withAuthDeadline } from './authSession'

export async function readServerDocument(reference, timeoutCode, milliseconds) {
  let unsubscribe
  try {
    const result = new Promise((resolve, reject) => {
      unsubscribe = onSnapshot(reference, { includeMetadataChanges: true }, snapshot => {
        if (!snapshot.metadata.fromCache) resolve(snapshot)
      }, reject)
    })
    return await withAuthDeadline(result, timeoutCode, milliseconds)
  } finally {
    // Firestore가 재연결을 시도하더라도 이 화면의 일회성 조회는 끝낸다.
    unsubscribe?.()
  }
}
