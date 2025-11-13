const mongoose = require("mongoose");

const supportingDocumentSchema = new mongoose.Schema(
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
supportingDocumentSchema.index({ pitchDeck: 1, isActive: 1 });

module.exports = mongoose.model("SupportingDocument", supportingDocumentSchema);
