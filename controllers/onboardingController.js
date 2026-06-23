const { getDb } = require('../db');
const { AppError } = require('../middleware/errorHandler');
const { ERROR_CODES, KYC_STATUS } = require('../utils/constants');
const kycService = require('../services/kycService');
const logger = require('../utils/logger');
const cache = require('../cache');

/**
 * Controller to handle Onboarding of Corporate Clients (Companies) and Drivers/Brokers
 */
class OnboardingController {
  
  /**
   * Onboard Corporate Client (Company)
   * Route: POST /api/onboarding/company
   * Access: Admin & Broker (Manager)
   */
  async onboardCompany(req, res, next) {
    try {
      const { name, gstin, pan_number, billing_address, locations, rate_config } = req.body;

      // Validate base inputs
      if (!name || !gstin || !pan_number || !rate_config) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Name, GSTIN, PAN, and Rate Config are required.', 400);
      }

      // Check Rate Config structure
      const validTypes = ['fixed', 'per_mt', 'per_km', 'per_mt_per_km'];
      if (!validTypes.includes(rate_config.type) || isNaN(Number(rate_config.base_rate))) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Invalid rate configuration.', 400);
      }

      const db = getDb();
      const institution = req.user.institution || 'IGSL';

      // Check if GSTIN already exists for this institution
      const existingCompany = await db.collection('companies').findOne({ gstin: gstin.toUpperCase(), institution });
      if (existingCompany) {
        throw new AppError(ERROR_CODES.DUPLICATE_ENTRY, 'A company with this GSTIN is already onboarded for this institution.', 409);
      }

      const company = {
        name,
        gstin: gstin.toUpperCase(),
        pan_number: pan_number.toUpperCase(),
        billing_address: billing_address || {},
        locations: locations || [],
        rate_config: {
          type: rate_config.type,
          base_rate: Number(rate_config.base_rate)
        },
        permissions: {
          can_view_telemetry: req.body.permissions ? req.body.permissions.can_view_telemetry !== false : true,
          can_create_trips: req.body.permissions ? req.body.permissions.can_create_trips !== false : true,
          can_approve_pod: req.body.permissions ? !!req.body.permissions.can_approve_pod : false,
          credit_limit: req.body.permissions && req.body.permissions.credit_limit !== undefined ? Number(req.body.permissions.credit_limit) : 1000000
        },
        institution,
        created_by: req.user._id,
        created_at: new Date(),
        updated_at: new Date()
      };

      const result = await db.collection('companies').insertOne(company);
      company._id = result.insertedId;

      logger.info(`Company onboarded: ${company.name} (${company.gstin}) under ${institution}`);

