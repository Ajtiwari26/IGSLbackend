const { AppError } = require('./errorHandler');
const { ERROR_CODES } = require('../utils/constants');

/**
 * Middleware to restrict staff/manager access based on specific permission flags
 * @param {string} requiredPermission - Permission string (e.g. 'can_create_jobs')
 */
function permissionGuard(requiredPermission) {
  return (req, res, next) => {
    if (!req.user) {
      return next(new AppError(ERROR_CODES.AUTH_TOKEN_INVALID, 'Authentication required', 401));
    }

    // Admins have all permissions automatically
    if (req.user.role === 'admin') {
      return next();
    }

    // Managers (role: 'client') must have the specific permission flag enabled
    if (req.user.role === 'client') {
      const hasPermission = req.user.permissions && !!req.user.permissions[requiredPermission];
      if (!hasPermission) {
        return next(
          new AppError(
            ERROR_CODES.AUTH_FORBIDDEN,
            `Access denied. You do not have the required staff permission '${requiredPermission}' for this operation.`,
            403
          )
        );
      }
    }

    return next();
  };
}

module.exports = permissionGuard;
