const { MongoClient, ObjectId } = require('mongodb');
const logger = require('./utils/logger');

// Light-weight in-memory Mock MongoDB client for local development/testing without real DB
class MockCollection {
  constructor(name) {
    this.name = name;
    this.data = [];
  }

  async findOne(query) {
    return this.data.find(item => {
      for (const [key, value] of Object.entries(query)) {
        if (value && typeof value === 'object' && !(value instanceof ObjectId)) {
          if ('$ne' in value) {
            if (String(item[key]) === String(value.$ne)) return false;
          } else {
            return false;
          }
        } else {
          if (String(item[key]) !== String(value)) return false;
        }
      }
      return true;
    });
  }

  async insertOne(doc) {
    const id = doc._id || new ObjectId();
    const newDoc = { ...doc, _id: id };
    this.data.push(newDoc);
    return { insertedId: id };
  }

  async updateOne(query, update, options = {}) {
    let item = await this.findOne(query);
    if (!item) {
      if (options.upsert) {
        item = { ...query, _id: new ObjectId() };
        this.data.push(item);
      } else {
        return { matchedCount: 0, modifiedCount: 0 };
      }
    }

    if (update.$set) {
      // Handle nested updates (e.g. 'tracking.consent_given')
      for (const [key, val] of Object.entries(update.$set)) {
        if (key.includes('.')) {
          const parts = key.split('.');
          let current = item;
          for (let i = 0; i < parts.length - 1; i++) {
            if (!current[parts[i]]) current[parts[i]] = {};
            current = current[parts[i]];
          }
          current[parts[parts.length - 1]] = val;
        } else {
          item[key] = val;
        }
      }
    }

    if (update.$inc) {
      for (const [key, val] of Object.entries(update.$inc)) {
        item[key] = (item[key] || 0) + val;
      }
    }
    return { matchedCount: 1, modifiedCount: 1 };
  }

  async deleteOne(query) {
    const idx = this.data.findIndex(item => {
      for (const [key, value] of Object.entries(query)) {
        if (String(item[key]) !== String(value)) return false;
      }
      return true;
    });
    if (idx !== -1) {
      this.data.splice(idx, 1);
      return { deletedCount: 1 };
    }
    return { deletedCount: 0 };
  }

  find(query = {}) {
    let filtered = this.data;
    if (Object.keys(query).length > 0) {
      filtered = this.data.filter(item => {
        for (const [key, value] of Object.entries(query)) {
          if (String(item[key]) !== String(value)) return false;
        }
        return true;
      });
    }

    return {
      sort: () => ({
        toArray: async () => [...filtered].reverse() // mock sort by latest
      })
    };
  }

  async countDocuments(query = {}) {
    const res = this.find(query);
    const arr = await res.sort().toArray();
    return arr.length;
  }

  aggregate(pipeline) {
    let result = [];
    if (this.name === 'trips') {
      const counts = {};
      this.data.forEach(item => {
        counts[item.status] = (counts[item.status] || 0) + 1;
      });
      result = Object.entries(counts).map(([_id, count]) => ({ _id, count }));
    } else if (this.name === 'payments') {
      const totals = {
        total_amount: 0,
        advance_amount: 0,
        final_payable: 0,
        shortage_amount: 0,
        damage_amount: 0,
        delay_penalty: 0,
        total_deductions: 0
      };

      this.data.forEach(item => {
        totals.total_amount += item.total_amount || 0;
        if (item.advance_status === 'paid') {
          totals.advance_amount += item.advance_amount || 0;
        }
        if (item.balance_status === 'paid') {
          totals.final_payable += item.final_payable || 0;
        }
        totals.shortage_amount += item.deductions?.shortage_amount || 0;
        totals.damage_amount += item.deductions?.damage_amount || 0;
        totals.delay_penalty += item.deductions?.delay_penalty || 0;
        totals.total_deductions += item.deductions?.total_deductions || 0;
      });

      result = [{
        total_amount: totals.total_amount,
        total_advance_paid: totals.advance_amount,
        total_balance_paid: totals.final_payable,
        total_shortage_deducted: totals.shortage_amount,
        total_damage_deducted: totals.damage_amount,
        total_delay_deducted: totals.delay_penalty,
        total_deductions: totals.total_deductions
      }];
    }

    return {
      toArray: async () => result
    };
  }
}

