/**
 * Middleware to set Cache-Control headers for HTTP responses.
 * Follows the guidelines specified in SYSTEM_DESIGN_REPORT.md:
 * - State-mutating methods (POST, PUT, DELETE, PATCH): no-store, no-cache, must-revalidate
 * - Fetch methods (GET): private, no-cache
 */
function cacheControlMiddleware(req, res, next) {
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  } else if (req.method === 'GET') {
    res.setHeader('Cache-Control', 'private, no-cache');
  }
  next();
}

module.exports = cacheControlMiddleware;
