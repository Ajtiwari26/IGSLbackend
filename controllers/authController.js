const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { getDb } = require('../db');
const { AppError } = require('../middleware/errorHandler');
const { ERROR_CODES, ROLES } = require('../utils/constants');
const logger = require('../utils/logger');
const cache = require('../cache');

// Centralized JWT secret — fail hard if missing
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('FATAL: JWT_SECRET environment variable is not set. Cannot start in production.');
}
const SECRET = JWT_SECRET || 'dev_only_secret_not_for_production';

// Token durations
const ACCESS_TOKEN_EXPIRY = '15m';       // 15 minutes
const REFRESH_TOKEN_EXPIRY_DAYS = 7;     // 7 days

/**
 * Generate an opaque refresh token and store it in MongoDB
 */
async function createRefreshToken(userId, institution) {
  const db = getDb();
  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  await db.collection('refresh_tokens').insertOne({
    token,
    user_id: userId,
    institution,
    expires_at: expiresAt,
    created_at: new Date()
  });

  return { token, expiresAt };
}

/**
 * Set refresh token as an HttpOnly secure cookie
 */
function setRefreshCookie(res, token, expiresAt) {
  res.cookie('refresh_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'Strict' : 'Lax',
    path: '/api/auth',
    expires: expiresAt
  });
}

/**
 * Issue a short-lived access token (JWT)
 * Payload contains ONLY non-sensitive identifiers: id, role, institution
 */
function issueAccessToken(user) {
  return jwt.sign(
    {
      id: user._id.toString(),
      role: user.role,
      institution: user.institution
    },
    SECRET,
    { expiresIn: ACCESS_TOKEN_EXPIRY }
  );
}

/**
 * Controller to handle Authentication (OTP Login, JWT, Refresh Tokens)
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

      // In mock mode: use static OTP for testing; in production: generate random 6-digit code
      const isMockMode = process.env.MOCK_MODE !== 'false';
      const otp = isMockMode ? '123456' : crypto.randomInt(100000, 999999).toString();
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

      logger.info(`OTP generated for ${phone_number}`);

      return res.success({
        message: 'OTP dispatched successfully.',
        // Only return OTP in mock mode for automated testing
        otp: isMockMode ? otp : undefined
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Verify OTP & Issue Access + Refresh Tokens
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
 
      // 4. Issue short-lived Access Token (15m)
      const accessToken = issueAccessToken(user);

      // 5. Issue long-lived Refresh Token (7 days, stored in DB + HttpOnly cookie)
      const { token: refreshToken, expiresAt } = await createRefreshToken(user._id.toString(), user.institution);
      setRefreshCookie(res, refreshToken, expiresAt);
 
      // Store user details in cache for auth speedups
      cache.set(`user:${user._id.toString()}`, user, 300);
 
      return res.success({
        token: accessToken,
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
 
      // Issue short-lived Access Token (15m)
      const accessToken = issueAccessToken(user);

      // Issue Refresh Token (7 days)
      const { token: refreshToken, expiresAt } = await createRefreshToken(user._id.toString(), user.institution);
      setRefreshCookie(res, refreshToken, expiresAt);
 
      return res.success({
        token: accessToken,
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
   * Refresh Access Token using HttpOnly cookie
   * Route: POST /api/auth/refresh
   */
  async refresh(req, res, next) {
    try {
      const refreshToken = req.cookies?.refresh_token;
      if (!refreshToken) {
        throw new AppError(ERROR_CODES.AUTH_TOKEN_INVALID, 'Refresh token is required.', 401);
      }

      const db = getDb();

      // Find the refresh token in the database
      const storedToken = await db.collection('refresh_tokens').findOne({ token: refreshToken });
      if (!storedToken) {
        throw new AppError(ERROR_CODES.AUTH_TOKEN_INVALID, 'Invalid or revoked refresh token.', 401);
      }

      // Check expiry
      if (new Date() > new Date(storedToken.expires_at)) {
        await db.collection('refresh_tokens').deleteOne({ _id: storedToken._id });
        throw new AppError(ERROR_CODES.AUTH_TOKEN_INVALID, 'Refresh token has expired. Please log in again.', 401);
      }

      // Find the user
      const { ObjectId } = require('mongodb');
      const user = await db.collection('users').findOne({ _id: new ObjectId(storedToken.user_id) });
      if (!user || !user.is_active) {
        await db.collection('refresh_tokens').deleteOne({ _id: storedToken._id });
        throw new AppError(ERROR_CODES.AUTH_FORBIDDEN, 'User account is inactive or suspended.', 403);
      }

      // Rotate refresh token (delete old, issue new) for security
      await db.collection('refresh_tokens').deleteOne({ _id: storedToken._id });
      const { token: newRefreshToken, expiresAt } = await createRefreshToken(user._id.toString(), user.institution);
      setRefreshCookie(res, newRefreshToken, expiresAt);

      // Issue new access token
      const accessToken = issueAccessToken(user);

      logger.info(`Token refreshed for user ${user.phone_number} under ${user.institution}`);

      return res.success({
        token: accessToken,
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
   * Logout — revoke refresh token and clear cookie
   * Route: POST /api/auth/logout
   */
  async logout(req, res, next) {
    try {
      const refreshToken = req.cookies?.refresh_token;

      if (refreshToken) {
        const db = getDb();
        // Delete the refresh token from the database
        await db.collection('refresh_tokens').deleteOne({ token: refreshToken });
      }

      // Clear the cookie
      res.clearCookie('refresh_token', {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: process.env.NODE_ENV === 'production' ? 'Strict' : 'Lax',
        path: '/api/auth'
      });

      return res.success({ message: 'Logged out successfully.' });
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new AuthController();
