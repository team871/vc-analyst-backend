const Organization = require("../models/Organization");
const { decryptApiKey } = require("./apiKeyEncryption");

/**
 * Get API key for an organization with fallback to environment variable
 * @param {string} organizationId - Organization ID
 * @param {string} provider - API provider ('perplexity', 'openai', 'elevenlabs')
 * @returns {Promise<string|null>} API key or null if not found
 */
async function getOrganizationApiKey(organizationId, provider) {
  try {
    if (!organizationId) {
      // Fallback to environment variable if no organization ID
      return getEnvApiKey(provider);
    }

    const organization = await Organization.findById(organizationId).lean();
    if (!organization) {
      console.warn(
        `Organization ${organizationId} not found, falling back to env var`
      );
      return getEnvApiKey(provider);
    }

    // Check if organization has API key configured
    const apiKeyField = organization.apiKeys?.[provider]?.encrypted;
    if (apiKeyField) {
      try {
        const decrypted = decryptApiKey(apiKeyField);
        return decrypted;
      } catch (error) {
        console.error(
          `Error decrypting ${provider} API key for organization ${organizationId}:`,
          error
        );
        // Fallback to environment variable on decryption error
        return getEnvApiKey(provider);
      }
    }

    // Fallback to environment variable if organization doesn't have key configured
    return getEnvApiKey(provider);
  } catch (error) {
    console.error(
      `Error getting ${provider} API key for organization ${organizationId}:`,
      error
    );
    // Fallback to environment variable on any error
    return getEnvApiKey(provider);
  }
}

/**
 * Get API key from environment variable
 * @param {string} provider - API provider ('perplexity', 'openai', 'elevenlabs')
 * @returns {string|null} API key or null if not found
 */
function getEnvApiKey(provider) {
  const envMap = {
    perplexity: process.env.PERPLEXITY_API_KEY,
    openai: process.env.OPENAI_API_KEY,
    elevenlabs: process.env.ELEVENLABS_API_KEY,
  };

  return envMap[provider] || null;
}

/**
 * Check if organization has API key configured
 * @param {string} organizationId - Organization ID
 * @param {string} provider - API provider
 * @returns {Promise<boolean>} True if configured, false otherwise
 */
async function hasOrganizationApiKey(organizationId, provider) {
  try {
    if (!organizationId) {
      return false;
    }

    const organization = await Organization.findById(organizationId).lean();
    if (!organization) {
      return false;
    }

    return !!organization.apiKeys?.[provider]?.encrypted;
  } catch (error) {
    console.error(
      `Error checking ${provider} API key for organization ${organizationId}:`,
      error
    );
    return false;
  }
}

module.exports = {
  getOrganizationApiKey,
  getEnvApiKey,
  hasOrganizationApiKey,
};

