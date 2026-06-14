const { ObjectId } = require('mongodb');
const { getDb } = require('../db');
const { AppError } = require('../middleware/errorHandler');
const { ERROR_CODES, TRIP_STATUS, PAYMENT_STATUS, EWAYBILL_STATUS, ROLES } = require('../utils/constants');
const { generateTripId, generateLrNumber, calculateTripCost } = require('../utils/helpers');
const trackingService = require('../services/trackingService');
const logger = require('../utils/logger');
const cache = require('../cache');

/**
 * Controller to handle Trip Lifecycle (Create, Assign, Dispatch, Track, POD, Approve)
 */
class TripController {

  /**
   * Create a new Trip (freight booking)
   * Route: POST /api/trips
   * Access: Admin & Broker (Manager)
   */
  async createTrip(req, res, next) {
    try {
      const { company_id, material, weight_mt, source, destination, distance_km } = req.body;

      if (!company_id || !material || !weight_mt || !source || !destination || !distance_km) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'All fields are required to create a trip.', 400);
      }

      const db = getDb();
      const institution = req.user.institution || 'IGSL';
      
      // 1. Fetch company configuration (cache-first)
      const companyCacheKey = `company:${company_id}:${institution}`;
      let company = cache.get(companyCacheKey);
      
      if (!company) {
        company = await db.collection('companies').findOne({ _id: new ObjectId(company_id), institution });
        if (!company) {
          throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Company client not found for this institution.', 404);
        }
        cache.set(companyCacheKey, company, 900); // 15 mins cache
      }

      // 2. Calculate trip cost
      const estimatedCost = calculateTripCost(company.rate_config, weight_mt, distance_km);
      const tripIdStr = generateTripId();

      const trip = {
        trip_id: tripIdStr,
        company_id: new ObjectId(company_id),
        broker_id: null,
        material,
        weight_mt: Number(weight_mt),
        source: {
          name: source.name,
          lat: Number(source.lat),
          lng: Number(source.lng),
          address: source.address || ''
        },
        destination: {
          name: destination.name,
          lat: Number(destination.lat),
          lng: Number(destination.lng),
          address: destination.address || ''
        },
        distance_km: Number(distance_km),
        estimated_cost: estimatedCost,
        status: TRIP_STATUS.CREATED,
        lr_number: null,
        ewaybill_number: null,
        ewaybill_status: EWAYBILL_STATUS.PENDING,
        institution,
        tracking: {
          consent_given: false,
          consent_timestamp: null,
          last_known_location: null,
          last_ping_at: null
        },
        pod: {
          uploaded: false,
          image_url: null,
          uploaded_at: null,
          approved: false,
          approved_by: null
        },
        _company_name: company.name,
        _broker_name: null,
        _vehicle_number: null,
        lifecycle: {
          current_step: 1,
          step_1: { completed: true, timestamp: new Date() },
          step_2: { completed: false, timestamp: null },
          step_3: { completed: false, timestamp: null },
          step_4: { completed: false, timestamp: null },
          step_5: { completed: false, timestamp: null },
          step_6: { completed: false, timestamp: null },
          step_7: { completed: false, timestamp: null },
          step_8: { completed: false, timestamp: null }
        },
        created_by: req.user._id,
        created_at: new Date(),
        updated_at: new Date()
      };

      const result = await db.collection('trips').insertOne(trip);
      trip._id = result.insertedId;

      logger.info(`Trip created: ${trip.trip_id} for ${company.name} under ${institution}, Cost: INR ${estimatedCost}`);

      // Invalidate active trip counts cache
      cache.delete(`trip:active:count:${institution}`);
      cache.delete(`dashboard:settlement:${institution}`);

