const { getAdminFirestore } = require('./firebaseAdmin')

function withArtworkSession(uid, artworkId, operation) {
  const db = getAdminFirestore()
  const artwork = db.collection('users').doc(uid).collection('artworks').doc(artworkId)
  const session = artwork.collection('editSession').doc('current')
  return db.runTransaction(async tx => {
    const artworkSnapshot = await tx.get(artwork)
    if (!artworkSnapshot.exists || artworkSnapshot.get('ownerUid') !== uid
      || artworkSnapshot.get('state') === 'deleted') return null
    const snapshot = await tx.get(session)
    return operation(snapshot.data(), data => tx.set(session, data), { tx, artwork, data: artworkSnapshot.data(), session })
  })
}

module.exports = { withArtworkSession }
