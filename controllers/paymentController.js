const { ObjectId } = require('mongodb');
const { getDb } = require('../db');
const { AppError } = require('../middleware/errorHandler');
const { ERROR_CODES, PAYMENT_STATUS, TRIP_STATUS } = require('../utils/constants');
const paymentService = require('../services/paymentService');
const logger = require('../utils/logger');
const cache = require('../cache');

/**
 * Controller to handle Payments Ledger lifecycle (Advance + Settlement Payouts)
 */
class PaymentController {

  /**
   * Initiate 80% Advance Payment Order (via Razorpay Checkout)
   * Route: POST /api/payments/:trip_id/advance/initiate
   * Access: Admin only
   */
  async initiateAdvancePayment(req, res, next) {
    try {
      const { trip_id } = req.params;
      const db = getDb();
      const institution = req.user.institution || 'IGSL';

      // Find payment ledger
      const payment = await db.collection('payments').findOne({ trip_id: new ObjectId(trip_id), institution });
      if (!payment) {
        throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Payment ledger for this trip not found.', 404);
      }

      if (payment.advance_status === PAYMENT_STATUS.PAID) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Advance payment is already processed and paid.', 400);
      }

      // Create checkout order on Razorpay
      const rpOrder = await paymentService.createOrder(payment.advance_amount, payment.trip_ref);

      await db.collection('payments').updateOne(
        { _id: payment._id },
        { 
          $set: { 
            advance_razorpay_order_id: rpOrder.id,
            updated_at: new Date()
          } 
        }
      );

      logger.info(`Advance payment order ${rpOrder.id} created for trip ${payment.trip_ref} under ${institution}`);

      await cache.delete(`dashboard:settlement:${institution}`);

      return res.success({
        message: 'Razorpay order created successfully for advance payment checkout.',
        order_id: rpOrder.id,
        amount_paise: rpOrder.amount,
        currency: rpOrder.currency,
        receipt: rpOrder.receipt
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Verify Razorpay Payment Signature for Advance Payment
   * Route: POST /api/payments/:trip_id/advance/verify
   * Access: Admin only
   */
  async verifyAdvancePayment(req, res, next) {
    try {
      const { trip_id } = req.params;
      const { payment_id, signature } = req.body;

      if (!payment_id || !signature) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Payment ID and Signature are required for verification.', 400);
      }

      const db = getDb();
      const institution = req.user.institution || 'IGSL';

      const payment = await db.collection('payments').findOne({ trip_id: new ObjectId(trip_id), institution });
      if (!payment) {
        throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Payment ledger for this trip not found.', 404);
      }

      // Verify signature using SDK adapter
      paymentService.verifyPaymentSignature(payment.advance_razorpay_order_id, payment_id, signature);

      const updateData = {
        advance_status: PAYMENT_STATUS.PAID,
        advance_paid_at: new Date(),
        updated_at: new Date()
      };

      await db.collection('payments').updateOne({ _id: payment._id }, { $set: updateData });

      // Update Trip Lifecycle Step 4
      await db.collection('trips').updateOne(
        { _id: new ObjectId(trip_id), institution },
        {
          $set: {
            'lifecycle.current_step': 4,
            'lifecycle.step_4': {
              completed: true,
              timestamp: new Date(),
              razorpay_order_id: payment.advance_razorpay_order_id || payment_id
            }
          }
        }
      );

      logger.info(`Advance payment verified for trip ${payment.trip_ref}, Payment ID: ${payment_id}`);

      await cache.delete(`trip:${trip_id}:${institution}`);
      await cache.delete(`trip:active:count:${institution}`);
      await cache.delete(`dashboard:settlement:${institution}`);

      return res.success({
        message: 'Advance payment verified and marked as paid successfully.',
        payment: { ...payment, ...updateData }
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Approve and release 80% Advance Payout directly (Admin approval of Manager Request)
   * Route: POST /api/payments/:trip_id/advance/approve
   * Access: Admin only
   */
  async approveAdvancePayment(req, res, next) {
    try {
      const { trip_id } = req.params;
      const db = getDb();
      const institution = req.user.institution || 'IGSL';

      const payment = await db.collection('payments').findOne({ trip_id: new ObjectId(trip_id), institution });
      if (!payment) {
        throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Payment ledger for this trip not found.', 404);
      }

      if (payment.advance_status === PAYMENT_STATUS.PAID) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Advance payment has already been approved and paid.', 400);
      }

      const trip = await db.collection('trips').findOne({ _id: new ObjectId(trip_id), institution });
      if (!trip) {
        throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Trip not found.', 404);
      }

      const broker = await db.collection('brokers').findOne({ _id: trip.broker_id, institution });
      if (!broker) {
        throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Broker profile not found.', 404);
      }

      // Trigger mock payout to broker
      const payoutResult = await paymentService.initiateBrokerPayout(
        broker.payment_details,
        payment.advance_amount,
        `80% Advance payout for Trip ${payment.trip_ref}`
      );

      const updateData = {
        advance_status: PAYMENT_STATUS.PAID,
        advance_paid_at: new Date(),
        updated_at: new Date()
      };

      await db.collection('payments').updateOne({ _id: payment._id }, { $set: updateData });

      // Update Trip Lifecycle Step 4
      await db.collection('trips').updateOne(
        { _id: new ObjectId(trip_id), institution },
        {
          $set: {
            'lifecycle.current_step': 4,
            'lifecycle.step_4': {
              completed: true,
              timestamp: new Date(),
              razorpay_order_id: payoutResult.payout_id || 'direct_payout'
            }
          }
        }
      );

      logger.info(`Admin approved direct 80% Advance payout for trip ${payment.trip_ref}, Payout ID: ${payoutResult.payout_id}`);

      await cache.delete(`trip:${trip_id}:${institution}`);
      await cache.delete(`trip:active:count:${institution}`);
      await cache.delete(`dashboard:settlement:${institution}`);

      return res.success({
        message: 'Advance 80% payment approved and released successfully.',
        payout_id: payoutResult.payout_id,
        amount_paid: payment.advance_amount
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Submit / File POD Settlement Details (Manager creates final invoice request)
   * Route: POST /api/payments/:trip_id/settle/request
   * Access: Admin & Broker (Manager)
   */
  async requestSettlement(req, res, next) {
    try {
      const { trip_id } = req.params;
      const { shortage_mt, shortage_amount, damage_amount, delay_penalty, other_expense_amount, other_expense_reason } = req.body;

      const db = getDb();
      const institution = req.user.institution || 'IGSL';

      const trip = await db.collection('trips').findOne({ _id: new ObjectId(trip_id), institution });
      if (!trip) {
        throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Trip not found.', 404);
      }

      const payment = await db.collection('payments').findOne({ trip_id: new ObjectId(trip_id), institution });
      if (!payment) {
        throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Payment ledger for this trip not found.', 404);
      }

      if (payment.balance_status === PAYMENT_STATUS.PAID) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Trip balance has already been settled and paid.', 400);
      }

      // Compute deductions
      const shortageAmt = Number(shortage_amount) || 0;
      const damageAmt = Number(damage_amount) || 0;
      const delayAmt = Number(delay_penalty) || 0;
      const otherAmt = Number(other_expense_amount) || 0;
      const totalDeductions = shortageAmt + damageAmt + delayAmt + otherAmt;

      const finalPayable = Math.max(0, payment.balance_amount - totalDeductions);

      const paymentUpdate = {
        'deductions.shortage_mt': Number(shortage_mt) || 0,
        'deductions.shortage_amount': shortageAmt,
        'deductions.damage_amount': damageAmt,
        'deductions.delay_penalty': delayAmt,
        'deductions.other_expense_amount': otherAmt,
        'deductions.other_expense_reason': other_expense_reason || '',
        'deductions.total_deductions': totalDeductions,
        final_payable: finalPayable,
        balance_status: 'requested', // Mark as requested, awaiting Admin approval
        updated_at: new Date()
      };

      await db.collection('payments').updateOne({ _id: payment._id }, { $set: paymentUpdate });

      logger.info(`Manager filed POD settlement request for trip ${trip.trip_id} under ${institution}. Net Payable: INR ${finalPayable}`);

      await cache.delete(`trip:${trip_id}:${institution}`);
      await cache.delete(`trip:active:count:${institution}`);
      await cache.delete(`dashboard:settlement:${institution}`);

      return res.success({
        message: 'POD settlement details filed and sent to Admin for final approval.',
        final_payable: finalPayable,
        deductions: paymentUpdate.deductions
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Final Settlement Approval (20% balance - shortage/damage deductions)
   * Triggers a mock bank/UPI payout directly to the broker.
   * Route: POST /api/payments/:trip_id/settle
   * Access: Admin only
   */
  async settleBalancePayment(req, res, next) {
    try {
      const { trip_id } = req.params;
      const db = getDb();
      const institution = req.user.institution || 'IGSL';

      // 1. Fetch Trip details (Ensure POD is approved)
      const trip = await db.collection('trips').findOne({ _id: new ObjectId(trip_id), institution });
      if (!trip) {
        throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Trip not found.', 404);
      }

      if (!trip.pod.approved) {
        throw new AppError(
          ERROR_CODES.VALIDATION_ERROR,
          'Cannot settle trip payment. Proof of Delivery (POD) must be approved by an Admin first.',
          400
        );
      }

      // 2. Fetch Payment details
      const payment = await db.collection('payments').findOne({ trip_id: new ObjectId(trip_id), institution });
      if (!payment) {
        throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Payment ledger not found for this trip.', 404);
      }

      if (payment.advance_status !== PAYMENT_STATUS.PAID) {
        throw new AppError(
          ERROR_CODES.VALIDATION_ERROR,
          'Cannot settle final payment. Advance 80% must be paid first.',
          400
        );
      }

      if (payment.balance_status === PAYMENT_STATUS.PAID) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Trip balance has already been settled and paid.', 400);
      }

      // If body contains override fields, use them, otherwise use requested values in payment.deductions
      const { shortage_mt, shortage_amount, damage_amount, delay_penalty, other_expense_amount, other_expense_reason } = req.body;

      let shortageAmt = payment.deductions?.shortage_amount || 0;
      let damageAmt = payment.deductions?.damage_amount || 0;
      let delayAmt = payment.deductions?.delay_penalty || 0;
      let otherAmt = payment.deductions?.other_expense_amount || 0;
      let otherReason = payment.deductions?.other_expense_reason || '';
      let shortageMtVal = payment.deductions?.shortage_mt || 0;

      // Allow admin override from request body if present
      if (shortage_amount !== undefined) shortageAmt = Number(shortage_amount);
      if (damage_amount !== undefined) damageAmt = Number(damage_amount);
      if (delay_penalty !== undefined) delayAmt = Number(delay_penalty);
      if (other_expense_amount !== undefined) otherAmt = Number(other_expense_amount);
      if (other_expense_reason !== undefined) otherReason = other_expense_reason;
      if (shortage_mt !== undefined) shortageMtVal = Number(shortage_mt);

      const totalDeductions = shortageAmt + damageAmt + delayAmt + otherAmt;
      const finalPayable = Math.max(0, payment.balance_amount - totalDeductions);

      // 3. Fetch Broker's payment details
      const broker = await db.collection('brokers').findOne({ _id: trip.broker_id, institution });
      if (!broker) {
        throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Broker profile not found.', 404);
      }

      if (!broker.payment_details || (!broker.payment_details.bank_account && !broker.payment_details.upi_id)) {
        throw new AppError(
          ERROR_CODES.VALIDATION_ERROR,
          'Broker has not configured bank details or UPI ID.',
          400
        );
      }

      // 4. Trigger bank/UPI Payout
      const payoutResult = await paymentService.initiateBrokerPayout(
        broker.payment_details,
        finalPayable,
        `Final Settlement for Trip ${trip.trip_id}`
      );

      // 5. Update Payment ledger & Trip status to SETTLED
      const paymentUpdate = {
        'deductions.shortage_mt': shortageMtVal,
        'deductions.shortage_amount': shortageAmt,
        'deductions.damage_amount': damageAmt,
        'deductions.delay_penalty': delayAmt,
        'deductions.other_expense_amount': otherAmt,
        'deductions.other_expense_reason': otherReason,
        'deductions.total_deductions': totalDeductions,
        final_payable: finalPayable,
        balance_status: PAYMENT_STATUS.PAID,
        balance_paid_at: new Date(),
        updated_at: new Date()
      };

      await db.collection('payments').updateOne({ _id: payment._id }, { $set: paymentUpdate });
      await db.collection('trips').updateOne(
        { _id: trip._id, institution },
        { 
          $set: { 
            status: TRIP_STATUS.SETTLED,
            'lifecycle.current_step': 8,
            'lifecycle.step_8': {
              completed: true,
              timestamp: new Date(),
              audit_status: 'approved',
              balance_status: 'paid',
              deductions: {
                shortage_mt: shortageMtVal,
                shortage_amount: shortageAmt,
                damage_amount: damageAmt,
                delay_penalty: delayAmt,
                other_expense_amount: otherAmt,
                total_deductions: totalDeductions
              }
            },
            updated_at: new Date() 
          } 
        }
      );

      logger.info(`Trip ${trip.trip_id} fully settled under ${institution}. Transferred final payout: INR ${finalPayable}`);

      // Invalidate caches
      await cache.delete(`trip:${trip_id}:${institution}`);
      await cache.delete(`trip:active:count:${institution}`);
      await cache.delete(`dashboard:settlement:${institution}`);

      return res.success({
        message: 'Trip settled successfully. Payout dispatched to broker account.',
        payout_id: payoutResult.payout_id,
        final_payout_amount: finalPayable,
        deductions_applied: totalDeductions
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get payment details for a trip
   * Route: GET /api/payments/:trip_id
   * Access: Admin & Client (Manager)
   */
  async getPaymentDetails(req, res, next) {
    try {
      const { trip_id } = req.params;
      const db = getDb();
      const institution = req.user.institution || 'IGSL';

      const payment = await db.collection('payments').findOne({ trip_id: new ObjectId(trip_id), institution });
      if (!payment) {
        throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Payment ledger for this trip not found.', 404);
      }

      return res.success(payment);
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new PaymentController();
