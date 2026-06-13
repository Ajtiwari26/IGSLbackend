/**
 * Helper utility functions
 */

const crypto = require('crypto');

/**
 * Generate human-readable Trip ID: IQSL-YYYY-RANDOM
 * (Can use timestamp/random combo to avoid collision in simple deployment)
 */
function generateTripId() {
  const year = new Date().getFullYear();
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase(); // 6 chars
  return `IQSL-${year}-${rand}`;
}

/**
 * Generate human-readable LR Number: LR-YYYY-RANDOM
 */
function generateLrNumber() {
  const year = new Date().getFullYear();
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `LR-${year}-${rand}`;
}

/**
 * Calculate estimated trip cost based on rate configuration
 * Types: fixed | per_mt | per_km | per_mt_per_km
 */
function calculateTripCost(rateConfig, weightMt, distanceKm) {
  const { type, base_rate } = rateConfig || {};
  const rate = Number(base_rate) || 0;
  const weight = Number(weightMt) || 0;
  const distance = Number(distanceKm) || 0;

  switch (type) {
    case 'fixed':
      return rate;
    case 'per_mt':
      return rate * weight;
    case 'per_km':
      return rate * distance;
    case 'per_mt_per_km':
      return rate * weight * distance;
    default:
      return 0;
  }
}

/**
 * Hash string (primarily for mock hashes or basic masking)
 */
function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

module.exports = {
  generateTripId,
  generateLrNumber,
  calculateTripCost,
  sha256
};
