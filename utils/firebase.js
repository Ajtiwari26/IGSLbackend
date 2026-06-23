const admin = require('firebase-admin');

let auth;
if (process.env.NODE_ENV === 'test') {
  // Mock Firebase Auth in Jest testing environment to avoid ES module loading issues
  auth = {
    verifyIdToken: async (idToken) => {
      return { phone_number: '+919900000000' };
    }
  };
} else {
  const { getAuth } = require('firebase-admin/auth');
  const app = admin.initializeApp();
  auth = getAuth(app);
}

module.exports = {
  admin,
  auth
};
