const mongoose = require("mongoose");

const pitchDeckMessageSchema = new mongoose.Schema(
  {
    pitchDeck: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PitchDeck",
      required: true,
    },
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
    },

    // USER QUERY
    userQuery: {
      type: String,
      required: true,
    },
    // User attachments (if any)
    attachments: [
      {
        fileUrl: String,
        fileKey: String,
        fileName: String,
        fileType: String,
        fileSize: Number,
      },
    ],

    // AI RESPONSE
    aiResponse: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
    // Response metadata
    responseType: {
      type: String,
      enum: ["conversational", "full_analysis", "initial", "minor_edit"],
      required: true,
    },
    requiresAnalysisUpdate: {
      type: Boolean,
      default: false,
    },

    // Version tracking
    analysisVersion: {
      type: Number,
      default: 1,
    },

    // Processing metadata
    metadata: {
      tokensUsed: Number,
      processingTime: Number,
      model: String,
    },

    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

// Index for efficient queries
pitchDeckMessageSchema.index({ pitchDeck: 1, createdAt: 1 });
pitchDeckMessageSchema.index({ pitchDeck: 1, isActive: 1 });

module.exports = mongoose.model("PitchDeckMessage", pitchDeckMessageSchema);
