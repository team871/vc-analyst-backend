const mongoose = require("mongoose");

const pitchDeckSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },
    originalFileUrl: {
      type: String,
      default: "",
    },
    originalFileKey: {
      type: String,
      default: "",
    },
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
    },
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    analysis: {
      summary: String,
      keyPoints: [String],
      marketSize: String,
      businessModel: String,
      competitiveAdvantage: String,
      team: String,
      // Can be an object (parsed) or string (fallback)
      financials: mongoose.Schema.Types.Mixed,
      risks: [String],
      opportunities: [String],
      recommendation: String,
      confidenceScore: Number,
      // Fit assessment from thesis comparison
      fitAssessment: mongoose.Schema.Types.Mixed,
      analysisDate: Date,
      aiModel: {
        type: String,
        default: "sonar-pro",
      },
    },
    // Raw AI output (optional)
    analysisRaw: { type: String },
    status: {
      type: String,
      enum: ["UPLOADED", "ANALYZING", "COMPLETED", "FAILED"],
      default: "UPLOADED",
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    metadata: {
      fileSize: Number,
      fileType: String,
      uploadDate: Date,
      analysisDuration: Number,
    },
  },
  {
    timestamps: true,
  }
);

// Index for efficient queries
pitchDeckSchema.index({ organization: 1, uploadedBy: 1, isActive: 1 });
pitchDeckSchema.index({ uploadedBy: 1, status: 1 });

module.exports = mongoose.model("PitchDeck", pitchDeckSchema);
