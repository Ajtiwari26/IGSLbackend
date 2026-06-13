process.env.NODE_ENV = 'test';
process.env.MOCK_DB = process.env.MOCK_DB || 'false';
process.env.JWT_SECRET = 'test_jwt_secret_value_12345';

const request = require('supertest');
const app = require('../server');
const { getDb } = require('../db');

describe('IQSL Logistics Platform E2E Integration Flow', () => {
  let adminToken;
  let brokerToken;
  let companyId;
  let brokerId;
  let tripId;
  let tripObjectId;

  // Cleanup/Init before tests
  beforeAll(async () => {
    // Clear caches/mock db if any
    const db = getDb();
    db.collection('users').data = [];
    db.collection('companies').data = [];
    db.collection('brokers').data = [];
    db.collection('trips').data = [];
    db.collection('payments').data = [];
    db.collection('otp_sessions').data = [];
  });

  // 1. Authentication Flow
  describe('1. Authentication & Role Provisioning', () => {
    it('should generate an OTP code for Admin phone number', async () => {
      const res = await request(app)
        .post('/api/auth/otp/send')
        .send({ phone_number: '9900000000' }); // Admin number contains '0000'

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.otp).toBe('123456');
    });

    it('should verify OTP and issue an Admin JWT', async () => {
      const res = await request(app)
        .post('/api/auth/otp/verify')
        .send({
          phone_number: '9900000000',
          otp: '123456',
          role: 'admin',
          name: 'Super Admin'
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.token).toBeDefined();
      expect(res.body.data.user.role).toBe('admin');
      
      adminToken = res.body.data.token;
    });

    it('should generate an OTP code for Broker phone number', async () => {
      const res = await request(app)
        .post('/api/auth/otp/send')
        .send({ phone_number: '9876543219' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.otp).toBe('123456');
    });

    it('should verify OTP and issue a Broker JWT', async () => {
      const res = await request(app)
        .post('/api/auth/otp/verify')
        .send({
          phone_number: '9876543219',
          otp: '123456',
          role: 'broker',
          name: 'Suresh Transport'
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.token).toBeDefined();
      expect(res.body.data.user.role).toBe('broker');

      brokerToken = res.body.data.token;
    });
  });

  // 2. Onboarding Flow
  describe('2. Client & Broker Onboarding', () => {
    it('should allow Admin to onboard a Corporate Client (Company)', async () => {
      const res = await request(app)
        .post('/api/onboarding/company')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'JSW Steel Ltd',
          gstin: '29AAFCC1031R1Z1',
          pan_number: 'AAFCC1031R',
          billing_address: {
            line1: 'Vidyanagar',
            city: 'Toranagallu',
            state: 'Karnataka',
            pincode: '583123'
          },
          locations: [
            { name: 'Loading Gate 1', lat: 15.2012, lng: 76.6214 }
          ],
          rate_config: {
            type: 'per_mt_per_km',
            base_rate: 4.5 // INR per Metric Tonne per Kilometer
          }
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.company._id).toBeDefined();
      companyId = res.body.data.company._id;
    });

    it('should fail company onboarding if non-admin attempts it', async () => {
      const res = await request(app)
        .post('/api/onboarding/company')
        .set('Authorization', `Bearer ${brokerToken}`)
        .send({
          name: 'Hacker Corp',
          gstin: '29AAFCC1031R1Z1',
          pan_number: 'AAFCC1031R',
          rate_config: { type: 'fixed', base_rate: 1000 }
        });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('AUTH_FORBIDDEN');
    });

    it('should allow Broker to complete KYC and onboard their profile', async () => {
      const res = await request(app)
        .post('/api/onboarding/broker')
        .set('Authorization', `Bearer ${brokerToken}`)
        .send({
          name: 'Suresh Transport Services',
          pan_number: 'BQRPS5678A',
          dl_number: 'KA0420180009999',
          rc_details: {
            vehicle_number: 'KA04AB9999',
            vehicle_type: 'trailer',
            rc_expiry: '2030-01-01'
          },
          payment_details: {
            bank_account: '998877665544',
            ifsc: 'SBIN0001002',
            upi_id: 'suresh@ybl'
          }
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.broker.kyc_status).toBe('verified');
      brokerId = res.body.data.broker._id;
    });
  });

  // 3. Trip Lifecycle Flow
  describe('3. Trip Lifecycle & Dispatch Operations', () => {
    it('should allow Admin to create a Trip and calculate estimated cost', async () => {
      const res = await request(app)
        .post('/api/trips')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          company_id: companyId,
          material: 'HR Steel Coils',
          weight_mt: 25.5, // 25.5 metric tonnes
          source: {
            name: 'JSW Janki Plant',
            lat: 15.2012,
            lng: 76.6214,
            address: 'Toranagallu, Bellary'
          },
          destination: {
            name: 'IQSL Chennai Yard',
            lat: 13.0827,
            lng: 80.2707,
            address: 'Ennore Port Road, Chennai'
          },
          distance_km: 550 // 550 km
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.trip.trip_id).toBeDefined();
      expect(res.body.data.trip.estimated_cost).toBe(25.5 * 550 * 4.5); // per_mt_per_km calculation

      tripId = res.body.data.trip.trip_id;
      tripObjectId = res.body.data.trip._id;
    });

    it('should allow Admin to assign a verified Broker to the trip', async () => {
      const res = await request(app)
        .post(`/api/trips/${tripObjectId}/assign`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ broker_id: brokerId });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.trip.status).toBe('assigned');
      expect(res.body.data.trip._vehicle_number).toBe('KA04AB9999');
    });

    it('should allow Broker to dispatch trip and trigger e-Way Bill config', async () => {
      const res = await request(app)
        .post(`/api/trips/${tripObjectId}/dispatch`)
        .set('Authorization', `Bearer ${brokerToken}`)
        .send({ ewaybill_number: '881234567890' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.trip.status).toBe('dispatched');
      expect(res.body.data.trip.lr_number).toBeDefined(); // LR generated
    });
  });

  // 4. Financial Advance Flow
  describe('4. Advance Payment (80%) Execution', () => {
    it('should allow Admin to initiate advance payment order ID', async () => {
      const res = await request(app)
        .post(`/api/payments/${tripObjectId}/advance/initiate`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.order_id).toBeDefined();
      expect(res.body.data.amount_paise).toBeDefined();
    });

    it('should verify payment signature and set advance status as PAID', async () => {
      const res = await request(app)
        .post(`/api/payments/${tripObjectId}/advance/verify`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          payment_id: 'pay_ABC123XYZ',
          signature: 'mock_signature_approved'
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.payment.advance_status).toBe('paid');
    });
  });

  // 5. Tracking & Delivery POD Flow
  describe('5. Cell-Tower Tracking & POD Verification', () => {
    it('should track driver location and handle cellular drift', async () => {
      const res = await request(app)
        .post(`/api/trips/${tripObjectId}/track`)
        .set('Authorization', `Bearer ${brokerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.location.lat).toBeDefined();
      expect(res.body.data.location.lng).toBeDefined();
    });

    it('should allow Broker to upload POD image to mark cargo delivered', async () => {
      // Create a mock image buffer for upload testing
      const mockImage = Buffer.from('fake-image-binary-data');

      const res = await request(app)
        .post(`/api/trips/${tripObjectId}/pod`)
        .set('Authorization', `Bearer ${brokerToken}`)
        .attach('pod', mockImage, 'pod_receipt.png');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.pod.uploaded).toBe(true);
      expect(res.body.data.pod.image_url).toBeDefined();
    });

    it('should allow Admin to approve uploaded POD image', async () => {
      const res = await request(app)
        .post(`/api/trips/${tripObjectId}/pod/approve`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.pod.approved).toBe(true);
    });
  });

  // 6. Settlement Flow
  describe('6. Shortage Deductions & Final Settlement Payout (20%)', () => {
    it('should settle trip with shortage and delay penalties', async () => {
      // Trip cost = 25.5 * 550 * 4.5 = 63,112.50 INR
      // 80% Advance = 50,490 INR
      // 20% Balance = 12,622.50 INR
      // Deduct shortage amount = 2,500 INR
      // Deduct delay penalty = 1,000 INR
      // Expected payout = 9,122.50 INR
      
      const res = await request(app)
        .post(`/api/payments/${tripObjectId}/settle`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          shortage_mt: 0.5,
          shortage_amount: 2500,
          damage_amount: 0,
          delay_penalty: 1000
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.payout_id).toBeDefined();
      expect(res.body.data.deductions_applied).toBe(3500);
      expect(res.body.data.final_payout_amount).toBeDefined();
    });

    it('should double-check dashboard counters and aggregations', async () => {
      const metricsRes = await request(app)
        .get('/api/admin/dashboard/metrics')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(metricsRes.status).toBe(200);
      expect(metricsRes.body.success).toBe(true);
      expect(metricsRes.body.data.trips.settled).toBe(1);

      const financesRes = await request(app)
        .get('/api/admin/dashboard/settlements')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(financesRes.status).toBe(200);
      expect(financesRes.body.success).toBe(true);
      expect(financesRes.body.data.total_deductions).toBe(3500);
    });
  });
});