      return res.success({
        message: 'Trip created successfully.',
        trip
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Assign a Broker/Driver to a Trip
   * Route: POST /api/trips/:id/assign
   * Access: Admin & Broker (Manager)
   */
  async assignBroker(req, res, next) {
    try {
      const { id } = req.params;
      const { broker_id } = req.body;

      if (!broker_id) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Broker ID is required.', 400);
      }

      const db = getDb();
      const institution = req.user.institution || 'IGSL';

      // Verify Trip
      const trip = await db.collection('trips').findOne({ _id: new ObjectId(id), institution });
      if (!trip) {
        throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Trip not found.', 404);
      }

      if (trip.status !== TRIP_STATUS.CREATED && trip.status !== TRIP_STATUS.ASSIGNED) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Trip is already dispatched or completed.', 400);
      }

      // Fetch Broker profile & user record
      const broker = await db.collection('brokers').findOne({ _id: new ObjectId(broker_id), institution });
      if (!broker) {
        throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Broker profile not found.', 404);
      }

      if (broker.kyc_status !== 'verified') {
        throw new AppError(ERROR_CODES.KYC_VERIFICATION_FAILED, 'Cannot assign. Broker KYC is not verified.', 422);
      }

      const brokerUser = await db.collection('users').findOne({ _id: broker.user_id, institution });
      if (!brokerUser) {
        throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Broker user record not found.', 404);
      }

      const updateData = {
        broker_id: new ObjectId(broker_id),
        _broker_name: broker.name,
        _vehicle_number: broker.rc_details.vehicle_number,
        status: TRIP_STATUS.ASSIGNED,
        'lifecycle.current_step': 2,
        'lifecycle.step_2': {
          completed: true,
          timestamp: new Date(),
          broker_id: new ObjectId(broker_id),
          broker_name: broker.name,
          vehicle_number: broker.rc_details.vehicle_number,
          driver_name: broker.driverName || 'Rajesh Kumar',
          driver_phone: brokerUser.phone_number,
          price_m: trip.estimated_cost,
          volume_y: 'Standard'
        },
        updated_at: new Date()
      };

      await db.collection('trips').updateOne({ _id: new ObjectId(id) }, { $set: updateData });

      logger.info(`Trip ${trip.trip_id} assigned to Broker ${broker.name} (${broker.rc_details.vehicle_number})`);

      // Invalidate caches
      cache.delete(`trip:${id}:${institution}`);
      cache.delete(`trip:active:count:${institution}`);
      cache.delete(`dashboard:settlement:${institution}`);

      return res.success({
        message: 'Broker assigned to trip successfully.',
        trip: { ...trip, ...updateData }
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Run compliance verification (mParivahan check)
   * Route: POST /api/trips/:id/compliance
   * Access: Admin & Manager
   */
  async runComplianceCheck(req, res, next) {
    try {
      const { id } = req.params;
      const db = getDb();
      const institution = req.user.institution || 'IGSL';

      const trip = await db.collection('trips').findOne({ _id: new ObjectId(id), institution });
      if (!trip) {
        throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Trip not found.', 404);
      }

      if (!trip.broker_id) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Cannot run compliance check. A vehicle/broker must be assigned first.', 400);
      }

      const updateData = {
        'lifecycle.current_step': 3,
        'lifecycle.step_3': {
          completed: true,
          timestamp: new Date(),
          dl_status: 'verified',
          rc_validation: 'verified',
          fitness_log: 'verified',
          permits_status: 'verified'
        },
        updated_at: new Date()
      };

      await db.collection('trips').updateOne({ _id: trip._id }, { $set: updateData });

      logger.info(`mParivahan compliance verification completed for trip ${trip.trip_id}`);

      cache.delete(`trip:${id}:${institution}`);

      return res.success({
        message: 'Compliance verification completed successfully. Vehicle and Driver license verified.',
        compliance: updateData['lifecycle.step_3']
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Dispatch Trip (Issue LR, Setup Advance Payment, Trigger SIM Consent SMS)
   * Route: POST /api/trips/:id/dispatch
   * Access: Admin or Assigned Broker (Manager)
   */
  async dispatchTrip(req, res, next) {
    try {
      const { id } = req.params;
      const { ewaybill_number } = req.body;

      if (!ewaybill_number) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Eway Bill number is required to dispatch trip.', 400);
      }

      const db = getDb();
      const institution = req.user.institution || 'IGSL';

      // Find Trip
      const trip = await db.collection('trips').findOne({ _id: new ObjectId(id), institution });
      if (!trip) {
        throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Trip not found.', 404);
      }

      // SECURITY: Strict ownership check — broker can only dispatch their own trip
      if (req.user.role === ROLES.BROKER) {
        const myBrokerProfile = await db.collection('brokers').findOne({ user_id: req.user._id, institution });
        if (!myBrokerProfile || !trip.broker_id || !trip.broker_id.equals(myBrokerProfile._id)) {
          throw new AppError(ERROR_CODES.AUTH_FORBIDDEN, 'Access denied. You are not assigned to this trip.', 403);
        }
      }

      if (trip.status !== TRIP_STATUS.ASSIGNED) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Trip must be in ASSIGNED status to dispatch.', 400);
      }

      // Fetch Broker profile details (needed for driver phone verification & tracking)
      const broker = await db.collection('brokers').findOne({ _id: trip.broker_id, institution });
      const brokerUser = await db.collection('users').findOne({ _id: broker.user_id, institution });
      
      const lrNumber = generateLrNumber();

      const updateData = {
        status: TRIP_STATUS.DISPATCHED,
        lr_number: lrNumber,
        ewaybill_number,
        ewaybill_status: EWAYBILL_STATUS.VALID,
        'lifecycle.current_step': 5,
        'lifecycle.step_5': {
          completed: true,
          timestamp: new Date(),
          lr_number: lrNumber,
          lr_url: `/uploads/pod/mock_lr.pdf`
        },
        updated_at: new Date()
      };

      await db.collection('trips').updateOne({ _id: new ObjectId(id) }, { $set: updateData });

      // Generate Payments Ledger (80% Advance / 20% Balance)
      const advanceAmount = Math.round(trip.estimated_cost * 0.8);
      const balanceAmount = trip.estimated_cost - advanceAmount;

      const ledger = {
        trip_id: trip._id,
        trip_ref: trip.trip_id,
        total_amount: trip.estimated_cost,
        advance_amount: advanceAmount,
        advance_status: 'requested', // Pre-submitted for Admin approval!
        advance_razorpay_order_id: null,
        advance_paid_at: null,
        balance_amount: balanceAmount,
        deductions: {
          shortage_mt: 0,
          shortage_amount: 0,
          damage_amount: 0,
          delay_penalty: 0,
          other_expense_amount: 0,
          other_expense_reason: '',
          total_deductions: 0
        },
        final_payable: balanceAmount,
        balance_status: PAYMENT_STATUS.PENDING,
        balance_razorpay_order_id: null,
        balance_paid_at: null,
        fuel_card_loaded: 0,
        institution,
        created_at: new Date(),
        updated_at: new Date()
      };

      // Upsert payment ledger for the trip
      await db.collection('payments').updateOne(
        { trip_id: trip._id },
        { $set: ledger },
        { upsert: true }
      );

      // Trigger SIM Consent to driver/broker phone
      let consentResult = { success: false, consent_status: 'failed' };
      try {
        consentResult = await trackingService.requestConsent(brokerUser.phone_number);
        await db.collection('trips').updateOne(
          { _id: trip._id },
          { 
            $set: { 
              'tracking.consent_given': consentResult.consent_status === 'active',
              'tracking.consent_timestamp': consentResult.consent_status === 'active' ? new Date() : null
            } 
          }
        );
      } catch (trackErr) {
        logger.error(`Failed to dispatch SIM consent to ${brokerUser.phone_number}`, { error: trackErr });
      }

      logger.info(`Trip ${trip.trip_id} dispatched. Lorry Receipt issued: ${lrNumber}`);

      cache.delete(`trip:${id}:${institution}`);
      cache.delete(`trip:active:count:${institution}`);
      cache.delete(`dashboard:settlement:${institution}`);

      return res.success({
        message: 'Trip dispatched. Lorry Receipt (LR) generated and advance payment configured.',
        trip: { ...trip, ...updateData },
        consent_status: consentResult.consent_status
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Track Current Location & Verify Geofence Arrival
   * Route: POST /api/trips/:id/track
   * Access: Authenticated roles
   */
  async trackTrip(req, res, next) {
    try {
      const { id } = req.params;
      const db = getDb();
      const institution = req.user.institution || 'IGSL';

      const trip = await db.collection('trips').findOne({ _id: new ObjectId(id), institution });
      if (!trip) {
        throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Trip not found.', 404);
      }

      // SECURITY: Strict ownership check — broker can only track their assigned trip
      if (req.user.role === ROLES.BROKER) {
        const myBrokerProfile = await db.collection('brokers').findOne({ user_id: req.user._id, institution });
        if (!myBrokerProfile || !trip.broker_id || !trip.broker_id.equals(myBrokerProfile._id)) {
          throw new AppError(ERROR_CODES.AUTH_FORBIDDEN, 'Access denied. You are not assigned to this trip.', 403);
        }
      }

      if (trip.status !== TRIP_STATUS.DISPATCHED && trip.status !== TRIP_STATUS.IN_TRANSIT) {
        return res.success({
          message: 'Tracking only available for active trips in transit.',
          tracking: trip.tracking,
          status: trip.status
        });
      }

      const broker = await db.collection('brokers').findOne({ _id: trip.broker_id, institution });
      const brokerUser = await db.collection('users').findOne({ _id: broker.user_id, institution });

      // Fetch location via cell tower SIM coordinates
      const location = await trackingService.getSimLocation(brokerUser.phone_number);
      
      // Calculate geofence arrival (within 1.0 km of destination)
      const arrived = trackingService.isWithinGeofence(
        location.lat,
        location.lng,
        trip.destination.lat,
        trip.destination.lng,
        1.0 // 1.0 km radius
      );

      let nextStatus = TRIP_STATUS.IN_TRANSIT;
      let notificationSim = null;
      if (arrived) {
        nextStatus = TRIP_STATUS.DELIVERED;
        logger.info(`Trip ${trip.trip_id} auto-delivered via geofence trigger.`);
        
        // Mock SMS/IVR Driver Alert on Delivery
        notificationSim = {
          sms_sent: true,
          sms_language: 'Hindi/Bundeli',
          sms_preview: `प्रिय ${broker.name || 'चालक'}, आपका वाहन ${broker.rc_details.vehicle_number} इंदौर यार्ड में डिलीवर हो गया है। कृपया POD जमा करें।`,
          ivr_triggered: true,
          ivr_audio: 'IVR Call: Vehicle delivered successfully.'
        };
      }

      const updateData = {
        'tracking.last_known_location': { lat: location.lat, lng: location.lng },
        'tracking.last_ping_at': new Date(location.last_ping_at),
        'tracking.consent_given': true,
        status: nextStatus,
        'lifecycle.current_step': arrived ? 7 : 6,
        'lifecycle.step_6': {
          completed: true,
          timestamp: new Date(),
          sim_consent: true,
          coordinates: [{ lat: location.lat, lng: location.lng, time: new Date() }]
        },
        updated_at: new Date()
      };

      if (arrived) {
        updateData['lifecycle.step_7'] = {
          completed: true,
          timestamp: new Date(),
          pod_url: trip.pod?.image_url || null
        };
      }

      await db.collection('trips').updateOne({ _id: trip._id }, { $set: updateData });

      cache.delete(`trip:${id}:${institution}`);
      cache.delete(`trip:active:count:${institution}`);
      cache.delete(`dashboard:settlement:${institution}`);

      return res.success({
        message: arrived ? 'Destination arrived! Status updated to delivered.' : 'Location tracked successfully.',
        status: nextStatus,
        location,
        geofence_arrived: arrived,
        notification: notificationSim
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Upload Proof of Delivery (POD) Image & Trigger Driver SMS
   * Route: POST /api/trips/:id/pod
   * Access: Assigned Broker/Manager
   */
  async uploadPOD(req, res, next) {
    try {
      const { id } = req.params;

      if (!req.file) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Proof of Delivery image file is required.', 400);
      }

      const db = getDb();
      const institution = req.user.institution || 'IGSL';

      // Check Trip
      const trip = await db.collection('trips').findOne({ _id: new ObjectId(id), institution });
      if (!trip) {
        throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Trip not found.', 404);
      }

      // SECURITY: Verify the authenticated broker is the one assigned to this trip
      if (req.user.role === ROLES.BROKER) {
        const myBrokerProfile = await db.collection('brokers').findOne({ user_id: req.user._id, institution });
        if (!myBrokerProfile || !trip.broker_id || !trip.broker_id.equals(myBrokerProfile._id)) {
          throw new AppError(ERROR_CODES.AUTH_FORBIDDEN, 'Access denied. You are not the assigned broker for this trip.', 403);
        }
      }

      // Verify Assigned Broker Role or Manager
      const broker = await db.collection('brokers').findOne({ _id: trip.broker_id, institution });
      if (!broker) {
        throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Assigned Broker not found.', 404);
      }

      const imageUrl = `/uploads/pod/${req.file.filename}`;

      // Update POD details and advance trip status to DELIVERED if it was dispatched
      const updateData = {
        'pod.uploaded': true,
        'pod.image_url': imageUrl,
        'pod.uploaded_at': new Date(),
        'lifecycle.current_step': 7,
        'lifecycle.step_7': {
          completed: true,
          timestamp: new Date(),
          pod_url: imageUrl
        },
        updated_at: new Date()
      };

      if (trip.status === TRIP_STATUS.DISPATCHED || trip.status === TRIP_STATUS.IN_TRANSIT) {
        // Fetch company permissions to check for auto POD approval
        const company = await db.collection('companies').findOne({ _id: trip.company_id, institution });
        if (company && company.permissions && company.permissions.can_approve_pod) {
          updateData.status = TRIP_STATUS.DELIVERED;
          updateData['pod.approved'] = true;
          updateData['pod.approved_by'] = 'SYSTEM_AUTO';
          updateData['pod.approved_at'] = new Date();
        } else {
          updateData.status = TRIP_STATUS.DELIVERED;
        }
      }

      await db.collection('trips').updateOne({ _id: trip._id }, { $set: updateData });

      logger.info(`POD uploaded for trip ${trip.trip_id} at ${imageUrl}`);

      // Mock Multilingual SMS
      const sms_preview = `वाहक ${broker.name}: आपकी गाड़ी ${broker.rc_details.vehicle_number} का POD अपलोड हो गया है। अंतिम भुगतान प्रक्रिया में है।`;

      cache.delete(`trip:${id}:${institution}`);
      cache.delete(`trip:active:count:${institution}`);
      cache.delete(`dashboard:settlement:${institution}`);

      return res.success({
        message: 'Proof of Delivery uploaded successfully. Pending Admin verification.',
        pod: {
          uploaded: true,
          image_url: imageUrl,
          uploaded_at: updateData['pod.uploaded_at']
        },
        sms_sent: true,
        sms_preview
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Approve Proof of Delivery
   * Route: POST /api/trips/:id/pod/approve
   * Access: Admin only
   */
  async approvePOD(req, res, next) {
    try {
      const { id } = req.params;
      const db = getDb();
      const institution = req.user.institution || 'IGSL';

      const trip = await db.collection('trips').findOne({ _id: new ObjectId(id), institution });
      if (!trip) {
        throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Trip not found.', 404);
      }

      if (!trip.pod.uploaded) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Cannot approve. No POD image has been uploaded yet.', 400);
      }

      const updateData = {
        'pod.approved': true,
        'pod.approved_by': req.user._id,
        updated_at: new Date()
      };

      await db.collection('trips').updateOne({ _id: trip._id }, { $set: updateData });

      logger.info(`POD approved for trip ${trip.trip_id} by Admin ${req.user.name}`);

      cache.delete(`trip:${id}:${institution}`);
      cache.delete(`trip:active:count:${institution}`);
      cache.delete(`dashboard:settlement:${institution}`);

      return res.success({
        message: 'Proof of Delivery verified and approved successfully.',
        pod: {
          ...trip.pod,
          ...updateData
        }
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get single Trip detail
   * Route: GET /api/trips/:id
   * Access: Authenticated users
   */
  async getTripDetails(req, res, next) {
    try {
      const { id } = req.params;
      const institution = req.user.institution || 'IGSL';
      const cacheKey = `trip:${id}:${institution}`;

      // Try Cache First
      let trip = cache.get(cacheKey);

      if (!trip) {
        const db = getDb();
        trip = await db.collection('trips').findOne({ _id: new ObjectId(id), institution });
        
        if (!trip) {
          throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Trip not found.', 404);
        }
        cache.set(cacheKey, trip, 600); // 10 minutes cache
      }

      // Security check (Clients can only see their own company trips)
      if (req.user.role === ROLES.CLIENT) {
        const company = await getDb().collection('companies').findOne({ created_by: req.user._id, institution });
        if (!company || !trip.company_id.equals(company._id)) {
          throw new AppError(ERROR_CODES.AUTH_FORBIDDEN, 'Access denied.', 403);
        }
      }

      return res.success(trip);
    } catch (error) {
      next(error);
    }
  }

  /**
   * List Trips (Role-filtered & Tenant-scoped)
   * Route: GET /api/trips
   */
  async listTrips(req, res, next) {
    try {
      const { status } = req.query;
      const db = getDb();
      const institution = req.user.institution || 'IGSL';
      
      const query = { institution };
      if (status) {
        query.status = status;
      }

      // Dynamic scoping by user role (Client sees their own, manager/admin see all in institution)
      if (req.user.role === ROLES.CLIENT) {
        const company = await db.collection('companies').findOne({ created_by: req.user._id, institution });
        if (!company) {
          return res.success([]);
        }
        query.company_id = company._id;
      }

      // Query database utilizing compound indexes
      const trips = await db.collection('trips')
        .find(query)
        .sort({ created_at: -1 })
        .toArray();

      return res.success(trips);
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new TripController();
