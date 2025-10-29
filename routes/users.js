const express = require("express");
const { body, validationResult } = require("express-validator");
const User = require("../models/User");
const { authMiddleware, requireSA } = require("../middleware/auth");

const router = express.Router();

// Create analyst (SA only)
router.post(
  "/create-analyst",
  authMiddleware,
  requireSA,
  [
    body("email").isEmail().normalizeEmail(),
    body("password").isLength({ min: 6 }),
    body("firstName").trim().notEmpty(),
    body("lastName").trim().notEmpty(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { email, password, firstName, lastName } = req.body;

      // Check if user already exists
      const existingUser = await User.findOne({ email });
      if (existingUser) {
        return res.status(400).json({ message: "User already exists" });
      }

      // Create analyst user
      const user = new User({
        email,
        password,
        firstName,
        lastName,
        role: "ANALYST",
        organization: req.user.organization._id,
      });
      await user.save();

      res.status(201).json({
        message: "Analyst created successfully",
        user: {
          id: user._id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role,
        },
      });
    } catch (error) {
      console.error("Create analyst error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

// Get all analysts in organization (SA only)
router.get("/analysts", authMiddleware, requireSA, async (req, res) => {
  try {
    const analysts = await User.find({
      organization: req.user.organization._id,
      role: "ANALYST",
      isActive: true,
    }).select("-password");

    res.json({ analysts });
  } catch (error) {
    console.error("Get analysts error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// Deactivate analyst (SA only)
router.patch(
  "/analysts/:id/deactivate",
  authMiddleware,
  requireSA,
  async (req, res) => {
    try {
      const analyst = await User.findOne({
        _id: req.params.id,
        organization: req.user.organization._id,
        role: "ANALYST",
      });

      if (!analyst) {
        return res.status(404).json({ message: "Analyst not found" });
      }

      analyst.isActive = false;
      await analyst.save();

      res.json({ message: "Analyst deactivated successfully" });
    } catch (error) {
      console.error("Deactivate analyst error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

module.exports = router;
