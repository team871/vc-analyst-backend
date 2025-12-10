const mongoose = require("mongoose");

const dataRoomDocumentSchema = new mongoose.Schema(
  {
    pitchDeck: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PitchDeck",
      required: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
      default: "",
    },
    // AI-generated mini summary/caption
    aiSummary: {
      type: String,
      trim: true,
      default: "",
    },
    // Document category/type (e.g., "Balance Sheet", "Shareholder Agreement", "Tech Infrastructure")
    category: {
      type: String,
      trim: true,
      default: "",
    },
    fileUrl: {
      type: String,
      default: "",
    },
    fileKey: {
      type: String,
      default: "",
    },
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
    },
    metadata: {
      fileSize: Number,
      fileType: String,
      uploadDate: Date,
      summaryGeneratedAt: Date,
      aiModel: {
        type: String,
        default: "gpt-4o-mini",
      },
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
dataRoomDocumentSchema.index({ pitchDeck: 1, isActive: 1 });
dataRoomDocumentSchema.index({ organization: 1, isActive: 1 });

module.exports = mongoose.model("DataRoomDocument", dataRoomDocumentSchema);
