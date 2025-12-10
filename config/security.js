/**
 * Security Configuration
 * Centralized security settings for the application
 */

module.exports = {
  // JWT Configuration
  jwt: {
    accessTokenExpiration: "15m", // Short-lived access tokens
    refreshTokenExpiration: "7d", // Longer-lived refresh tokens
    algorithm: "HS256",
  },

  // Password Policy
  password: {
    minLength: 12,
    requireUppercase: true,
    requireLowercase: true,
    requireNumbers: true,
    requireSpecialChars: true,
    passwordHistoryCount: 5, // Prevent reuse of last 5 passwords
    passwordExpirationDays: 90,
    maxFailedAttempts: 5,
    lockoutDurationMinutes: 30,
  },

  // Rate Limiting Configuration
  rateLimit: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    maxRequests: 100, // Per IP
    authMaxRequests: 5, // Login attempts
    uploadMaxRequests: 10, // File uploads per hour
    message: "Too many requests from this IP, please try again later.",
  },

  // CORS Configuration
  cors: {
    allowedOrigins: process.env.ALLOWED_ORIGINS?.split(",") || [],
    credentials: true,
    methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400, // 24 hours
  },

  // File Upload Configuration
  fileUpload: {
    maxFileSize: 50 * 1024 * 1024, // 50MB
    allowedMimeTypes: [
      "application/pdf",
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ],
    allowedExtensions: [".pdf", ".ppt", ".pptx"],
    scanForMalware: true, // Should be enabled in production
  },

  // Session Configuration
  session: {
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    inactivityTimeout: 30 * 60 * 1000, // 30 minutes
    maxConcurrentSessions: 3,
  },

  // Security Headers
  securityHeaders: {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        mediaSrc: ["'self'"],
        frameSrc: ["'none'"],
      },
    },
    hsts: {
      maxAge: 31536000, // 1 year
      includeSubDomains: true,
      preload: true,
    },
  },

  // Logging Configuration
  logging: {
    level: process.env.LOG_LEVEL || "info",
    logSecurityEvents: true,
    logDataAccess: true,
    logRetentionDays: 90,
  },

  // Encryption Configuration
  encryption: {
    algorithm: "aes-256-gcm",
    keyRotationDays: 90,
  },
};