class MockDb {
  constructor() {
    this.collections = {};
  }
  collection(name) {
    if (!this.collections[name]) {
      this.collections[name] = new MockCollection(name);
    }
    return this.collections[name];
  }
}

let client = null;
let db = null;
const mockDbInstance = new MockDb();

const poolConfig = {
  maxPoolSize: 5,             // B2B: 5 connections is plenty
  minPoolSize: 2,             // Keep 2 warm connections ready
  maxIdleTimeMS: 30000,       // Close idle connections after 30s
  connectTimeoutMS: 5000,     // Fail fast on connection issues
  serverSelectionTimeoutMS: 5000,
  retryWrites: true,          // Auto-retry on transient failures
  retryReads: true
};

async function connectDb() {
  const uri = process.env.MONGODB_URI;
  const isBypass = process.env.MOCK_DB === 'true';

  if (isBypass || !uri || uri.includes('YOUR_MONGODB_CONNECTION_STRING_HERE')) {
    logger.warn('⚠️ MONGODB_URI not provided or MOCK_DB is enabled. Running with in-memory Mock Database.');
    db = mockDbInstance;
    return db;
  }

  try {
    logger.info('Connecting to MongoDB...');
    client = new MongoClient(uri, poolConfig);
    await client.connect();
    
    // Extract database name from connection string or default to 'iqsl_logistics'
    const dbName = client.options.dbName || 'iqsl_logistics';
    db = client.db(dbName);
    
    logger.info(`Successfully connected to MongoDB database: ${dbName}`);
    
    // Setup indexes asynchronously so startup isn't blocked
    ensureIndexes(db).catch(err => {
      logger.error('Failed to create indexes', { error: err });
    });

    return db;
  } catch (error) {
    logger.error('Failed to connect to MongoDB, falling back to Mock DB', { error });
    db = mockDbInstance;
    return db;
  }
}

function getDb() {
  if (!db) {
    db = mockDbInstance; // transparent fallback
  }
  return db;
}

async function closeDb() {
  if (client) {
    await client.close();
    client = null;
    db = null;
    logger.info('MongoDB connection closed.');
  }
}

/**
 * Ensure all indexes from the System Design document are set up
 */
async function ensureIndexes(database) {
  logger.info('Ensuring database indexes...');

  // Helper to safely drop index if exists
  const safeDropIndex = async (collName, indexName) => {
    try {
      await database.collection(collName).dropIndex(indexName);
      logger.info(`Dropped old index ${indexName} from ${collName}`);
    } catch (err) {
      // ignore index not found
    }
  };

  // Drop old single-unique indexes to prevent composite migration errors
  await safeDropIndex('users', 'phone_number_1');
  await safeDropIndex('companies', 'gstin_1');
  await safeDropIndex('brokers', 'pan_number_1');

  // 1. users
  await database.collection('users').createIndex({ phone_number: 1, institution: 1 }, { unique: true });
  await database.collection('users').createIndex({ role: 1, is_active: 1 });

  // 2. companies
  await database.collection('companies').createIndex({ gstin: 1, institution: 1 }, { unique: true });
  await database.collection('companies').createIndex({ name: 1 });

  // 3. brokers
  await database.collection('brokers').createIndex({ user_id: 1 }, { unique: true });
  await database.collection('brokers').createIndex({ kyc_status: 1 });
  await database.collection('brokers').createIndex({ 'rc_details.vehicle_number': 1, institution: 1 });
  await database.collection('brokers').createIndex({ pan_number: 1, institution: 1 }, { unique: true });

  // 4. trips
  await database.collection('trips').createIndex({ trip_id: 1 }, { unique: true });
  await database.collection('trips').createIndex({ status: 1, created_at: -1 });
  await database.collection('trips').createIndex({ company_id: 1, status: 1 });
  await database.collection('trips').createIndex({ broker_id: 1, status: 1 });
  await database.collection('trips').createIndex({ status: 1, 'pod.approved': 1 });
  await database.collection('trips').createIndex({ lr_number: 1 });

  // 5. payments
  await database.collection('payments').createIndex({ trip_id: 1 }, { unique: true });
  await database.collection('payments').createIndex({ advance_status: 1 });
  await database.collection('payments').createIndex({ balance_status: 1, updated_at: -1 });

  // 6. otp_sessions (TTL index)
  await database.collection('otp_sessions').createIndex({ phone_number: 1 });
  await database.collection('otp_sessions').createIndex({ created_at: 1 }, { expireAfterSeconds: 300 });

  // 7. departments
  await database.collection('departments').createIndex({ name: 1, institution: 1 }, { unique: true });

  // 8. refresh_tokens (TTL index for automatic cleanup + lookup index)
  await database.collection('refresh_tokens').createIndex({ token: 1 }, { unique: true });
  await database.collection('refresh_tokens').createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
  await database.collection('refresh_tokens').createIndex({ user_id: 1 });

  logger.info('Database indexes configured successfully.');

  // Seed initial demo data for testing and local integration
  await seedDemoData(database);
}

