const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

// Generate JWT token
const generateToken = (userId, role) => {
  return jwt.sign({ userId, role }, process.env.JWT_SECRET, {
    expiresIn: "7d",
  });
};

// Verify JWT token
const verifyToken = (token) => {
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    throw new Error("Invalid token");
  }
};

// Format error response
const formatError = (message, statusCode = 500) => {
  return {
    message,
    statusCode,
    timestamp: new Date().toISOString(),
  };
};

// Format success response
const formatSuccess = (message, data = null) => {
  return {
    message,
    data,
    timestamp: new Date().toISOString(),
  };
};

// Validate file type
const validateFileType = (mimetype) => {
  const allowedTypes = [
    "application/pdf",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ];
  return allowedTypes.includes(mimetype);
};

// Format file size
const formatFileSize = (bytes) => {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
};

// Generate random string
const generateRandomString = (length = 8) => {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};

// Strip ```json ... ``` or ``` ... ``` fences
// Handles cases where there's text before/after the code fence block
const stripCodeFences = (text) => {
  if (!text || typeof text !== "string") return text;
  
  // First try exact match (entire string wrapped in fences)
  const exactMatch = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i;
  let m = text.match(exactMatch);
  if (m) return m[1];
  
  // If that fails, try to find code fence block anywhere in the text
  // This handles cases where AI adds markdown after the JSON block
  const partialMatch = /```(?:json)?\s*([\s\S]*?)\s*```/i;
  m = text.match(partialMatch);
  if (m) return m[1];
  
  // No code fences found, return original
  return text;
};

// Safe JSON parse after cleaning
const tryParseJson = (text) => {
  if (!text) return null;
  let cleaned = stripCodeFences(String(text)).trim();
  
  // Try parsing directly
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // If that fails, try to extract JSON object from the text
    // This handles cases where there's extra text mixed in
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch (e2) {
        // Still failed, return null
        return null;
      }
    }
    return null;
  }
};

// Normalize thesis profile object into expected shape
const toThesisProfile = (obj) => {
  if (!obj || typeof obj !== "object") return null;
  const pick = (v, def = null) => (v === undefined ? def : v);
  const known = new Set([
    "firmSummary",
    "investmentObjectives",
    "targetSectors",
    "stages",
    "geographies",
    "checkSize",
    "ownershipTargets",
    "timeHorizon",
    "returnTargets",
    "riskTolerance",
    "constraints",
    "exclusions",
    "esgPolicy",
    "diligenceFramework",
    "sourcingStrategy",
    "portfolioConstruction",
    "governancePreferences",
    "valueCreationPlan",
    "decisionProcess",
    "exampleDeals",
    "openQuestions",
    "confidenceScore",
  ]);

  const profile = {
    firmSummary: pick(obj.firmSummary, null),
    investmentObjectives: pick(obj.investmentObjectives, null),
    targetSectors: Array.isArray(obj.targetSectors) ? obj.targetSectors : [],
    stages: Array.isArray(obj.stages) ? obj.stages : [],
    geographies: Array.isArray(obj.geographies) ? obj.geographies : [],
    checkSize: {
      min: obj?.checkSize?.min ?? null,
      max: obj?.checkSize?.max ?? null,
      currency: obj?.checkSize?.currency ?? null,
    },
    ownershipTargets: pick(obj.ownershipTargets, null),
    timeHorizon: pick(obj.timeHorizon, null),
    returnTargets: pick(obj.returnTargets, null),
    riskTolerance: pick(obj.riskTolerance, null),
    constraints: Array.isArray(obj.constraints) ? obj.constraints : [],
    exclusions: Array.isArray(obj.exclusions) ? obj.exclusions : [],
    esgPolicy: pick(obj.esgPolicy, null),
    diligenceFramework: {
      criteria: Array.isArray(obj?.diligenceFramework?.criteria)
        ? obj.diligenceFramework.criteria
        : [],
      redFlags: Array.isArray(obj?.diligenceFramework?.redFlags)
        ? obj.diligenceFramework.redFlags
        : [],
    },
    sourcingStrategy: Array.isArray(obj.sourcingStrategy)
      ? obj.sourcingStrategy
      : [],
    portfolioConstruction: pick(obj.portfolioConstruction, null),
    governancePreferences: pick(obj.governancePreferences, null),
    valueCreationPlan: pick(obj.valueCreationPlan, null),
    decisionProcess: pick(obj.decisionProcess, null),
    exampleDeals: Array.isArray(obj.exampleDeals) ? obj.exampleDeals : [],
    openQuestions: Array.isArray(obj.openQuestions) ? obj.openQuestions : [],
    confidenceScore:
      typeof obj.confidenceScore === "number" ? obj.confidenceScore : null,
  };

  // capture extras
  const extras = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!known.has(k)) extras[k] = v;
  }
  if (Object.keys(extras).length > 0) profile.extras = extras;

  return profile;
};

module.exports = {
  generateToken,
  verifyToken,
  formatError,
  formatSuccess,
  validateFileType,
  formatFileSize,
  generateRandomString,
  stripCodeFences,
  tryParseJson,
  toThesisProfile,
};
