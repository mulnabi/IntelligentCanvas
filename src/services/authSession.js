import { signOut } from 'firebase/auth'
import { withCanvasSaved } from './pendingCanvasChanges'

const initialChecks = new WeakMap()
const invalidations = new WeakMap()
const invalidTokenCodes = new Set([
  'auth/invalid-refresh-token', 'auth/invalid-user-token', 'auth/user-token-expired',
  'auth/user-disabled', 'auth/user-not-found',
])

export async function withAuthDeadline(operation, code, milliseconds = 12000) {
  let timer
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('인증 요청 시간이 초과되었습니다.'), { code })), milliseconds)
    })
    return await Promise.race([operation, timeout])
  } finally {
    clearTimeout(timer)
  }
}

export async function getSessionIdToken(auth, user, forceRefresh = false) {
  try {
    return await withAuthDeadline(user.getIdToken(forceRefresh), 'auth/network-request-failed')
  } catch (error) {
    if (!invalidTokenCodes.has(error.code)) throw error

    if (auth.currentUser === user) {
      let cleanup = invalidations.get(user)
      if (!cleanup) {
        // 기본 Auth의 beforeAuthStateChanged에서 미저장 획을 보존한다.
        cleanup = withCanvasSaved(async () => {
          if (auth.currentUser === user) await signOut(auth)
        }).finally(() => invalidations.delete(user))
        invalidations.set(user, cleanup)
      }
      await cleanup
    }
    throw Object.assign(new Error('이전 로그인 세션이 만료되었거나 무효화되었습니다.'), { code: 'auth/session-invalidated' })
  }
}

export function waitForAuthSession(auth) {
  let ready = initialChecks.get(auth)
  if (!ready) {
    ready = (async () => {
      await withAuthDeadline(auth.authStateReady(), 'auth/restore-timeout')
      const user = auth.currentUser
      if (!user || !navigator.onLine) return

      try {
        // 아직 만료되지 않은 ID 토큰과 별도로 이전 refresh token을 한 번 검증한다.
        await getSessionIdToken(auth, user, true)
      } catch (error) {
        if (!['auth/session-invalidated', 'auth/network-request-failed'].includes(error.code)) throw error
        // 일시적으로 연결할 수 없는 경우 이전에 확인된 사용자의 로컬 작업을 유지한다.
      }
    })().catch(error => {
      initialChecks.delete(auth)
      throw error
    })
    initialChecks.set(auth, ready)
  }
  return ready
}
