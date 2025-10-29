const mongoose = require("mongoose");

const commentSchema = new mongoose.Schema(
  {
    content: {
      type: String,
      required: true,
      trim: true,
    },
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
    isActive: {
      type: Boolean,
      default: true,
    },
    metadata: {
      isEdited: {
        type: Boolean,
        default: false,
      },
      editHistory: [
        {
          content: String,
          editedAt: Date,
        },
      ],
    },
  },
  {
    timestamps: true,
  }
);

// Index for efficient queries
commentSchema.index({ pitchDeck: 1, isActive: 1 });
commentSchema.index({ author: 1 });

module.exports = mongoose.model("Comment", commentSchema);
