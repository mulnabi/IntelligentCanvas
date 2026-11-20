const { HttpsError } = require('firebase-functions/v2/https')
const { hasOwnProfile, localAdminAvailable } = require('../repositories/profileRepository')

async function checkServerEnvironment(request) {
  const uid = request.auth?.uid
  if (!uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.')
  // 이 함수는 인자를 받지 않는다. 소유권은 검증된 토큰의 UID로만 결정한다.
  const data = request.data
  if (data === null || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length) {
    throw new HttpsError('invalid-argument', '빈 객체를 전달해 주세요.')
  }
  if (!localAdminAvailable()) {
    throw new HttpsError('failed-precondition', '이 함수는 연결이 확인된 로컬 Emulator에서만 실행됩니다.')
  }
  try {
    return { ok: true, uid, profileExists: await hasOwnProfile(uid) }
  } catch {
    throw new HttpsError('unavailable', '로컬 Firestore에서 프로필 상태를 확인하지 못했습니다.')
  }
}

module.exports = { checkServerEnvironment }
