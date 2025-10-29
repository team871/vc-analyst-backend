const mongoose = require("mongoose");

const thesisSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    content: {
      type: String,
      required: true,
    },
    originalPdfUrl: {
      type: String,
    },
    originalPdfKey: {
      type: String,
    },
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    lastModifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    version: {
      type: Number,
      default: 1,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    metadata: {
      fileSize: Number,
      uploadDate: Date,
      analysisDate: Date,
      aiModel: {
        type: String,
        default: "sonar-pro",
      },
    },
  },
  {
    timestamps: true,
  }
);

// Index for efficient queries
thesisSchema.index({ organization: 1, isActive: 1 });
thesisSchema.index({ createdBy: 1 });

module.exports = mongoose.model("Thesis", thesisSchema);
