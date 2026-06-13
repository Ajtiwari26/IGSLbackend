/**
 * System Constants and Enums
 */

const ROLES = {
  ADMIN: 'admin',
  CLIENT: 'client',
  DRIVER: 'driver', // can be broker or driver
  BROKER: 'broker'
};

const TRIP_STATUS = {
  CREATED: 'created',
  ASSIGNED: 'assigned',
  DISPATCHED: 'dispatched',
  IN_TRANSIT: 'in_transit',
  DELIVERED: 'delivered',
  SETTLED: 'settled',
  CANCELLED: 'cancelled'
};

const PAYMENT_STATUS = {
  PENDING: 'pending',
  PAID: 'paid',
  FAILED: 'failed'
};

const KYC_STATUS = {
  PENDING: 'pending',
  SUBMITTED: 'submitted',
  VERIFIED: 'verified',
  REJECTED: 'rejected'
};

const EWAYBILL_STATUS = {
  PENDING: 'pending',
  VALID: 'valid',
  EXPIRED: 'expired'
};

const ERROR_CODES = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  AUTH_OTP_EXPIRED: 'AUTH_OTP_EXPIRED',
  AUTH_TOKEN_INVALID: 'AUTH_TOKEN_INVALID',
  AUTH_FORBIDDEN: 'AUTH_FORBIDDEN',
  RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',
  DUPLICATE_ENTRY: 'DUPLICATE_ENTRY',
  KYC_VERIFICATION_FAILED: 'KYC_VERIFICATION_FAILED',
  PAYMENT_GATEWAY_ERROR: 'PAYMENT_GATEWAY_ERROR',
  TRACKING_SERVICE_ERROR: 'TRACKING_SERVICE_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR'
};

module.exports = {
  ROLES,
  TRIP_STATUS,
  PAYMENT_STATUS,
  KYC_STATUS,
  EWAYBILL_STATUS,
  ERROR_CODES
};
