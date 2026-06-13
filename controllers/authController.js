const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getDb } = require('../db');
const { AppError } = require('../middleware/errorHandler');
const { ERROR_CODES, ROLES } = require('../utils/constants');
const logger = require('../utils/logger');
const cache = require('../cache');

/**
 * Controller to handle Authentication (OTP Login & JWT Generation)
 */
class AuthController {
  
  /**
   * Dispatch OTP SMS
   * Route: POST /api/auth/otp/send
   */
  async sendOtp(req, res, next) {
    try {
      const { phone_number } = req.body;

      if (!phone_number || !/^\d{10}$/.test(phone_number)) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Valid 10-digit mobile number required.', 400);
      }

      // Generate a simple 6-digit OTP (123456 for easy verification/mocking)
      const otp = '123456'; 
      const otpHash = await bcrypt.hash(otp, 10);

      const db = getDb();
      
      // Store session in MongoDB with a TTL (auto-expires in 5 mins)
      // Upsert: replace previous OTP request for this phone
      await db.collection('otp_sessions').updateOne(
        { phone_number },
        { 
          $set: { 
            otp_hash: otpHash, 
            attempts: 0, 
            created_at: new Date() 
          } 
        },
        { upsert: true }
      );

      logger.info(`OTP generated for ${phone_number}: ${otp}`);

      return res.success({
        message: 'OTP dispatched successfully (Dev code: 123456).',
        // In local mock mode, we return the OTP directly for automated testing/testing UI
        otp: process.env.NODE_ENV === 'production' ? undefined : otp
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Verify OTP & Issue JWT
   * Route: POST /api/auth/otp/verify
   */
  async verifyOtp(req, res, next) {
    try {
      const { phone_number, otp, role, name, institution = 'IGSL' } = req.body;
 
      if (!phone_number || !otp) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Phone number and OTP are required.', 400);
      }
 
      const db = getDb();
      
      // 1. Fetch OTP session
      const session = await db.collection('otp_sessions').findOne({ phone_number });
      if (!session) {
        throw new AppError(ERROR_CODES.AUTH_OTP_EXPIRED, 'OTP expired or session not found.', 401);
      }
 
      if (session.attempts >= 3) {
        await db.collection('otp_sessions').deleteOne({ phone_number });
        throw new AppError(ERROR_CODES.AUTH_OTP_EXPIRED, 'Maximum OTP attempts exceeded. Please request a new OTP.', 401);
      }
 
      // 2. Validate OTP
      const isValid = await bcrypt.compare(otp, session.otp_hash);
      if (!isValid) {
        // Increment attempts
        await db.collection('otp_sessions').updateOne(
          { phone_number },
          { $inc: { attempts: 1 } }
        );
        throw new AppError(ERROR_CODES.AUTH_OTP_EXPIRED, 'Invalid OTP code.', 401);
      }
 
      // Cleanup session on success
      await db.collection('otp_sessions').deleteOne({ phone_number });
 
      // 3. Find or Create User
      let user = await db.collection('users').findOne({ phone_number, institution });
      let isNewUser = false;
 
      if (!user) {
        isNewUser = true;
        
        // Define default role logic:
        // Admin: phone number contains '0000'
        // Otherwise: role provided in body, defaulting to BROKER
        let userRole = ROLES.BROKER;
        if (phone_number.includes('0000')) {
          userRole = ROLES.ADMIN;
        } else if (role && Object.values(ROLES).includes(role)) {
          userRole = role;
        }
 
        user = {
          phone_number,
          role: userRole,
          name: name || `User-${phone_number.slice(-4)}`,
          institution,
          is_active: true,
          created_at: new Date(),
          updated_at: new Date()
        };
 
        const result = await db.collection('users').insertOne(user);
        user._id = result.insertedId;
        
        logger.info(`New user registered: ${user.phone_number} with role ${user.role} under ${user.institution}`);
      }
 
      // 4. Issue JWT
      const secret = process.env.JWT_SECRET || 'fallback_secret_for_dev_only';
      const token = jwt.sign(
        { 
          id: user._id.toString(), 
          phone_number: user.phone_number, 
          role: user.role,
          name: user.name,
          institution: user.institution
        },
        secret,
        { expiresIn: '24h' }
      );
 
      // Store user details in cache for auth speedups
      cache.set(`user:${user._id.toString()}`, user, 300);
 
      return res.success({
        token,
        is_new_user: isNewUser,
        user: {
          id: user._id,
          phone_number: user.phone_number,
          role: user.role,
          name: user.name,
          institution: user.institution
        }
      });
    } catch (error) {
      next(error);
    }
  }
 
  /**
   * Password login for demo credentials (admin/admin, client/client)
   * Route: POST /api/auth/login
   */
  async login(req, res, next) {
    try {
      const { username, password, institution = 'IGSL' } = req.body;
 
      if (!username || !password) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Username and password are required.', 400);
      }
 
      const db = getDb();
      let role = null;
      let name = null;
      let phoneNumber = null;
 
      // Scope demo logins based on selected institution
      if (institution === 'INSTITUTION_A') {
        if (username === 'admin' && password === 'admin') {
          role = ROLES.ADMIN;
          name = 'INSTITUTION_A Admin';
          phoneNumber = '9900000001';
        } else if (username === 'client' && password === 'client') {
          role = ROLES.CLIENT;
          name = 'INSTITUTION_A Manager';
          phoneNumber = '9876543211';
        }
      } else if (institution === 'INSTITUTION_B') {
        if (username === 'admin' && password === 'admin') {
          role = ROLES.ADMIN;
          name = 'INSTITUTION_B Admin';
          phoneNumber = '9900000002';
        } else if (username === 'client' && password === 'client') {
          role = ROLES.CLIENT;
          name = 'INSTITUTION_B Manager';
          phoneNumber = '9876543212';
        }
      } else {
        // Fallback to IGSL
        if (username === 'admin' && password === 'admin') {
          role = ROLES.ADMIN;
          name = 'IGSL Admin';
          phoneNumber = '9900000000';
        } else if (username === 'client' && password === 'client') {
          role = ROLES.CLIENT;
          name = 'IGSL Manager';
          phoneNumber = '9876543210';
        }
      }
 
      if (!phoneNumber) {
        throw new AppError(ERROR_CODES.AUTH_UNAUTHORIZED || 'AUTH_UNAUTHORIZED', 'Invalid username, password, or institution.', 401);
      }
 
      // Find or upsert user
      let user = await db.collection('users').findOne({ phone_number: phoneNumber, institution });
      if (!user) {
        user = {
          phone_number: phoneNumber,
          role: role,
          name: name,
          institution,
          is_active: true,
          created_at: new Date(),
          updated_at: new Date()
        };
        const result = await db.collection('users').insertOne(user);
        user._id = result.insertedId;
      }
 
      // Issue JWT
      const secret = process.env.JWT_SECRET || 'fallback_secret_for_dev_only';
      const token = jwt.sign(
        { 
          id: user._id.toString(), 
          phone_number: user.phone_number, 
          role: user.role,
          name: user.name,
          institution: user.institution
        },
        secret,
        { expiresIn: '24h' }
      );
 
      return res.success({
        token,
        user: {
          id: user._id,
          phone_number: user.phone_number,
          role: user.role,
          name: user.name,
          institution: user.institution
        }
      });
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new AuthController();
