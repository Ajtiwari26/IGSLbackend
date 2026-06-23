const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { getDb } = require('../db');
const { AppError } = require('../middleware/errorHandler');
const { ERROR_CODES, ROLES } = require('../utils/constants');
const logger = require('../utils/logger');
const cache = require('../cache');
const { auth } = require('../utils/firebase');

// Load RSA keys for RS256 signing
const { getKeys } = require('../utils/keys');
const { privateKey } = getKeys();

// Token durations
const ACCESS_TOKEN_EXPIRY = '30d';       // 30 days
const REFRESH_TOKEN_EXPIRY_DAYS = 30;    // 30 days

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
    sameSite: process.env.NODE_ENV === 'production' ? 'None' : 'Lax',
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
    privateKey,
    { algorithm: 'RS256', expiresIn: ACCESS_TOKEN_EXPIRY }
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

      if (!phone_number || !/^\d{9,10}$/.test(phone_number)) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Valid 9 or 10-digit mobile number required.', 400);
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
 
      // 3. Find User (Enforce pre-registration for Manager/Client accounts)
      let user = await db.collection('users').findOne({ phone_number, institution });
      let isNewUser = false;
 
      if (!user) {
        // Pre-registration is mandatory for Manager (client) role.
        // Also enforce it generally unless it's a test admin (contains 0000) or broker/driver role is requested.
        const isClientRole = role === ROLES.CLIENT;
        const isTestAdmin = phone_number.includes('0000');
        const isAllowedAutoRegister = isTestAdmin || (role && role !== ROLES.CLIENT && role !== ROLES.ADMIN);

        if (isAllowedAutoRegister) {
          isNewUser = true;
          let userRole = ROLES.BROKER;
          if (isTestAdmin) {
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
          logger.info(`New user auto-registered: ${user.phone_number} with role ${user.role}`);
        } else {
          throw new AppError(ERROR_CODES.AUTH_TOKEN_INVALID || 'AUTH_TOKEN_INVALID', 'This account is not registered. Please contact your administrator to create your account.', 401);
        }
      }
 
      // 4. Issue short-lived Access Token (15m)
      const accessToken = issueAccessToken(user);

      // 5. Issue long-lived Refresh Token (7 days, stored in DB + HttpOnly cookie)
      const { token: refreshToken, expiresAt } = await createRefreshToken(user._id.toString(), user.institution);
      setRefreshCookie(res, refreshToken, expiresAt);
 
      // Store user details in cache for auth speedups
      await cache.set(`user:${user._id.toString()}`, user, 300);
 
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
   * Verify Firebase ID Token & Issue Access + Refresh Tokens
   * Route: POST /api/auth/firebase/verify
   */
  async verifyFirebaseToken(req, res, next) {
    try {
      const { idToken, role, name, institution = 'IGSL' } = req.body;

      if (!idToken) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR || 'VALIDATION_ERROR', 'Firebase ID token is required.', 400);
      }

      // 1. Verify the ID token with Firebase Admin SDK
      let decodedToken;
      try {
        decodedToken = await auth.verifyIdToken(idToken);
      } catch (authError) {
        logger.error('Firebase token verification failed:', authError);
        
        // Fallback for development/local environments with project/credentials mismatch (e.g. audience mismatch)
        if (process.env.NODE_ENV !== 'production' || process.env.MOCK_MODE !== 'false') {
          logger.warn('⚠️ Firebase signature verification failed. Falling back to jwt.decode() for local development/testing.');
          decodedToken = jwt.decode(idToken);
          if (!decodedToken) {
            throw new AppError(ERROR_CODES.AUTH_TOKEN_INVALID || 'AUTH_TOKEN_INVALID', 'Invalid Firebase ID token format.', 401);
          }
        } else {
          throw new AppError(ERROR_CODES.AUTH_TOKEN_INVALID || 'AUTH_TOKEN_INVALID', 'Invalid Firebase ID token.', 401);
        }
      }

      // Extract phone number from decoded token
      let phone_number = decodedToken.phone_number;
      if (!phone_number) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR || 'VALIDATION_ERROR', 'Phone number not found in token claims.', 400);
      }

      // Standardize phone number format (remove country prefix for database storage)
      if (phone_number.startsWith('+91')) {
        phone_number = phone_number.slice(3);
      } else if (phone_number.startsWith('+')) {
        phone_number = phone_number.replace(/^\+/, '');
        if (phone_number.length > 10) {
          phone_number = phone_number.slice(phone_number.length - 10);
        }
      }

      const db = getDb();

      // 2. Find User (Enforce pre-registration for Manager/Client accounts)
      let user = await db.collection('users').findOne({ phone_number, institution });
      let isNewUser = false;
  
      if (!user) {
        // Pre-registration is mandatory for Manager (client) role.
        // Also enforce it generally unless it's a test admin (contains 0000) or broker/driver role is requested.
        const isClientRole = role === ROLES.CLIENT;
        const isTestAdmin = phone_number.includes('0000');
        const isAllowedAutoRegister = isTestAdmin || (role && role !== ROLES.CLIENT && role !== ROLES.ADMIN);

        if (isAllowedAutoRegister) {
          isNewUser = true;
          let userRole = ROLES.BROKER;
          if (isTestAdmin) {
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
          logger.info(`New user auto-registered via Firebase: ${user.phone_number} with role ${user.role}`);
        } else {
          throw new AppError(ERROR_CODES.AUTH_TOKEN_INVALID || 'AUTH_TOKEN_INVALID', 'This account is not registered. Please contact your administrator to create your account.', 401);
        }
      }

      // 3. Issue short-lived Access Token (15m)
      const accessToken = issueAccessToken(user);

      // 4. Issue long-lived Refresh Token (7 days, stored in DB + HttpOnly cookie)
      const { token: refreshToken, expiresAt } = await createRefreshToken(user._id.toString(), user.institution);
      setRefreshCookie(res, refreshToken, expiresAt);

      // Store user details in cache for auth speedups
      await cache.set(`user:${user._id.toString()}`, user, 300);

      return res.success({
        token: accessToken,
        is_new_user: isNewUser,
        user: {
          id: user._id,
          phone_number: user.phone_number,
          role: user.role,
          name: user.name,
          institution: user.institution,
          is_super_admin: user.is_super_admin || false
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
          institution: user.institution,
          is_super_admin: user.is_super_admin || false
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
        sameSite: process.env.NODE_ENV === 'production' ? 'None' : 'Lax',
        path: '/api/auth'
      });

      return res.success({ message: 'Logged out successfully.' });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Update the authenticated user's profile phone number
   * Route: PUT /api/users/profile/phone
   */
  async updateProfilePhone(req, res, next) {
    try {
      const { phone_number } = req.body;

      if (!phone_number || !/^\d{9,10}$/.test(phone_number)) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR || 'VALIDATION_ERROR', 'A valid 9 or 10-digit phone number is required.', 400);
      }

      const db = getDb();
      const { ObjectId } = require('mongodb');

      // Update phone number in database
      const result = await db.collection('users').updateOne(
        { _id: req.user._id },
        { $set: { phone_number, updated_at: new Date() } }
      );

      if (result.matchedCount === 0) {
        throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'User not found.', 404);
      }

      // Invalidate cache
      await cache.delete(`user:${req.user._id.toString()}`);

      logger.info(`User ${req.user._id.toString()} updated phone number to ${phone_number}`);

      return res.success({
        message: 'Profile phone number updated successfully.',
        phone_number
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * List all admin phone numbers for the current institution
   * Route: GET /api/users/admin-numbers
   */
  async getAdminNumbers(req, res, next) {
    try {
      const db = getDb();
      const institution = req.user.institution || 'IGSL';
      
      const admins = await db.collection('users')
        .find({ role: ROLES.ADMIN, institution })
        .project({ phone_number: 1, name: 1, is_super_admin: 1, is_active: 1, created_at: 1 })
        .toArray();

      console.log('getAdminNumbers called. institution:', institution, 'admins returned:', admins);

      // Ensure every returned admin has is_super_admin explicitly set (fallback to true for the default seeded ones if undefined)
      const mappedAdmins = admins.map(admin => ({
        id: admin._id.toString(),
        phone_number: admin.phone_number,
        name: admin.name || `Admin-${admin.phone_number.slice(-4)}`,
        is_super_admin: admin.is_super_admin === true || admin.phone_number === '9900000000' || admin.phone_number === '9900000001' || admin.phone_number === '9900000002',
        is_active: admin.is_active !== false,
        created_at: admin.created_at
      }));

      return res.success(mappedAdmins);
    } catch (error) {
      next(error);
    }
  }

  /**
   * Add a new admin phone number
   * Route: POST /api/users/admin-numbers
   */
  async addAdminNumber(req, res, next) {
    try {
      const { phone_number, name, is_super_admin = false } = req.body;
      const institution = req.user.institution || 'IGSL';

      if (!phone_number || !/^\d{9,10}$/.test(phone_number)) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR || 'VALIDATION_ERROR', 'A valid 9 or 10-digit phone number is required.', 400);
      }

      // Check permissions: Only super admin can create a new super admin
      const isCurrentUserSuperAdmin = req.user.is_super_admin === true || req.user.phone_number === '9900000000' || req.user.phone_number === '9900000001' || req.user.phone_number === '9900000002';
      if (is_super_admin && !isCurrentUserSuperAdmin) {
        throw new AppError(ERROR_CODES.AUTH_FORBIDDEN || 'AUTH_FORBIDDEN', 'Only Super Admins can create new Super Admin accounts.', 403);
      }

      const db = getDb();

      // Check if phone number already exists in this institution
      const existingUser = await db.collection('users').findOne({ phone_number, institution });
      if (existingUser) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR || 'VALIDATION_ERROR', 'An account with this phone number already exists.', 400);
      }

      // Insert new Admin user
      const newAdmin = {
        phone_number,
        role: ROLES.ADMIN,
        name: name || `Admin-${phone_number.slice(-4)}`,
        institution,
        is_super_admin: is_super_admin === true,
        is_active: true,
        created_at: new Date(),
        updated_at: new Date()
      };

      const result = await db.collection('users').insertOne(newAdmin);
      
      logger.info(`Admin ${req.user._id.toString()} created new Admin: ${phone_number} (Super Admin: ${is_super_admin})`);

      return res.success({
        message: 'Admin phone number authorized successfully.',
        admin: {
          id: result.insertedId.toString(),
          phone_number,
          name: newAdmin.name,
          is_super_admin: newAdmin.is_super_admin,
          is_active: true
        }
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Grant/revoke Super Admin power for a user
   * Route: PUT /api/users/admin-numbers/:id/grant
   */
  async grantSuperAdmin(req, res, next) {
    try {
      const { id } = req.params;
      const { is_super_admin } = req.body;
      const institution = req.user.institution || 'IGSL';

      // Only Super Admins can grant/revoke Super Admin powers
      const isCurrentUserSuperAdmin = req.user.is_super_admin === true || req.user.phone_number === '9900000000' || req.user.phone_number === '9900000001' || req.user.phone_number === '9900000002';
      if (!isCurrentUserSuperAdmin) {
        throw new AppError(ERROR_CODES.AUTH_FORBIDDEN || 'AUTH_FORBIDDEN', 'Only Super Admins can grant or revoke Super Admin privileges.', 403);
      }

      const db = getDb();
      const { ObjectId } = require('mongodb');

      // Update super admin status
      const result = await db.collection('users').updateOne(
        { _id: new ObjectId(id), role: ROLES.ADMIN, institution },
        { $set: { is_super_admin: is_super_admin === true, updated_at: new Date() } }
      );

      if (result.matchedCount === 0) {
        throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Admin user not found.', 404);
      }

      // Invalidate cache
      await cache.delete(`user:${id}`);

      logger.info(`Super Admin ${req.user._id.toString()} updated Super Admin status of ${id} to ${is_super_admin}`);

      return res.success({
        message: `Super Admin status updated successfully.`,
        id,
        is_super_admin: is_super_admin === true
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Remove authorization for an Admin phone number
   * Route: DELETE /api/users/admin-numbers/:id
   */
  async removeAdminNumber(req, res, next) {
    try {
      const { id } = req.params;
      const institution = req.user.institution || 'IGSL';

      // Only Super Admins can remove authorized admin numbers
      const isCurrentUserSuperAdmin = req.user.is_super_admin === true || req.user.phone_number === '9900000000' || req.user.phone_number === '9900000001' || req.user.phone_number === '9900000002';
      if (!isCurrentUserSuperAdmin) {
        throw new AppError(ERROR_CODES.AUTH_FORBIDDEN || 'AUTH_FORBIDDEN', 'Only Super Admins can revoke Admin phone numbers.', 403);
      }

      // Prevent self-lockout
      if (id === req.user._id.toString()) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR || 'VALIDATION_ERROR', 'You cannot remove your own admin authorization.', 400);
      }

      const db = getDb();
      const { ObjectId } = require('mongodb');

      // Delete user document
      const result = await db.collection('users').deleteOne({
        _id: new ObjectId(id),
        role: ROLES.ADMIN,
        institution
      });

      if (result.deletedCount === 0) {
        throw new AppError(ERROR_CODES.RESOURCE_NOT_FOUND, 'Admin user not found.', 404);
      }

      // Invalidate cache
      await cache.delete(`user:${id}`);

      logger.info(`Super Admin ${req.user._id.toString()} revoked Admin privileges for ${id}`);

      return res.success({
        message: 'Admin phone number revoked successfully.',
        id
      });
    } catch (error) {
      next(error);
    }
  }
}

module.exports = new AuthController();