/**
 * Seed MongoDB with default B2B Client and Admin entities for demo/testing
 */
async function seedDemoData(database) {
  try {
    const tenants = [
      {
        id: 'IGSL',
        adminPhone: '9900000000',
        managerPhone: '9876543210',
        companyId: new ObjectId('507f1f77bcf86cd799439011'),
        companyName: 'JSW Steel Ltd',
        gstin: '29AAFCC1031R1Z1',
        pan: 'AAFCC1031R',
        rateType: 'per_mt_per_km',
        rate: 4.5,
        brokerId: new ObjectId('507f1f77bcf86cd799439022'),
        brokerName: 'Suresh Transport Services',
        brokerPan: 'BQRPS5678A',
        vehicle: 'KA04AB9999',
        driverName: 'Rajesh Kumar',
        driverPhone: '9876543210',
        tripId: new ObjectId('6a2d02c02e2b60d04ca7ff1a'),
        tripRef: 'IQSL-2026-967690',
        material: 'Hot Rolled Steel Coils',
        weight: 30,
        distance: 740,
        cost: 99900
      },
      {
        id: 'INSTITUTION_A',
        adminPhone: '9900000001',
        managerPhone: '9876543211',
        companyId: new ObjectId('507f1f77bcf86cd799439012'),
        companyName: 'Adani Cement Corp',
        gstin: '29AAFCC1032R1Z2',
        pan: 'AAFCC1032R',
        rateType: 'per_mt',
        rate: 1200,
        brokerId: new ObjectId('507f1f77bcf86cd799439023'),
        brokerName: 'MP Roadlines',
        brokerPan: 'BQRPS5678B',
        vehicle: 'MP09AB1111',
        driverName: 'Amit Singh',
        driverPhone: '9876543211',
        tripId: new ObjectId('6a2d02c02e2b60d04ca7ff1b'),
        tripRef: 'IQSL-2026-A11111',
        material: 'Grade 43 OPC Cement',
        weight: 25,
        distance: 400,
        cost: 30000
      },
      {
        id: 'INSTITUTION_B',
        adminPhone: '9900000002',
        managerPhone: '9876543212',
        companyId: new ObjectId('507f1f77bcf86cd799439013'),
        companyName: 'Bansal Coal Yards',
        gstin: '29AAFCC1033R1Z3',
        pan: 'AAFCC1033R',
        rateType: 'fixed',
        rate: 50000,
        brokerId: new ObjectId('507f1f77bcf86cd799439024'),
        brokerName: 'Vindhya Freight Logistics',
        brokerPan: 'BQRPS5678C',
        vehicle: 'MP17BC2222',
        driverName: 'Vijay Patel',
        driverPhone: '9876543212',
        tripId: new ObjectId('6a2d02c02e2b60d04ca7ff1c'),
        tripRef: 'IQSL-2026-B22222',
        material: 'Bituminous Steam Coal',
        weight: 32,
        distance: 550,
        cost: 50000
      }
    ];

    for (const t of tenants) {
      // 0. Seed Default Departments
      const defaultDepts = ['Finance', 'Operations', 'Compliance', 'Tracking', 'Loading'];
      for (const dept of defaultDepts) {
        const existingDept = await database.collection('departments').findOne({ name: dept, institution: t.id });
        if (!existingDept) {
          await database.collection('departments').insertOne({
            name: dept,
            institution: t.id,
            created_at: new Date()
          });
        }
      }
      logger.info(`Seeded default departments for ${t.id}`);

      // 1. Seed Admin
      let admin = await database.collection('users').findOne({ phone_number: t.adminPhone, institution: t.id });
      if (!admin) {
        const res = await database.collection('users').insertOne({
          phone_number: t.adminPhone,
          role: 'admin',
          name: `${t.id} Admin`,
          institution: t.id,
          is_active: true,
          created_at: new Date(),
          updated_at: new Date()
        });
        admin = { _id: res.insertedId };
        logger.info(`Seeded admin user for ${t.id}`);
      }

      // 2. Seed Manager
      let manager = await database.collection('users').findOne({ phone_number: t.managerPhone, institution: t.id });
      if (!manager) {
        const res = await database.collection('users').insertOne({
          phone_number: t.managerPhone,
          role: 'client', // client role maps to Manager in frontend
          name: `${t.id} Manager`,
          institution: t.id,
          department: 'Operations',
          permissions: {
            can_create_jobs: true,
            can_verify_compliance: true,
            can_approve_payments: true,
            can_generate_lr: true,
            can_track_vehicles: true
          },
          is_active: true,
          created_at: new Date(),
          updated_at: new Date()
        });
        manager = { _id: res.insertedId };
        logger.info(`Seeded manager user for ${t.id}`);
      }

      // 3. Seed Company Client
      const existingCompany = await database.collection('companies').findOne({ _id: t.companyId });
      if (!existingCompany) {
        await database.collection('companies').insertOne({
          _id: t.companyId,
          name: t.companyName,
          gstin: t.gstin,
          pan_number: t.pan,
          institution: t.id,
          billing_address: {
            line1: 'Industrial Area',
            city: 'Bhopal',
            state: 'Madhya Pradesh',
            pincode: '462001'
          },
          locations: [
            { name: 'Loading Gate 1', lat: 23.2599, lng: 77.4126 }
          ],
          rate_config: {
            type: t.rateType,
            base_rate: t.rate
          },
          permissions: {
            can_view_telemetry: true,
            can_create_trips: true,
            can_approve_pod: false,
            credit_limit: 1000000
          },
          created_by: admin._id,
          created_at: new Date(),
          updated_at: new Date()
        });
        logger.info(`Seeded company client for ${t.id}`);
      }

      // 4. Seed Broker/Lorry
      const existingBroker = await database.collection('brokers').findOne({ _id: t.brokerId });
      if (!existingBroker) {
        await database.collection('brokers').insertOne({
          _id: t.brokerId,
          user_id: manager._id,
          name: t.brokerName,
          pan_number: t.brokerPan,
          dl_number: 'MP0420180009999',
          kyc_status: 'verified',
          institution: t.id,
          rc_details: {
            vehicle_number: t.vehicle,
            vehicle_type: 'trailer',
            rc_expiry: new Date('2030-01-01')
          },
          payment_details: {
            bank_account: '998877665544',
            ifsc: 'SBIN0001002'
          },
          created_at: new Date()
        });
        logger.info(`Seeded broker/lorry for ${t.id}`);
      }

      // 5. Seed Trip & Payment
      const existingTrip = await database.collection('trips').findOne({ _id: t.tripId });
      if (!existingTrip) {
        const dummyTrip = {
          _id: t.tripId,
          trip_id: t.tripRef,
          company_id: t.companyId,
          broker_id: t.brokerId,
          material: t.material,
          weight_mt: t.weight,
          source: {
            name: `${t.companyName} Plant`,
            lat: 23.2599,
            lng: 77.4126,
            address: 'Industrial Sector, Bhopal, MP'
          },
          destination: {
            name: 'Indore Logistics Yard',
            lat: 22.7196,
            lng: 75.8577,
            address: 'Indore Bypass Road, MP'
          },
          distance_km: t.distance,
          estimated_cost: t.cost,
          status: 'DELIVERED',
          lr_number: `LR-${t.id}-001`,
          ewaybill_number: '123456789012',
          ewaybill_status: 'valid',
          institution: t.id,
          tracking: {
            consent_given: true,
            consent_timestamp: new Date(),
            last_known_location: { lat: 22.7196, lng: 75.8577 },
            last_ping_at: new Date()
          },
          pod: {
            uploaded: true,
            image_url: 'https://lh3.googleusercontent.com/aida/AP1WRLvoGcDlLzIevoJdbVLSxvNIOGDVB_q3Z5fe88iMHmj_mpRz6gjd7j4x4-0GaAxPaJNgUiOg2pAE_zpjufzkHyTuql7HPOBoyqUflyNMrLdyfND63FPGx8DCYlk6khLmr_z-MtTm80_qiMzZHl5vUc0uoUzb4RWDeU7yWZvI6Bdjxop7mN4KaAa2cPfcr_7hqnX2M5HpATor5c59VpfnjpfhE1mpYLUQlgGg72om5CG-PY2_6LNZwFzvFBw',
            uploaded_at: new Date(),
            approved: false,
            approved_by: null
          },
          lifecycle: {
            current_step: 7,
            step_1: { completed: true, timestamp: new Date(Date.now() - 86400000 * 3) },
            step_2: { completed: true, timestamp: new Date(Date.now() - 86400000 * 3), broker_id: t.brokerId, broker_name: t.brokerName, vehicle_number: t.vehicle, driver_name: t.driverName, driver_phone: t.driverPhone, price_m: t.cost, volume_y: 'Standard' },
            step_3: { completed: true, timestamp: new Date(Date.now() - 86400000 * 2.8), dl_status: 'verified', rc_validation: 'verified', fitness_log: 'verified', permits_status: 'verified' },
            step_4: { completed: true, timestamp: new Date(Date.now() - 86400000 * 2.5), razorpay_order_id: 'pay_advance_seed_123' },
            step_5: { completed: true, timestamp: new Date(Date.now() - 86400000 * 2.4), lr_number: `LR-${t.id}-001`, lr_url: `/uploads/pod/mock_lr.pdf` },
            step_6: { completed: true, timestamp: new Date(Date.now() - 86400000 * 2.0), sim_consent: true, coordinates: [{ lat: 22.7196, lng: 75.8577, time: new Date(Date.now() - 86400000 * 2) }] },
            step_7: { completed: true, timestamp: new Date(Date.now() - 86400000 * 1), pod_url: 'https://lh3.googleusercontent.com/aida/AP1WRLvoGcDlLzIevoJdbVLSxvNIOGDVB_q3Z5fe88iMHmj_mpRz6gjd7j4x4-0GaAxPaJNgUiOg2pAE_zpjufzkHyTuql7HPOBoyqUflyNMrLdyfND63FPGx8DCYlk6khLmr_z-MtTm80_qiMzZHl5vUc0uoUzb4RWDeU7yWZvI6Bdjxop7mN4KaAa2cPfcr_7hqnX2M5HpATor5c59VpfnjpfhE1mpYLUQlgGg72om5CG-PY2_6LNZwFzvFBw' },
            step_8: { completed: false, timestamp: null, audit_status: 'pending', balance_status: 'pending', deductions: { shortage_mt: 0, shortage_amount: 0, damage_amount: 0, delay_penalty: 0, other_expense_amount: 0, total_deductions: 0 } }
          },
          _company_name: t.companyName,
          _broker_name: t.brokerName,
          _vehicle_number: t.vehicle,
          created_by: admin._id,
          created_at: new Date(),
          updated_at: new Date()
        };

        await database.collection('trips').insertOne(dummyTrip);

        // Seed payment ledger
        await database.collection('payments').insertOne({
          trip_id: t.tripId,
          trip_ref: t.tripRef,
          total_amount: t.cost,
          advance_amount: Math.round(t.cost * 0.8),
          advance_status: 'paid',
          advance_paid_at: new Date(),
          balance_amount: t.cost - Math.round(t.cost * 0.8),
          institution: t.id,
          deductions: {
            shortage_mt: 0,
            shortage_amount: 0,
            damage_amount: 0,
            delay_penalty: 0,
            total_deductions: 0
          },
          final_payable: t.cost - Math.round(t.cost * 0.8),
          balance_status: 'pending',
          balance_paid_at: null,
          fuel_card_loaded: 0,
          created_at: new Date(),
          updated_at: new Date()
        });

        logger.info(`Seeded active demo trip & payment for ${t.id}`);
      }
    }
  } catch (err) {
    logger.error('Failed to seed multi-tenant database records', { error: err });
  }
}

module.exports = {
  connectDb,
  getDb,
  closeDb,
  ensureIndexes
};

