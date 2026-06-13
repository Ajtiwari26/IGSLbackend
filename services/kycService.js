const logger = require('../utils/logger');
const { AppError } = require('../middleware/errorHandler');
const { ERROR_CODES } = require('../utils/constants');

/**
 * KYC Service Adapter (mParivahan / Zoop APIs)
 * Supports MOCK_MODE toggle for development.
 */
class KYCService {
  constructor() {
    this.mockMode = process.env.MOCK_MODE !== 'false';
  }

  /**
   * Verify Driver's License
   */
  async verifyDL(dlNumber) {
    logger.info(`KYC: Verifying DL Number: ${dlNumber}`);
    
    if (this.mockMode) {
      // Simulate API latency
      await new Promise(resolve => setTimeout(resolve, 100));

      if (dlNumber.toUpperCase() === 'DL-INVALID') {
        throw new AppError(
          ERROR_CODES.KYC_VERIFICATION_FAILED,
          'Invalid Driver License details or license is expired.',
          422
        );
      }

      return {
        status: 'verified',
        dl_number: dlNumber.toUpperCase(),
        name: 'Suresh Kumar Yadav',
        expiry_date: '2035-12-31',
        vehicle_class: 'LMV/HMV'
      };
    }

    // Live API Implementation Placeholder
    logger.warn('Live mParivahan/Zoop integration not configured, falling back to mock behavior.');
    return this._verifyDLMockFallback(dlNumber);
  }

  /**
   * Verify Registration Certificate (RC) and Vehicle Details
   */
  async verifyRC(vehicleNumber) {
    logger.info(`KYC: Verifying Vehicle RC: ${vehicleNumber}`);

    if (this.mockMode) {
      await new Promise(resolve => setTimeout(resolve, 100));

      if (vehicleNumber.toUpperCase() === 'VEHICLE-INVALID') {
        throw new AppError(
          ERROR_CODES.KYC_VERIFICATION_FAILED,
          'Vehicle registration details not found or blacklist check failed.',
          422
        );
      }

      return {
        status: 'verified',
        vehicle_number: vehicleNumber.toUpperCase(),
        owner_name: 'Suresh Transport Corp',
        vehicle_class: 'HGV / Trailer',
        rc_expiry: '2030-05-15',
        insurance_expiry: '2027-08-20',
        fitness_expiry: '2027-02-10'
      };
    }

    // Live API Implementation Placeholder
    return this._verifyRCMockFallback(vehicleNumber);
  }

  _verifyDLMockFallback(dlNumber) {
    return { status: 'verified', dl_number: dlNumber };
  }

  _verifyRCMockFallback(vehicleNumber) {
    return { status: 'verified', vehicle_number: vehicleNumber };
  }
}

module.exports = new KYCService();
