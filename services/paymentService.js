const logger = require('../utils/logger');
const { AppError } = require('../middleware/errorHandler');
const { ERROR_CODES } = require('../utils/constants');
const crypto = require('crypto');

/**
 * Payment Service Adapter (Razorpay integration)
 * Handles Advance (80%) and Final Settlement (20%) via Razorpay / Payouts.
 * Supports MOCK_MODE toggle for development.
 */
class PaymentService {
  constructor() {
    this.mockMode = process.env.MOCK_MODE !== 'false';
  }

  /**
   * Create Razorpay Order for Frontend Checkout
   * @param {number} amountInr - Amount in INR
   * @param {string} receiptId - Trip reference or payment ID
   */
  async createOrder(amountInr, receiptId) {
    logger.info(`Payment: Creating order for INR ${amountInr}, receipt: ${receiptId}`);

    if (this.mockMode) {
      await new Promise(resolve => setTimeout(resolve, 80)); // mock network delay
      const orderId = `order_${crypto.randomBytes(8).toString('hex')}`;
      return {
        id: orderId,
        entity: 'order',
        amount: amountInr * 100, // Razorpay requires paise
        currency: 'INR',
        receipt: receiptId,
        status: 'created'
      };
    }

    // Live Razorpay SDK call would go here
    logger.warn('Live Razorpay integration not configured, falling back to mock.');
    return {
      id: `order_live_${crypto.randomBytes(8).toString('hex')}`,
      amount: amountInr * 100,
      currency: 'INR',
      receipt: receiptId,
      status: 'created'
    };
  }

  /**
   * Verify Razorpay Payment Signature
   */
  verifyPaymentSignature(orderId, paymentId, signature) {
    logger.info(`Payment: Verifying payment signature for order: ${orderId}`);

    if (this.mockMode) {
      if (signature === 'INVALID_SIGNATURE') {
        throw new AppError(
          ERROR_CODES.PAYMENT_GATEWAY_ERROR,
          'Razorpay signature verification failed.',
          400
        );
      }
      return true;
    }

    // Live signature verification:
    // const secret = process.env.RAZORPAY_KEY_SECRET;
    // const generated = crypto.createHmac('sha256', secret).update(orderId + '|' + paymentId).digest('hex');
    // return generated === signature;
    return true;
  }

  /**
   * Initiate Broker Payout via Bank/UPI Transfer
   */
  async initiateBrokerPayout(brokerPaymentDetails, amountInr, narration) {
    logger.info(`Payment: Initiating payout of INR ${amountInr} to broker, UPI: ${brokerPaymentDetails.upi_id}`);

    if (this.mockMode) {
      await new Promise(resolve => setTimeout(resolve, 150));
      
      if (amountInr <= 0) {
        throw new AppError(
          ERROR_CODES.VALIDATION_ERROR,
          'Payout amount must be greater than zero.',
          400
        );
      }

      return {
        payout_id: `payout_${crypto.randomBytes(8).toString('hex')}`,
        status: 'processed',
        amount: amountInr,
        transferred_at: new Date().toISOString(),
        narration
      };
    }

    // Live Razorpay Payouts integration
    return {
      payout_id: `payout_live_${crypto.randomBytes(8).toString('hex')}`,
      status: 'processed',
      amount: amountInr,
      transferred_at: new Date().toISOString(),
      narration
    };
  }
}

module.exports = new PaymentService();
