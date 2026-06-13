const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Middlewares
const authMiddleware = require('../middleware/auth');
const roleGuard = require('../middleware/roleGuard');
const validate = require('../middleware/validate');
const permissionGuard = require('../middleware/permissionGuard');

// Controllers
const authController = require('../controllers/authController');
const onboardingController = require('../controllers/onboardingController');
const tripController = require('../controllers/tripController');
const paymentController = require('../controllers/paymentController');
const adminController = require('../controllers/adminController');

// Ensure upload directory exists
const uploadDir = path.join(__dirname, '../uploads/pod');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Multer Storage Configuration for POD uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const uniqueName = `${req.params.id || 'pod'}-${Date.now()}${ext}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // Max 10MB
  fileFilter: (req, file, cb) => {
    const filetypes = /jpeg|jpg|png/;
    const mimetype = filetypes.test(file.mimetype);
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());

    if (mimetype && extname) {
      return cb(null, true);
    }
    cb(new Error('Error: Only images of type JPEG, JPG or PNG are allowed!'));
  }
});

// Validation Schemas
const sendOtpSchema = {
  phone_number: { required: true, type: 'string', regex: /^\d{10}$/ }
};

const verifyOtpSchema = {
  phone_number: { required: true, type: 'string', regex: /^\d{10}$/ },
  otp: { required: true, type: 'string', regex: /^\d{6}$/ }
};

const companyOnboardSchema = {
  name: { required: true, type: 'string' },
  gstin: { required: true, type: 'string', regex: /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/ },
  pan_number: { required: true, type: 'string', regex: /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/ },
  rate_config: { required: true, type: 'object' }
};

const brokerOnboardSchema = {
  name: { required: true, type: 'string' },
  pan_number: { required: true, type: 'string', regex: /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/ },
  dl_number: { required: true, type: 'string' },
  rc_details: { required: true, type: 'object' },
  payment_details: { required: true, type: 'object' }
};

const createTripSchema = {
  company_id: { required: true, type: 'string' },
  material: { required: true, type: 'string' },
  weight_mt: { required: true, type: 'number' },
  source: { required: true, type: 'object' },
  destination: { required: true, type: 'object' },
  distance_km: { required: true, type: 'number' }
};

const departmentSchema = {
  name: { required: true, type: 'string' }
};

const staffSchema = {
  name: { required: true, type: 'string' },
  phone_number: { required: true, type: 'string', regex: /^\d{10}$/ },
  department: { required: true, type: 'string' },
  permissions: { required: true, type: 'object' }
};

// ==========================================
// PUBLIC ROUTES
// ==========================================
router.post('/auth/otp/send', validate(sendOtpSchema), authController.sendOtp);
router.post('/auth/otp/verify', validate(verifyOtpSchema), authController.verifyOtp);
router.post('/auth/login', authController.login);

// ==========================================
// SECURE ROUTES (JWT required)
// ==========================================
router.use(authMiddleware);

// Onboarding & Power Control
router.post('/onboarding/company', roleGuard(['admin', 'client']), validate(companyOnboardSchema), onboardingController.onboardCompany);
router.post('/onboarding/broker', roleGuard('broker'), validate(brokerOnboardSchema), onboardingController.onboardBroker);
router.get('/companies', roleGuard(['admin', 'client']), onboardingController.listCompanies);
router.get('/brokers', roleGuard(['admin', 'client']), onboardingController.listBrokers);
router.put('/companies/:id/permissions', roleGuard('admin'), onboardingController.updateCompanyPermissions);
router.get('/companies/my', onboardingController.getMyCompany);

// Department & Staff Management (Admin only)
router.get('/departments', roleGuard('admin'), onboardingController.listDepartments);
router.post('/departments', roleGuard('admin'), validate(departmentSchema), onboardingController.createDepartment);
router.get('/staff', roleGuard('admin'), onboardingController.listStaff);
router.post('/staff', roleGuard('admin'), validate(staffSchema), onboardingController.createStaff);
router.put('/staff/:id', roleGuard('admin'), validate(staffSchema), onboardingController.updateStaff);
router.delete('/staff/:id', roleGuard('admin'), onboardingController.deleteStaff);

// Trips (Job ID Cases)
router.post('/trips', roleGuard(['admin', 'client']), permissionGuard('can_create_jobs'), validate(createTripSchema), tripController.createTrip);
router.get('/trips', tripController.listTrips);
router.get('/trips/:id', tripController.getTripDetails);
router.post('/trips/:id/assign', roleGuard(['admin', 'client']), permissionGuard('can_create_jobs'), tripController.assignBroker);
router.post('/trips/:id/compliance', roleGuard(['admin', 'client']), permissionGuard('can_verify_compliance'), tripController.runComplianceCheck);
router.post('/trips/:id/dispatch', roleGuard(['admin', 'client', 'broker']), permissionGuard('can_generate_lr'), tripController.dispatchTrip);
router.post('/trips/:id/track', roleGuard(['admin', 'client', 'broker']), permissionGuard('can_track_vehicles'), tripController.trackTrip);
router.post('/trips/:id/pod', roleGuard('broker'), upload.single('pod'), tripController.uploadPOD);
router.post('/trips/:id/pod/approve', roleGuard('admin'), tripController.approvePOD);

// Payments & Ledger
router.get('/payments/:trip_id', roleGuard(['admin', 'client']), paymentController.getPaymentDetails);
router.post('/payments/:trip_id/advance/initiate', roleGuard('admin'), paymentController.initiateAdvancePayment);
router.post('/payments/:trip_id/advance/verify', roleGuard('admin'), paymentController.verifyAdvancePayment);
router.post('/payments/:trip_id/advance/approve', roleGuard('admin'), paymentController.approveAdvancePayment);
router.post('/payments/:trip_id/settle/request', roleGuard(['admin', 'client']), permissionGuard('can_approve_payments'), paymentController.requestSettlement);
router.post('/payments/:trip_id/settle', roleGuard('admin'), paymentController.settleBalancePayment);

// Admin Dashboards & Reports
router.get('/admin/dashboard/metrics', roleGuard('admin'), adminController.getDashboardMetrics);
router.get('/admin/dashboard/settlements', roleGuard('admin'), adminController.getSettlementDashboard);
router.get('/admin/pods/pending', roleGuard('admin'), adminController.getPendingPODs);
router.get('/admin/payments/pending', roleGuard('admin'), adminController.getPendingPayments);

module.exports = router;
