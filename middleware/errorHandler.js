const logger = require('../utils/logger');
const { ERROR_CODES } = require('../utils/constants');

/**
 * Custom App Error class for structured API errors
 */
class AppError extends Error {
  constructor(code, message, statusCode = 400, details = null) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Middleware to attach standard response wrappers (success and error)
 */
function responseFormatter(req, res, next) {
  res.success = function(data) {
    return res.status(200).json({
      success: true,
      data,
      meta: {
        request_id: req.id,
        timestamp: new Date().toISOString(),
        latency_ms: Date.now() - req.startTime
      }
    });
  };

  res.error = function(code, message, details = null, statusCode = 400) {
    return res.status(statusCode).json({
      success: false,
      error: {
        code,
        message,
        details
      },
      meta: {
        request_id: req.id,
        timestamp: new Date().toISOString(),
        latency_ms: Date.now() - req.startTime
      }
    });
  };

  next();
}

/**
 * Global centralized error handler middleware
 */
function errorHandler(err, req, res, next) {
  const latency = req.startTime ? Date.now() - req.startTime : 0;
  
  let statusCode = err.statusCode || 500;
  let code = err.code || ERROR_CODES.INTERNAL_ERROR;
  let message = err.message || 'An unexpected error occurred';
  let details = err.details || null;

  // Handle MongoDB Duplicate Key Error (code 11000)
  if (err.code === 11000) {
    statusCode = 409;
    code = ERROR_CODES.DUPLICATE_ENTRY;
    message = 'An entry with this unique identifier already exists.';
    details = err.keyValue;
  }

  // Log the error
  logger.error(`Error processing request ${req.method} ${req.originalUrl}`, {
    request_id: req.id,
    latency_ms: latency,
    code,
    statusCode,
    message,
    stack: err.stack
  });

  // If formatter wasn't initialized yet
  if (typeof res.error !== 'function') {
    return res.status(statusCode).json({
      success: false,
      error: { code, message, details },
      meta: {
        request_id: req.id || 'N/A',
        timestamp: new Date().toISOString(),
        latency_ms: latency
      }
    });
  }

  return res.error(code, message, details, statusCode);
}

module.exports = {
  AppError,
  responseFormatter,
  errorHandler
};
