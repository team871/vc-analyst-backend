const mongoose = require("mongoose");

const organizationSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },
    domain: {
      type: String,
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    settings: {
      allowAnalystComments: {
        type: Boolean,
        default: true,
      },
      maxFileSize: {
        type: Number,
        default: 50 * 1024 * 1024, // 50MB
      },
      allowedFileTypes: {
        type: [String],
        default: ["pdf", "ppt", "pptx", "doc", "docx"],
      },
    },
    // Encrypted API keys (organization-specific)
    apiKeys: {
      perplexity: {
        encrypted: {
          type: String,
          default: null,
        },
        // Track when key was last updated
        updatedAt: {
          type: Date,
          default: null,
        },
        updatedBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
          default: null,
        },
      },
      openai: {
        encrypted: {
          type: String,
          default: null,
        },
        updatedAt: {
          type: Date,
          default: null,
        },
        updatedBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
          default: null,
        },
      },
      elevenlabs: {
        encrypted: {
          type: String,
          default: null,
        },
        updatedAt: {
          type: Date,
          default: null,
        },
        updatedBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
          default: null,
        },
      },
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("Organization", organizationSchema);
