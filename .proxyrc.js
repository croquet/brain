// tell parcel to not be as restrictive serving from localhost
module.exports = function(app) {
  app.use((req, res, next) => {
    res.setHeader('Cross-Origin-Embedder-Policy', 'unsafe-none')
    next()
  })
}
