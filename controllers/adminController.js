const { getDb } = require('../db');
const { TRIP_STATUS, PAYMENT_STATUS } = require('../utils/constants');
const cache = require('../cache');
const logger = require('../utils/logger');

/**
 * Controller to aggregate Metrics, Dashboards, and Reports for Admins
 */
class AdminController {

  /**
   * Get High-Level Fleet & Trip Statistics (With 1-minute caching)
   * Route: GET /api/admin/dashboard/metrics
   * Access: Admin only
   */
  async getDashboardMetrics(req, res, next) {
    try {
      const institution = req.user.institution || 'IGSL';
      const cacheKey = `trip:active:count:${institution}`;
      let metrics = cache.get(cacheKey);

      if (!metrics) {
        logger.info(`Admin: Computing dashboard metrics for ${institution} (cache miss)...`);
        const db = getDb();

        // Run aggregation query to count trips by status for this institution
        const counts = await db.collection('trips').aggregate([
          { $match: { institution } },
          {
            $group: {
              _id: '$status',
              count: { $sum: 1 }
            }
          }
        ]).toArray();

        // Convert array to clean object mapping
        const statusMap = {
          created: 0,
          assigned: 0,
          dispatched: 0,
          in_transit: 0,
          delivered: 0,
          settled: 0,
          cancelled: 0,
          total: 0
        };

        let total = 0;
        counts.forEach(item => {
          if (item._id in statusMap) {
            statusMap[item._id] = item.count;
            total += item.count;
          }
        });
        statusMap.total = total;

        // Also query pending POD count
        const pendingPODs = await db.collection('trips').countDocuments({
          'pod.uploaded': true,
          'pod.approved': false,
          institution
        });

        metrics = {
          trips: statusMap,
          pending_pod_approvals: pendingPODs
        };

        // Cache result for 60 seconds
        cache.set(cacheKey, metrics, 60);
      }

      return res.success(metrics);
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get Financial Settlement Dashboard (Aggregates advance payments, settlements, and deductions)
   * Route: GET /api/admin/dashboard/settlements
   * Access: Admin only
   */
  async getSettlementDashboard(req, res, next) {
    try {
      const institution = req.user.institution || 'IGSL';
      const cacheKey = `dashboard:settlement:${institution}`;
      let financials = cache.get(cacheKey);

      if (!financials) {
        logger.info(`Admin: Computing financial settlement metrics for ${institution} (cache miss)...`);
        const db = getDb();

        // Run aggregation pipeline over payments collection
        const stats = await db.collection('payments').aggregate([
          { $match: { institution } },
          {
            $group: {
              _id: null,
              total_value: { $sum: '$total_amount' },
              total_advance_paid: {
                $sum: {
                  $cond: [{ $eq: ['$advance_status', PAYMENT_STATUS.PAID] }, '$advance_amount', 0]
                }
              },
              total_balance_paid: {
                $sum: {
                  $cond: [{ $eq: ['$balance_status', PAYMENT_STATUS.PAID] }, '$final_payable', 0]
                }
              },
              total_shortage_deducted: { $sum: '$deductions.shortage_amount' },
              total_damage_deducted: { $sum: '$deductions.damage_amount' },
              total_delay_deducted: { $sum: '$deductions.delay_penalty' },
              total_other_deducted: { $sum: '$deductions.other_expense_amount' },
              total_deductions: { $sum: '$deductions.total_deductions' }
            }
          }
        ]).toArray();

        const data = stats[0] || {
          total_value: 0,
          total_advance_paid: 0,
          total_balance_paid: 0,
          total_shortage_deducted: 0,
          total_damage_deducted: 0,
          total_delay_deducted: 0,
          total_other_deducted: 0,
          total_deductions: 0
        };

        // Remove the MongoDB group ID
        delete data._id;

        financials = {
          ...data,
          total_net_payout: data.total_advance_paid + data.total_balance_paid
        };

        // Cache result for 2 minutes (120 seconds)
        cache.set(cacheKey, financials, 120);
      }

      return res.success(financials);
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get List of Trips awaiting POD verification
   * Route: GET /api/admin/pods/pending
   * Access: Admin only
   */
  async getPendingPODs(req, res, next) {
    try {
      const db = getDb();
      const institution = req.user.institution || 'IGSL';
      
      const pendingTrips = await db.collection('trips')
        .find({
          'pod.uploaded': true,
          'pod.approved': false,
          institution
        })
        .sort({ 'pod.uploaded_at': 1 }) // oldest first to maintain SLA
        .toArray();

      return res.success(pendingTrips);
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get list of payments pending Admin approval (Advances or settlements)
   * Route: GET /api/admin/payments/pending
   * Access: Admin only
   */
  async getPendingPayments(req, res, next) {
    try {
      const db = getDb();
      const institution = req.user.institution || 'IGSL';

      const pendingPayments = await db.collection('payments')
        .find({
          institution,
          $or: [
            { advance_status: 'requested' },
            { balance_status: 'requested' }
          ]
        })
        .sort({ created_at: 1 })
        .toArray();

      return res.success(pendingPayments);
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new AdminController();