      return res.success({
        message: 'Company profile created successfully.',
        company
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Onboard Broker/Driver profile with automated DL & RC verification
   * Route: POST /api/onboarding/broker
   * Access: Broker/Driver role or Manager
   */
  async onboardBroker(req, res, next) {
    try {
      const { name, pan_number, dl_number, rc_details, payment_details } = req.body;

      if (!name || !pan_number || !dl_number || !rc_details || !payment_details) {
        throw new AppError(
          ERROR_CODES.VALIDATION_ERROR,
          'Name, PAN, DL, RC details, and Bank Payment details are required.',
          400
        );
      }

      const { vehicle_number, vehicle_type } = rc_details;
      if (!vehicle_number || !vehicle_type) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Vehicle number and type are required in RC details.', 400);
      }

      const db = getDb();
      const institution = req.user.institution || 'IGSL';

      // Check for duplicate PAN within this institution
      const existingPan = await db.collection('brokers').findOne({ 
        pan_number: pan_number.toUpperCase(),
        institution,
        user_id: { $ne: req.user._id }
      });
      if (existingPan) {
        throw new AppError(ERROR_CODES.DUPLICATE_ENTRY, 'A broker profile with this PAN already exists for this institution.', 409);
      }

      // 1. Run KYC Verification via external/mock APIs
      logger.info(`Starting KYC checks for user: ${req.user.phone_number} under ${institution}`);
      
      const dlVerification = await kycService.verifyDL(dl_number);
      const rcVerification = await kycService.verifyRC(vehicle_number);

      logger.info(`KYC checks passed for user: ${req.user.phone_number}`);

      const brokerProfile = {
        user_id: req.user._id,
        name,
        pan_number: pan_number.toUpperCase(),
        dl_number: dl_number.toUpperCase(),
        rc_details: {
          vehicle_number: vehicle_number.toUpperCase(),
          vehicle_type,
          rc_expiry: new Date(rcVerification.rc_expiry || Date.now() + 31536000000) // default 1 yr if fallback
        },
        kyc_status: KYC_STATUS.VERIFIED,
        kyc_verified_at: new Date(),
        payment_details: {
          bank_account: payment_details.bank_account || '',
          ifsc: (payment_details.ifsc || '').toUpperCase(),
          upi_id: payment_details.upi_id || ''
        },
        institution,
        updated_at: new Date()
      };

      // Upsert: user can only have one broker profile
      await db.collection('brokers').updateOne(
        { user_id: req.user._id, institution },
        { 
          $set: brokerProfile,
          $setOnInsert: { created_at: new Date() }
        },
        { upsert: true }
      );

      // Get updated document to cache/return
      const finalProfile = await db.collection('brokers').findOne({ user_id: req.user._id, institution });
      
      // Invalidate cache
      await cache.delete(`broker:${req.user._id.toString()}:${institution}`);
      await cache.set(`broker:${req.user._id.toString()}:${institution}`, finalProfile, 600); // cache for 10 mins

      return res.success({
        message: 'Broker profile onboarded and KYC verified successfully.',
        broker: finalProfile
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * List all companies (Corporate Clients) for this institution
   * Route: GET /api/companies
   * Access: Admin & Broker (Manager)
   */
  async listCompanies(req, res, next) {
    try {
      const db = getDb();
      const institution = req.user.institution || 'IGSL';
      const companies = await db.collection('companies').find({ institution }).toArray();
      return res.success(companies);
    } catch (error) {
      next(error);
    }
  }

  /**
   * Update Company Permissions & Credit Limits
   * Route: PUT /api/companies/:id/permissions
   * Access: Admin only
   */
  async updateCompanyPermissions(req, res, next) {
    try {
      const { id } = req.params;
      const { permissions } = req.body;

      if (!permissions) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Permissions object is required.', 400);
      }

      const { ObjectId } = require('mongodb');
      const db = getDb();
      const institution = req.user.institution || 'IGSL';

      const updateData = {
        permissions: {
          can_view_telemetry: permissions.can_view_telemetry !== false,
          can_create_trips: permissions.can_create_trips !== false,
          can_approve_pod: !!permissions.can_approve_pod,
          credit_limit: Number(permissions.credit_limit !== undefined ? permissions.credit_limit : 1000000)
        },
        updated_at: new Date()
      };

      const result = await db.collection('companies').updateOne(
        { _id: new ObjectId(id), institution },
        { $set: updateData }
      );

      if (result.matchedCount === 0) {
        throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Company not found for this institution.', 404);
      }

      // Invalidate company cache
      await cache.delete(`company:${id}:${institution}`);

      logger.info(`Company ${id} permissions updated by Admin under ${institution}`);

      return res.success({
        message: 'Company permissions updated successfully.',
        permissions: updateData.permissions
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Fetch current user's Company profile & permissions
   * Route: GET /api/companies/my
   * Access: Authenticated client/broker
   */
  async getMyCompany(req, res, next) {
    try {
      const db = getDb();
      const institution = req.user.institution || 'IGSL';
      
      let company = await db.collection('companies').findOne({ created_by: req.user._id, institution });
      if (!company) {
        // Fallback to first company of the institution
        company = await db.collection('companies').findOne({ institution });
      }

      return res.success(company);
    } catch (error) {
      next(error);
    }
  }

  /**
   * List all Brokers for this institution
   * Route: GET /api/brokers
   * Access: Admin & Broker (Manager)
   */
  async listBrokers(req, res, next) {
    try {
      const db = getDb();
      const institution = req.user.institution || 'IGSL';
      const brokers = await db.collection('brokers').find({ institution }).toArray();
      return res.success(brokers);
    } catch (error) {
      next(error);
    }
  }

  /**
   * List all Departments
   * Route: GET /api/departments
   * Access: Admin only
   */
  async listDepartments(req, res, next) {
    try {
      const db = getDb();
      const institution = req.user.institution || 'IGSL';
      const cacheKey = `depts:${institution}`;
      
      let departments = await cache.get(cacheKey);
      if (!departments) {
        departments = await db.collection('departments').find({ institution }).toArray();
        await cache.set(cacheKey, departments, 3600); // Cache for 1 hour
      }
      return res.success(departments);
    } catch (error) {
      next(error);
    }
  }

  /**
   * Create a Department
   * Route: POST /api/departments
   * Access: Admin only
   */
  async createDepartment(req, res, next) {
    try {
      const { name } = req.body;
      if (!name) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Department name is required.', 400);
      }
      const db = getDb();
      const institution = req.user.institution || 'IGSL';
      const normalizedName = name.trim();

      const existingDept = await db.collection('departments').findOne({ name: normalizedName, institution });
      if (existingDept) {
        throw new AppError(ERROR_CODES.DUPLICATE_ENTRY, 'Department already exists.', 409);
      }

      const newDept = {
        name: normalizedName,
        institution,
        created_at: new Date()
      };

      const result = await db.collection('departments').insertOne(newDept);
      newDept._id = result.insertedId;

      // Invalidate department cache
      await cache.delete(`depts:${institution}`);

      return res.success({
        message: 'Department created successfully.',
        department: newDept
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * List all Staff/Manager Accounts
   * Route: GET /api/staff
   * Access: Admin only
   */
  async listStaff(req, res, next) {
    try {
      const db = getDb();
      const institution = req.user.institution || 'IGSL';
      const cacheKey = `staff:${institution}`;
      
      let staff = await cache.get(cacheKey);
      if (!staff) {
        staff = await db.collection('users').find({ role: 'client', institution }).toArray();
        await cache.set(cacheKey, staff, 3600); // Cache for 1 hour
      }
      return res.success(staff);
    } catch (error) {
      next(error);
    }
  }

  /**
   * Create a Staff/Manager Account
   * Route: POST /api/staff
   * Access: Admin only
   */
  async createStaff(req, res, next) {
    try {
      const { name, phone_number, department, permissions } = req.body;
      if (!name || !phone_number || !department || !permissions) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Name, phone_number, department, and permissions are required.', 400);
      }

      const db = getDb();
      const institution = req.user.institution || 'IGSL';

      const existingUser = await db.collection('users').findOne({ phone_number, institution });
      if (existingUser) {
        throw new AppError(ERROR_CODES.DUPLICATE_ENTRY, 'A user with this phone number already exists.', 409);
      }

      const newStaff = {
        phone_number,
        role: 'client',
        name,
        institution,
        department,
        permissions: {
          can_create_jobs: !!permissions.can_create_jobs,
          can_verify_compliance: !!permissions.can_verify_compliance,
          can_approve_payments: !!permissions.can_approve_payments,
          can_generate_lr: !!permissions.can_generate_lr,
          can_track_vehicles: !!permissions.can_track_vehicles
        },
        is_active: true,
        created_at: new Date(),
        updated_at: new Date()
      };

      const result = await db.collection('users').insertOne(newStaff);
      newStaff._id = result.insertedId;

      // Invalidate staff cache
      await cache.delete(`staff:${institution}`);

      return res.success({
        message: 'Staff account created successfully.',
        staff: newStaff
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Update a Staff/Manager Account
   * Route: PUT /api/staff/:id
   * Access: Admin only
   */
  async updateStaff(req, res, next) {
    try {
      const { id } = req.params;
      const { name, phone_number, department, permissions, is_active } = req.body;
      if (!name || !phone_number || !department || !permissions) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Name, phone_number, department, and permissions are required.', 400);
      }

      const { ObjectId } = require('mongodb');
      const db = getDb();
      const institution = req.user.institution || 'IGSL';

      // Check if phone number is used by another user in the same institution
      const duplicateUser = await db.collection('users').findOne({
        phone_number,
        institution,
        _id: { $ne: new ObjectId(id) }
      });
      if (duplicateUser) {
        throw new AppError(ERROR_CODES.DUPLICATE_ENTRY, 'Another user with this phone number already exists.', 409);
      }

      const updateData = {
        name,
        phone_number,
        department,
        permissions: {
          can_create_jobs: !!permissions.can_create_jobs,
          can_verify_compliance: !!permissions.can_verify_compliance,
          can_approve_payments: !!permissions.can_approve_payments,
          can_generate_lr: !!permissions.can_generate_lr,
          can_track_vehicles: !!permissions.can_track_vehicles
        },
        updated_at: new Date()
      };

      if (is_active !== undefined) {
        updateData.is_active = !!is_active;
      }

      const result = await db.collection('users').updateOne(
        { _id: new ObjectId(id), role: 'client', institution },
        { $set: updateData }
      );

      if (result.matchedCount === 0) {
        throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Staff user not found.', 404);
      }

      // Invalidate staff cache
      await cache.delete(`staff:${institution}`);

      return res.success({
        message: 'Staff account updated successfully.'
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Delete a Staff/Manager Account
   * Route: DELETE /api/staff/:id
   * Access: Admin only
   */
  async deleteStaff(req, res, next) {
    try {
      const { id } = req.params;
      const { ObjectId } = require('mongodb');
      const db = getDb();
      const institution = req.user.institution || 'IGSL';

      const result = await db.collection('users').deleteOne({
        _id: new ObjectId(id),
        role: 'client',
        institution
      });

      if (result.deletedCount === 0) {
        throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Staff user not found.', 404);
      }

      // Invalidate staff cache
      await cache.delete(`staff:${institution}`);

      return res.success({
        message: 'Staff account deleted successfully.'
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Update a Department (Modify permissions / name)
   * Route: PUT /api/departments/:id
   * Access: Admin only
   */
  async updateDepartment(req, res, next) {
    try {
      const { id } = req.params;
      const { name, permissions } = req.body;
      const { ObjectId } = require('mongodb');
      const db = getDb();
      const institution = req.user.institution || 'IGSL';

      const dept = await db.collection('departments').findOne({
        _id: new ObjectId(id),
        institution
      });

      if (!dept) {
        throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Department not found.', 404);
      }

      const updateData = { updated_at: new Date() };
      if (name !== undefined) {
        updateData.name = name.trim();
      }
      if (permissions !== undefined) {
        updateData.permissions = {
          can_create_jobs: !!permissions.can_create_jobs,
          can_verify_compliance: !!permissions.can_verify_compliance,
          can_approve_payments: !!permissions.can_approve_payments,
          can_generate_lr: !!permissions.can_generate_lr,
          can_track_vehicles: !!permissions.can_track_vehicles
        };
      }

      await db.collection('departments').updateOne(
        { _id: new ObjectId(id), institution },
        { $set: updateData }
      );

      // Propagate name change to users in this department
      if (name !== undefined && name.trim() !== dept.name) {
        await db.collection('users').updateMany(
          { department: dept.name, institution },
          { $set: { department: name.trim() } }
        );
      }

      // Propagate permissions change to users in this department
      if (permissions !== undefined) {
        await db.collection('users').updateMany(
          { department: name !== undefined ? name.trim() : dept.name, institution, role: 'client' },
          { $set: { permissions: updateData.permissions } }
        );
      }

      // Invalidate department and staff cache
      await cache.delete(`depts:${institution}`);
      await cache.delete(`staff:${institution}`);

      return res.success({
        message: 'Department updated successfully.',
        department: { ...dept, ...updateData }
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Delete a Department
   * Route: DELETE /api/departments/:id
   * Access: Admin only
   */
  async deleteDepartment(req, res, next) {
    try {
      const { id } = req.params;
      const { ObjectId } = require('mongodb');
      const db = getDb();
      const institution = req.user.institution || 'IGSL';

      const dept = await db.collection('departments').findOne({
        _id: new ObjectId(id),
        institution
      });

      if (!dept) {
        throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Department not found.', 404);
      }

      await db.collection('departments').deleteOne({
        _id: new ObjectId(id),
        institution
      });

      // Update any staff in this department to 'Unassigned'
      await db.collection('users').updateMany(
        { department: dept.name, institution },
        { $set: { department: 'Unassigned' } }
      );

      // Invalidate department and staff cache
      await cache.delete(`depts:${institution}`);
      await cache.delete(`staff:${institution}`);

      return res.success({
        message: 'Department deleted successfully.'
      });
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new OnboardingController();
