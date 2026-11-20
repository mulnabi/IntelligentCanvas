const { getLocalFirestore } = require('./localFirestore')

async function hasOwnProfile(authenticatedUid) {
  const profile = await getLocalFirestore().collection('users').doc(authenticatedUid).get()
  return profile.exists && profile.get('uid') === authenticatedUid
}

module.exports = { hasOwnProfile }
