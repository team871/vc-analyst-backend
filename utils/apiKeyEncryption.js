const crypto = require("crypto");

// Encryption algorithm
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16; // For AES, this is always 16
const SALT_LENGTH = 64;
const TAG_LENGTH = 16;
const TAG_POSITION = SALT_LENGTH + IV_LENGTH;
const ENCRYPTED_POSITION = TAG_POSITION + TAG_LENGTH;

/**
 * Get encryption key from environment variable or generate a default
 * In production, this should be set via ENCRYPTION_KEY environment variable
 */
function getEncryptionKey() {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) {
    console.warn(
      "ENCRYPTION_KEY not set. Using default key (NOT SECURE FOR PRODUCTION)."
    );
    // Default key for development (32 bytes for AES-256)
    return crypto
      .createHash("sha256")
      .update("default-encryption-key-change-in-production")
      .digest();
  }
  // Key should be 32 bytes for AES-256
  return crypto.createHash("sha256").update(key).digest();
}

/**
 * Encrypt API key
 * @param {string} text - Plain text API key to encrypt
 * @returns {string} Encrypted string (base64 encoded)
 */
function encryptApiKey(text) {
  if (!text) {
    return null;
  }

  try {
    const key = getEncryptionKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    const salt = crypto.randomBytes(SALT_LENGTH);

    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(text, "utf8", "base64");
    encrypted += cipher.final("base64");

    const tag = cipher.getAuthTag();

    // Combine salt + iv + tag + encrypted data
    const combined = Buffer.concat([
      salt,
      iv,
      tag,
      Buffer.from(encrypted, "base64"),
    ]);

    return combined.toString("base64");
  } catch (error) {
    console.error("Error encrypting API key:", error);
    throw new Error("Failed to encrypt API key");
  }
}

/**
 * Decrypt API key
 * @param {string} encryptedText - Encrypted string (base64 encoded)
 * @returns {string} Decrypted plain text API key
 */
function decryptApiKey(encryptedText) {
  if (!encryptedText) {
    return null;
  }

  try {
    const key = getEncryptionKey();
    const combined = Buffer.from(encryptedText, "base64");

    // Extract components
    const salt = combined.subarray(0, SALT_LENGTH);
    const iv = combined.subarray(SALT_LENGTH, TAG_POSITION);
    const tag = combined.subarray(TAG_POSITION, ENCRYPTED_POSITION);
    const encrypted = combined.subarray(ENCRYPTED_POSITION);

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);

    let decrypted = decipher.update(encrypted, null, "utf8");
    decrypted += decipher.final("utf8");

    return decrypted;
  } catch (error) {
    console.error("Error decrypting API key:", error);
    throw new Error("Failed to decrypt API key");
  }
}

module.exports = {
  encryptApiKey,
  decryptApiKey,
};

