const { AppError } = require('./errorHandler');
const { ERROR_CODES } = require('../utils/constants');

/**
 * Lightweight Schema Validation Middleware
 * Checks fields on req[source] (body, query, params) using simple rule structures.
 * 
 * Rules structure:
 * {
 *   fieldName: { required: true, type: 'string'|'number'|'boolean'|'array'|'object', enum: [...], regex: /.../ }
 * }
 */
function validate(schema, source = 'body') {
  return (req, res, next) => {
    const data = req[source] || {};
    const errors = [];

    for (const [field, rules] of Object.entries(schema)) {
      const value = data[field];

      // 1. Required Check
      if (rules.required && (value === undefined || value === null || value === '')) {
        errors.push(`Field '${field}' is required.`);
        continue;
      }

      // 2. Type Check (if field is provided)
      if (value !== undefined && value !== null && value !== '') {
        if (rules.type) {
          if (rules.type === 'array' && !Array.isArray(value)) {
            errors.push(`Field '${field}' must be an array.`);
          } else if (rules.type === 'object' && (typeof value !== 'object' || Array.isArray(value))) {
            errors.push(`Field '${field}' must be an object.`);
          } else if (rules.type === 'number') {
            if (typeof value !== 'number' && isNaN(Number(value))) {
              errors.push(`Field '${field}' must be a number.`);
            }
          } else if (rules.type === 'boolean' && typeof value !== 'boolean' && value !== 'true' && value !== 'false') {
            errors.push(`Field '${field}' must be a boolean.`);
          } else if (rules.type === 'string' && typeof value !== 'string') {
            errors.push(`Field '${field}' must be a string.`);
          }
        }

        // 3. Enum Check
        if (rules.enum && !rules.enum.includes(value)) {
          errors.push(`Field '${field}' must be one of: [${rules.enum.join(', ')}].`);
        }

        // 4. Regex Check
        if (rules.regex && !rules.regex.test(value)) {
          errors.push(`Field '${field}' format is invalid.`);
        }
      }
    }

    if (errors.length > 0) {
      return next(new AppError(ERROR_CODES.VALIDATION_ERROR, 'Input validation failed', 400, errors));
    }

    next();
  };
}

module.exports = validate;
