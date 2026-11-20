import { doc, getDocFromServer, runTransaction, serverTimestamp, updateDoc } from 'firebase/firestore'

export function normalizeNickname(value) {
  const nickname = typeof value === 'string' ? value.trim() : ''
  if (!nickname || nickname.length > 80) {
    const error = new Error('닉네임은 공백을 제외한 1~80자로 입력해 주세요.')
    error.code = 'profile/invalid-nickname'
    throw error
  }
  return nickname // 중복 검사나 닉네임 예약을 하지 않는다.
}

async function ownProfileReference(uid) {
  const { auth, db } = await import('../config/firebase.js')
  await auth.authStateReady()
  if (!uid || auth.currentUser?.uid !== uid) {
    const error = new Error('현재 로그인한 계정의 프로필만 처리할 수 있습니다. 다시 로그인해 주세요.')
    error.code = 'profile/auth-changed'
    throw error
  }
  return { db, reference: doc(db, 'users', uid) }
}

export async function getUserProfile(uid) {
  const { reference } = await ownProfileReference(uid)
  const snapshot = await getDocFromServer(reference)
  return snapshot.exists() ? snapshot.data() : null
}

// 가입 후 응답 유실·중복 호출에도 기존 nickname/createdAt을 덮어쓰지 않는다.
export async function ensureUserProfile(uid, value) {
  const nickname = normalizeNickname(value)
  const { db, reference } = await ownProfileReference(uid)
  await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(reference)
    if (!snapshot.exists()) {
      transaction.set(reference, {
        uid,
        nickname,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        schemaVersion: 1,
      })
    }
  }, { maxAttempts: 3 })
  return getUserProfile(uid)
}

export async function updateNickname(uid, value) {
  const nickname = normalizeNickname(value)
  const { reference } = await ownProfileReference(uid)
  await updateDoc(reference, { nickname, updatedAt: serverTimestamp() })
  return getUserProfile(uid)
}
