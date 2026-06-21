const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const mongoSanitize = require('express-mongo-sanitize');
require('dotenv').config(); // Load environment variables


const logger = require('./utils/logger');
const { connectDb } = require('./db');
const requestIdMiddleware = require('./middleware/requestId');
const { responseFormatter, errorHandler, AppError } = require('./middleware/errorHandler');
const apiRoutes = require('./routes/api');

const app = express();
const PORT = process.env.PORT || 5001;

// 1. CORS Configuration
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000,http://localhost:19006').split(',');
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps, curl, or postman)
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1 || allowedOrigins.includes('*')) {
      return callback(null, true);
    }
    return callback(new Error('CORS Policy: Request origin not allowed.'));
  },
  credentials: true
}));

// 2. Security Headers (Helmet)
app.use(helmet({
  contentSecurityPolicy: false, // Disable CSP for API-only server
  crossOriginEmbedderPolicy: false
}));

// 3. Cookie Parser (for HttpOnly refresh token cookies)
app.use(cookieParser());

// 4. Parsers & Core Middlewares
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use(mongoSanitize());

// 3. Request Trace & Logging Pipeline
app.use(requestIdMiddleware);
app.use(responseFormatter);

// Request tracking log
app.use((req, res, next) => {
  logger.info(`Incoming request: ${req.method} ${req.originalUrl}`, {
    request_id: req.id,
    ip: req.ip,
    user_agent: req.headers['user-agent']
  });
  next();
});

// Static directory access for POD downloads
app.use('/uploads', express.static('uploads'));

// Rate limiting on auth endpoints (prevents brute-force OTP guessing)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes window
  max: 20,                     // 20 requests per window per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: { code: 'RATE_LIMIT', message: 'Too many authentication requests. Please try again later.' }
  }
});
app.use('/api/auth', authLimiter);

// Health Check Route (for monitoring tools like cron-job.org)
app.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'IQSL Logistics Core Engine is healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// 4. API Routes
app.use('/api', apiRoutes);


// serve compiled frontend assets (admin, driver, and website)
const path = require('path');
const fs = require('fs');

// 1. Admin Portal
const adminDistPath = path.join(__dirname, '../frontend/admin/dist');
if (fs.existsSync(adminDistPath)) {
  app.use('/admin', express.static(adminDistPath));
  app.get('/admin*', (req, res, next) => {
    if (req.method === 'GET') {
      res.sendFile(path.join(adminDistPath, 'index.html'));
    } else {
      next();
    }
  });
}

// 2. Driver App
const driverDistPath = path.join(__dirname, '../frontend/driver/dist');
if (fs.existsSync(driverDistPath)) {
  app.use('/driver', express.static(driverDistPath));
  app.get('/driver*', (req, res, next) => {
    if (req.method === 'GET') {
      res.sendFile(path.join(driverDistPath, 'index.html'));
    } else {
      next();
    }
  });
}

// 3. Website & Client Portal
const websiteDistPath = path.join(__dirname, '../frontend/website/dist');
if (fs.existsSync(websiteDistPath)) {
  app.use(express.static(websiteDistPath));
  app.get('*', (req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api/') && !req.path.startsWith('/admin') && !req.path.startsWith('/driver')) {
      res.sendFile(path.join(websiteDistPath, 'index.html'));
    } else {
      next();
    }
  });
}


// 5. 404 Route Catch-All
app.use((req, res, next) => {
  next(new AppError('RESOURCE_NOT_FOUND', `Route ${req.method} ${req.originalUrl} not found.`, 404));
});

// 6. Global Centralized Error Handler
app.use(errorHandler);

// 7. Server Bootstrapping
async function startServer() {
  try {
    // Try to connect to database
    await connectDb();
    
    const server = app.listen(PORT, () => {
      logger.info(`=============================================================`);
      logger.info(`🚀 IQSL Logistics Core Engine running on port ${PORT}`);
      logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
      logger.info(`MOCK_MODE: ${process.env.MOCK_MODE !== 'false'}`);
      logger.info(`=============================================================`);
    });

    // Graceful shutdown handlers
    const shutdown = async () => {
      logger.info('Shutting down server gracefully...');
      server.close(async () => {
        const { closeDb } = require('./db');
        await closeDb();
        logger.info('Process terminated.');
        process.exit(0);
      });
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

  } catch (error) {
    logger.error('Failed to initialize application', { error });
    process.exit(1);
  }
}

// Don't run server directly if we are importing it in tests (like supertest)
if (require.main === module) {
  startServer();
}

module.exports = app; // exported for testing
