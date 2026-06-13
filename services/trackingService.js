const logger = require('../utils/logger');
const { AppError } = require('../middleware/errorHandler');
const { ERROR_CODES } = require('../utils/constants');

/**
 * SIM Tracking and Geofencing Service Adapter
 * Simulates carrier-grade cell tower tracking APIs.
 * Supports MOCK_MODE toggle for development.
 */
class TrackingService {
  constructor() {
    this.mockMode = process.env.MOCK_MODE !== 'false';
  }

  /**
   * Request SIM Consent from carrier (initiates SMS validation to driver)
   */
  async requestConsent(phoneNumber) {
    logger.info(`Tracking: Requesting SIM consent for number: ${phoneNumber}`);

    if (this.mockMode) {
      await new Promise(resolve => setTimeout(resolve, 80));
      return {
        success: true,
        consent_status: 'pending', // awaits driver SMS reply
        message: 'Consent request SMS dispatched by telco gateway.'
      };
    }

    // Live API integration
    return { success: true, consent_status: 'pending' };
  }

  /**
   * Check SIM Consent Status
   */
  async checkConsentStatus(phoneNumber) {
    logger.info(`Tracking: Checking SIM consent status for: ${phoneNumber}`);

    if (this.mockMode) {
      // In mock mode, if phone ends with '0', simulate pending consent, otherwise verified
      if (phoneNumber.endsWith('0')) {
        return 'pending';
      }
      return 'active'; // consented
    }

    return 'active';
  }

  /**
   * Fetch current location based on SIM cell towers
   */
  async getSimLocation(phoneNumber) {
    logger.info(`Tracking: Fetching SIM location for: ${phoneNumber}`);

    if (this.mockMode) {
      await new Promise(resolve => setTimeout(resolve, 100));

      const status = await this.checkConsentStatus(phoneNumber);
      if (status !== 'active') {
        throw new AppError(
          ERROR_CODES.TRACKING_SERVICE_ERROR,
          'Consent is not active. Driver must reply YES to telco SMS first.',
          403
        );
      }

      // Generate a mock path drifting towards destination
      // Default: Bangalore (12.97, 77.59) moving slightly
      const driftLat = 12.97 + (Math.random() - 0.5) * 0.1;
      const driftLng = 77.59 + (Math.random() - 0.5) * 0.1;

      return {
        lat: Number(driftLat.toFixed(4)),
        lng: Number(driftLng.toFixed(4)),
        last_ping_at: new Date().toISOString()
      };
    }

    // Live API integration placeholder
    return {
      lat: 12.9716,
      lng: 77.5946,
      last_ping_at: new Date().toISOString()
    };
  }

  /**
   * Geofencing calculation: Check if coordinates are within radius of destination
   * Uses simple Haversine formula to compute distance in km
   */
  isWithinGeofence(lat1, lon1, lat2, lon2, radiusKm = 1.0) {
    if (!lat1 || !lon1 || !lat2 || !lon2) return false;

    const R = 6371; // Earth radius in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    
    const a = 
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
      
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const distance = R * c;

    logger.debug(`Geofence: Distance check: ${distance.toFixed(3)} km (limit: ${radiusKm} km)`);
    return distance <= radiusKm;
  }
}

module.exports = new TrackingService();
