const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

/**
 * Retrieves the RSA public and private keys.
 * Generates them dynamically if they are missing.
 */
function getKeys() {
  const privateKeyPath = path.join(__dirname, '../keys/private.pem');
  const publicKeyPath = path.join(__dirname, '../keys/public.pem');

  // Check if they already exist
  if (fs.existsSync(privateKeyPath) && fs.existsSync(publicKeyPath)) {
    return {
      privateKey: fs.readFileSync(privateKeyPath, 'utf8'),
      publicKey: fs.readFileSync(publicKeyPath, 'utf8')
    };
  }

  logger.info('RSA key pair not found. Generating new 2048-bit RSA keys for JWT token signing...');

  // Create keys directory if it doesn't exist
  const keysDir = path.dirname(privateKeyPath);
  if (!fs.existsSync(keysDir)) {
    fs.mkdirSync(keysDir, { recursive: true });
  }

  // Generate 2048-bit RSA key pair
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem'
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem'
    }
  });

  // Write them to disk
  fs.writeFileSync(privateKeyPath, privateKey);
  fs.writeFileSync(publicKeyPath, publicKey);

  logger.info('RSA keys generated and saved successfully.');

  return { privateKey, publicKey };
}

module.exports = { getKeys };
