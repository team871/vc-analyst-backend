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
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("Organization", organizationSchema);
