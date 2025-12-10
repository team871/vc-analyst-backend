const express = require("express");
const { body, validationResult } = require("express-validator");
const Organization = require("../models/Organization");
const { authMiddleware, requireSA } = require("../middleware/auth");
const { encryptApiKey, decryptApiKey } = require("../utils/apiKeyEncryption");
const { logAction } = require("../utils/auditLogger");

const router = express.Router();

/**
 * Get API keys status (without revealing actual keys)
 * GET /api/api-settings
 */
router.get("/", authMiddleware, requireSA, async (req, res) => {
  try {
    const organization = await Organization.findById(
      req.user.organization._id
    );

    if (!organization) {
      return res.status(404).json({ message: "Organization not found" });
    }

    // Return status without revealing actual keys
    const apiKeysStatus = {
      perplexity: {
        configured: !!organization.apiKeys?.perplexity?.encrypted,
        updatedAt: organization.apiKeys?.perplexity?.updatedAt || null,
        updatedBy: organization.apiKeys?.perplexity?.updatedBy || null,
      },
      openai: {
        configured: !!organization.apiKeys?.openai?.encrypted,
        updatedAt: organization.apiKeys?.openai?.updatedAt || null,
        updatedBy: organization.apiKeys?.openai?.updatedBy || null,
      },
      elevenlabs: {
        configured: !!organization.apiKeys?.elevenlabs?.encrypted,
        updatedAt: organization.apiKeys?.elevenlabs?.updatedAt || null,
        updatedBy: organization.apiKeys?.elevenlabs?.updatedBy || null,
      },
    };

    res.json({
      organizationId: organization._id,
      organizationName: organization.name,
      apiKeys: apiKeysStatus,
    });
  } catch (error) {
    console.error("Get API settings error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

/**
 * Update API key for a specific provider
 * PUT /api/api-settings/:provider
 * Providers: 'perplexity', 'openai', 'elevenlabs'
 */
router.put(
  "/:provider",
  authMiddleware,
  requireSA,
  [
    body("apiKey")
      .trim()
      .notEmpty()
      .withMessage("API key is required")
      .isLength({ min: 10 })
      .withMessage("API key must be at least 10 characters"),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { provider } = req.params;
      const { apiKey } = req.body;

      // Validate provider
      const validProviders = ["perplexity", "openai", "elevenlabs"];
      if (!validProviders.includes(provider.toLowerCase())) {
        return res.status(400).json({
          message: `Invalid provider. Must be one of: ${validProviders.join(", ")}`,
        });
      }

      const providerKey = provider.toLowerCase();

      // Get organization
      const organization = await Organization.findById(
        req.user.organization._id
      );

      if (!organization) {
        return res.status(404).json({ message: "Organization not found" });
      }

      // Initialize apiKeys object if it doesn't exist
      if (!organization.apiKeys) {
        organization.apiKeys = {
          perplexity: {},
          openai: {},
          elevenlabs: {},
        };
      }

      if (!organization.apiKeys[providerKey]) {
        organization.apiKeys[providerKey] = {};
      }

      // Encrypt and store API key
      const encryptedKey = encryptApiKey(apiKey);

      organization.apiKeys[providerKey].encrypted = encryptedKey;
      organization.apiKeys[providerKey].updatedAt = new Date();
      organization.apiKeys[providerKey].updatedBy = req.user._id;

      await organization.save();

      // Log audit trail
      await logAction({
        actionType: "SETTINGS_UPDATED",
        performedBy: req.user._id,
        organization: req.user.organization._id,
        description: `Updated ${providerKey.toUpperCase()} API key`,
        metadata: {
          provider: providerKey,
          keyUpdated: true,
        },
        ipAddress: req.ip || req.connection.remoteAddress,
        userAgent: req.headers["user-agent"],
      });

      res.json({
        message: `${providerKey.toUpperCase()} API key updated successfully`,
        provider: providerKey,
        configured: true,
        updatedAt: organization.apiKeys[providerKey].updatedAt,
      });
    } catch (error) {
      console.error("Update API key error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

/**
 * Delete/Remove API key for a specific provider
 * DELETE /api/api-settings/:provider
 */
router.delete(
  "/:provider",
  authMiddleware,
  requireSA,
  async (req, res) => {
    try {
      const { provider } = req.params;

      // Validate provider
      const validProviders = ["perplexity", "openai", "elevenlabs"];
      if (!validProviders.includes(provider.toLowerCase())) {
        return res.status(400).json({
          message: `Invalid provider. Must be one of: ${validProviders.join(", ")}`,
        });
      }

      const providerKey = provider.toLowerCase();

      // Get organization
      const organization = await Organization.findById(
        req.user.organization._id
      );

      if (!organization) {
        return res.status(404).json({ message: "Organization not found" });
      }

      // Remove API key
      if (organization.apiKeys?.[providerKey]) {
        organization.apiKeys[providerKey].encrypted = null;
        organization.apiKeys[providerKey].updatedAt = new Date();
        organization.apiKeys[providerKey].updatedBy = req.user._id;
      }

      await organization.save();

      // Log audit trail
      await logAction({
        actionType: "SETTINGS_UPDATED",
        performedBy: req.user._id,
        organization: req.user.organization._id,
        description: `Removed ${providerKey.toUpperCase()} API key`,
        metadata: {
          provider: providerKey,
          keyRemoved: true,
        },
        ipAddress: req.ip || req.connection.remoteAddress,
        userAgent: req.headers["user-agent"],
      });

      res.json({
        message: `${providerKey.toUpperCase()} API key removed successfully`,
        provider: providerKey,
        configured: false,
      });
    } catch (error) {
      console.error("Delete API key error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

/**
 * Test API key (verify it works without storing)
 * POST /api/api-settings/:provider/test
 */
router.post(
  "/:provider/test",
  authMiddleware,
  requireSA,
  [
    body("apiKey")
      .trim()
      .notEmpty()
      .withMessage("API key is required"),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { provider } = req.params;
      const { apiKey } = req.body;

      // Validate provider
      const validProviders = ["perplexity", "openai", "elevenlabs"];
      if (!validProviders.includes(provider.toLowerCase())) {
        return res.status(400).json({
          message: `Invalid provider. Must be one of: ${validProviders.join(", ")}`,
        });
      }

      const providerKey = provider.toLowerCase();
      let isValid = false;
      let errorMessage = null;

      try {
        // Test the API key based on provider
        if (providerKey === "openai") {
          const OpenAI = require("openai");
          const client = new OpenAI({ apiKey });
          // Simple test - list models
          await client.models.list();
          isValid = true;
        } else if (providerKey === "perplexity") {
          const Perplexity = require("@perplexity-ai/perplexity_ai");
          const perplexity = new Perplexity({ apiKey });
          // Test with a simple query
          const response = await perplexity.chat.completions.create({
            model: "sonar-pro",
            messages: [{ role: "user", content: "test" }],
          });
          isValid = !!response;
        } else if (providerKey === "elevenlabs") {
          // ElevenLabs doesn't have a simple test endpoint
          // Check if key format looks valid (starts with expected pattern)
          isValid = apiKey.length > 20 && /^[a-zA-Z0-9]+$/.test(apiKey);
          if (!isValid) {
            errorMessage = "Invalid API key format";
          }
        }
      } catch (error) {
        isValid = false;
        errorMessage = error.message || "API key validation failed";
      }

      res.json({
        provider: providerKey,
        isValid,
        errorMessage,
      });
    } catch (error) {
      console.error("Test API key error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

module.exports = router;

