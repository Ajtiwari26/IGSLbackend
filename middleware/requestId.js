const { v4: uuidv4 } = require('uuid');

/**
 * Middleware to trace each request with a unique ID and track start time for latency
 */
function requestIdMiddleware(req, res, next) {
  req.id = req.headers['x-request-id'] || uuidv4();
  req.startTime = Date.now();
  
  // Set in response header for client debugging
  res.setHeader('x-request-id', req.id);
  next();
}

module.exports = requestIdMiddleware;
