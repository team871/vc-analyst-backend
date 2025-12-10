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
      // Sector analysis with internet-sourced information
      sectorAnalysis: mongoose.Schema.Types.Mixed,
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
    // Track analysis version for iterative improvements
    analysisVersion: {
      type: Number,
      default: 1,
    },
    // Store history of analyses
    analysisHistory: [
      {
        version: Number,
        analysis: mongoose.Schema.Types.Mixed,
        analysisRaw: String,
        analysisDate: Date,
        trigger: {
          type: String,
          enum: ["initial", "user_question", "supporting_doc", "updated_deck"],
        },
      },
    ],
    // Track sector analysis version
    sectorAnalysisVersion: {
      type: Number,
      default: 0,
    },
    // Store history of sector analyses
    sectorAnalysisHistory: [
      {
        version: Number,
        sectorAnalysis: mongoose.Schema.Types.Mixed,
        analysisRaw: String,
        analysisDate: Date,
        aiModel: String,
        createdBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
        },
      },
    ],
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
