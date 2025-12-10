const express = require("express");
const AuditLog = require("../models/AuditLog");
const { authMiddleware, requireSAOrAnalyst } = require("../middleware/auth");

const router = express.Router();

/**
 * Get audit trail for a specific pitch deck (timeline format)
 * GET /api/audit-trail/pitch-deck/:id
 */
router.get(
  "/pitch-deck/:id",
  authMiddleware,
  requireSAOrAnalyst,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { page = 1, limit = 100, actionType } = req.query;

      // Verify user has access to this pitch deck
      const PitchDeck = require("../models/PitchDeck");
      const query = {
        _id: id,
        organization: req.user.organization._id,
        isActive: true,
      };

      if (req.user.role === "ANALYST") {
        query.uploadedBy = req.user._id;
      }

      const pitchDeck = await PitchDeck.findOne(query);
      if (!pitchDeck) {
        return res.status(404).json({ message: "Pitch deck not found" });
      }

      // Build query for audit logs
      const auditQuery = {
        pitchDeck: id,
        organization: req.user.organization._id,
      };

      // Filter by action type if provided
      if (actionType) {
        auditQuery.actionType = actionType;
      }

      // Get total count
      const total = await AuditLog.countDocuments(auditQuery);

      // Get audit logs with pagination
      const skip = (parseInt(page) - 1) * parseInt(limit);
      const logs = await AuditLog.find(auditQuery)
        .populate("performedBy", "firstName lastName email")
        .populate("userId", "firstName lastName email")
        .populate("commentId", "content")
        .sort({ createdAt: -1 }) // Most recent first
        .skip(skip)
        .limit(parseInt(limit));

      // Format logs for timeline display
      const timeline = logs.map((log) => ({
        id: log._id,
        actionType: log.actionType,
        description: log.description,
        performedBy: log.performedBy
          ? {
              id: log.performedBy._id,
              name: `${log.performedBy.firstName} ${log.performedBy.lastName}`,
              email: log.performedBy.email,
            }
          : null,
        timestamp: log.createdAt,
        metadata: log.metadata,
        // Related entities
        relatedUser: log.userId
          ? {
              id: log.userId._id,
              name: `${log.userId.firstName} ${log.userId.lastName}`,
            }
          : null,
        relatedComment: log.commentId
          ? {
              id: log.commentId._id,
              contentPreview: log.commentId.content?.substring(0, 100),
            }
          : null,
      }));

      res.json({
        pitchDeckId: id,
        pitchDeckTitle: pitchDeck.title,
        timeline,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          totalPages: Math.ceil(total / parseInt(limit)),
        },
      });
    } catch (error) {
      console.error("Get audit trail error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

/**
 * Get audit trail for entire organization
 * GET /api/audit-trail/organization
 */
router.get("/organization", authMiddleware, requireSAOrAnalyst, async (req, res) => {
  try {
    const { page = 1, limit = 100, actionType, pitchDeckId } = req.query;

    // Build query
    const auditQuery = {
      organization: req.user.organization._id,
    };

    // Filter by action type if provided
    if (actionType) {
      auditQuery.actionType = actionType;
    }

    // Filter by pitch deck if provided
    if (pitchDeckId) {
      auditQuery.pitchDeck = pitchDeckId;
    }

    // Get total count
    const total = await AuditLog.countDocuments(auditQuery);

    // Get audit logs with pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const logs = await AuditLog.find(auditQuery)
      .populate("performedBy", "firstName lastName email")
      .populate("pitchDeck", "title")
      .populate("userId", "firstName lastName email")
      .populate("commentId", "content")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    // Format logs for timeline display
    const timeline = logs.map((log) => ({
      id: log._id,
      actionType: log.actionType,
      description: log.description,
      performedBy: log.performedBy
        ? {
            id: log.performedBy._id,
            name: `${log.performedBy.firstName} ${log.performedBy.lastName}`,
            email: log.performedBy.email,
          }
        : null,
      timestamp: log.createdAt,
      metadata: log.metadata,
      // Related entities
      pitchDeck: log.pitchDeck
        ? {
            id: log.pitchDeck._id,
            title: log.pitchDeck.title,
          }
        : null,
      relatedUser: log.userId
        ? {
            id: log.userId._id,
            name: `${log.userId.firstName} ${log.userId.lastName}`,
          }
        : null,
      relatedComment: log.commentId
        ? {
            id: log.commentId._id,
            contentPreview: log.commentId.content?.substring(0, 100),
          }
        : null,
    }));

    res.json({
      organizationId: req.user.organization._id,
      timeline,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error("Get organization audit trail error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

/**
 * Get audit trail filtered by user
 * GET /api/audit-trail/user/:userId
 */
router.get(
  "/user/:userId",
  authMiddleware,
  requireSAOrAnalyst,
  async (req, res) => {
    try {
      const { userId } = req.params;
      const { page = 1, limit = 100, actionType } = req.query;

      // Verify user belongs to same organization
      const User = require("../models/User");
      const user = await User.findOne({
        _id: userId,
        organization: req.user.organization._id,
      });

      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      // Build query - actions performed by this user
      const auditQuery = {
        performedBy: userId,
        organization: req.user.organization._id,
      };

      if (actionType) {
        auditQuery.actionType = actionType;
      }

      // Get total count
      const total = await AuditLog.countDocuments(auditQuery);

      // Get audit logs
      const skip = (parseInt(page) - 1) * parseInt(limit);
      const logs = await AuditLog.find(auditQuery)
        .populate("pitchDeck", "title")
        .populate("userId", "firstName lastName email")
        .populate("commentId", "content")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit));

      // Format logs
      const timeline = logs.map((log) => ({
        id: log._id,
        actionType: log.actionType,
        description: log.description,
        timestamp: log.createdAt,
        metadata: log.metadata,
        pitchDeck: log.pitchDeck
          ? {
              id: log.pitchDeck._id,
              title: log.pitchDeck.title,
            }
          : null,
        relatedUser: log.userId
          ? {
              id: log.userId._id,
              name: `${log.userId.firstName} ${log.userId.lastName}`,
            }
          : null,
      }));

      res.json({
        userId,
        userName: `${user.firstName} ${user.lastName}`,
        timeline,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          totalPages: Math.ceil(total / parseInt(limit)),
        },
      });
    } catch (error) {
      console.error("Get user audit trail error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

/**
 * Get available action types (for filtering)
 * GET /api/audit-trail/action-types
 */
router.get("/action-types", authMiddleware, requireSAOrAnalyst, async (req, res) => {
  try {
    // Get distinct action types for this organization
    const actionTypes = await AuditLog.distinct("actionType", {
      organization: req.user.organization._id,
    });

    // Group by category for better UX
    const categorized = {
      "Pitch Deck": actionTypes.filter((at) => at.startsWith("PITCH_DECK")),
      "User Management": actionTypes.filter((at) =>
        at.includes("ANALYST") || at.includes("USER")
      ),
      "Comments & Notes": actionTypes.filter((at) => at.includes("COMMENT")),
      "Data Room": actionTypes.filter((at) => at.includes("DATA_ROOM")),
      "Supporting Documents": actionTypes.filter((at) =>
        at.includes("SUPPORTING_DOCUMENT")
      ),
      "Chat & Conversation": actionTypes.filter(
        (at) => at.includes("CHAT") || at.includes("MEETING")
      ),
      "Thesis": actionTypes.filter((at) => at.includes("THESIS")),
      "Other": actionTypes.filter(
        (at) =>
          !at.startsWith("PITCH_DECK") &&
          !at.includes("ANALYST") &&
          !at.includes("COMMENT") &&
          !at.includes("DATA_ROOM") &&
          !at.includes("SUPPORTING_DOCUMENT") &&
          !at.includes("CHAT") &&
          !at.includes("MEETING") &&
          !at.includes("THESIS")
      ),
    };

    res.json({
      actionTypes,
      categorized,
    });
  } catch (error) {
    console.error("Get action types error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;

