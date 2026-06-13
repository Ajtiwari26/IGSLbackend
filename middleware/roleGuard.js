const { AppError } = require('./errorHandler');
const { ERROR_CODES } = require('../utils/constants');

/**
 * Middleware to restrict access based on user role(s)
 * @param {string|string[]} allowedRoles - Single role or array of allowed roles
 */
function roleGuard(allowedRoles) {
  const roles = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];

  return (req, res, next) => {
    if (!req.user) {
      return next(new AppError(ERROR_CODES.AUTH_TOKEN_INVALID, 'Authentication required', 401));
    }

    if (!roles.includes(req.user.role)) {
      return next(
        new AppError(
          ERROR_CODES.AUTH_FORBIDDEN,
          `Access denied. Role '${req.user.role}' is not authorized for this resource.`,
          403
        )
      );
    }

    next();
  };
}

module.exports = roleGuard;
