const admin = require('firebase-admin');
const { getAuth } = require('firebase-admin/auth');

// Initialize Firebase Admin SDK using Application Default Credentials (ADC)
const app = admin.initializeApp();
const auth = getAuth(app);

module.exports = {
  admin,
  auth
};
