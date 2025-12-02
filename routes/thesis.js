const express = require("express");
const { body, validationResult } = require("express-validator");
const Thesis = require("../models/Thesis");
const {
  authMiddleware,
  requireSA,
  requireSAOrAnalyst,
} = require("../middleware/auth");
const {
  upload,
  uploadToS3,
  deleteFromS3,
  generateFileKey,
  generateSignedUrl,
} = require("../utils/s3Upload");
const Perplexity = require("@perplexity-ai/perplexity_ai");
const { tryParseJson, toThesisProfile } = require("../utils/helpers");

const router = express.Router();
const perplexity = new Perplexity();

/**
 * Background thesis analysis helper.
 * Takes a base64-encoded PDF, calls Perplexity, and updates the Thesis record.
 */
async function analyzeThesisInBackground({
  thesisId,
  organizationId,
  userId,
  title,
  encodedFile,
  originalFileName,
  fileSize,
}) {
  try {
    console.log(`[THESIS-BG] Starting background analysis for thesis ${thesisId}`);

    let aiContent = "";
    try {
      const completion = await perplexity.chat.completions.create({
        model: "sonar-pro",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `You are DealFlow AI — an AI assistant for Venture Capital firms.

Your job: Analyze this investment thesis document ABOUT OUR FIRM (goals, preferences, and constraints) and produce a structured, investment-grade firm profile.

Input: A firm thesis document (PDF).
Output: A single JSON object — concise, factual, and well-structured.

Rules:
• Extract insights only from the thesis document — no external data or assumptions.
• If information is missing, mark as "unknown" and briefly note what's missing.
• Be objective, evidence-based, and avoid speculation.
• Focus on the firm's investment preferences rather than company analysis.

Return this JSON structure:

{
  "firmSummary": "Overall description of the firm's investment focus and philosophy (2-3 sentences).",
  "investmentObjectives": "Primary investment goals and strategic objectives.",
  "targetSectors": ["List of target sectors/industries for investment."],
  "stages": ["List of target investment stages (Seed, Series A, etc.)."],
  "geographies": ["List of target geographic regions."],
  "checkSize": {
    "min": "Minimum check size amount",
    "max": "Maximum check size amount", 
    "currency": "Currency (USD, EUR, etc.)"
  },
  "ownershipTargets": "Target ownership percentage range or preferences.",
  "timeHorizon": "Typical investment holding period or exit timeline.",
  "returnTargets": "Expected return targets or IRR goals.",
  "riskTolerance": "Risk appetite and tolerance levels.",
  "constraints": ["List of investment constraints or limitations."],
  "exclusions": ["List of sectors, stages, or deal types to avoid."],
  "esgPolicy": "ESG (Environmental, Social, Governance) investment policy.",
  "diligenceFramework": {
    "criteria": ["List of key due diligence criteria."],
    "redFlags": ["List of red flags or deal breakers."]
  },
  "sourcingStrategy": ["List of deal sourcing strategies and channels."],
  "portfolioConstruction": "Portfolio construction and allocation strategy.",
  "governancePreferences": "Board participation and governance preferences.",
  "valueCreationPlan": "Value creation and portfolio company support approach.",
  "decisionProcess": "Investment decision-making process and approval workflow.",
  "exampleDeals": ["List of example deals or case studies mentioned."],
  "openQuestions": ["Top 5 questions that need clarification about the firm's thesis."],
  "confidenceScore": 1-10
}

Keep tone professional, clear, and investor-grade. Output valid JSON only.`,
              },
              {
                type: "file_url",
                file_url: {
                  url: encodedFile, // base64 without prefix
                },
                file_name: originalFileName,
              },
            ],
          },
        ],
      });

      aiContent = completion.choices[0].message.content;
    } catch (aiError) {
      console.error("[THESIS-BG] Perplexity AI error:", aiError);
      aiContent = "AI analysis failed. Please try again later.";
    }

    const parsed = tryParseJson(aiContent);
    const profile = toThesisProfile(parsed);

    await Thesis.findByIdAndUpdate(
      thesisId,
      {
        $set: {
          title,
          content: profile ? JSON.stringify(profile) : aiContent,
          rawContent: aiContent,
          profile: profile || undefined,
          originalPdfUrl: "",
          originalPdfKey: "",
          organization: organizationId,
          createdBy: userId,
          lastModifiedBy: userId,
          metadata: {
            fileSize,
            uploadDate: new Date(),
            analysisDate: new Date(),
            aiModel: "sonar-pro",
          },
        },
      },
      { new: true }
    );

    console.log(`[THESIS-BG] Analysis completed for thesis ${thesisId}`);
  } catch (error) {
    console.error(
      `[THESIS-BG] Thesis analysis error for ${thesisId}:`,
      error
    );
    // In case of failure, leave thesis record as-is; frontend can show generic error message
  }
}

// Upload and create thesis (SA only)
router.post(
  "/upload",
  authMiddleware,
  requireSA,
  upload.single("thesis"),
  async (req, res) => {
    try {
      console.log("Uploading thesis...");
      if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
      }

      const { title } = req.body;
      if (!title) {
        return res.status(400).json({ message: "Title is required" });
      }

      // Convert to base64 for in-memory analysis (no storage)
      const encodedFile = req.file.buffer.toString("base64");

      // Create placeholder thesis record first; analysis will populate content in background
      const thesis = new Thesis({
        title,
        content: "",
        rawContent: "",
        profile: undefined,
        originalPdfUrl: "",
        originalPdfKey: "",
        organization: req.user.organization._id,
        createdBy: req.user._id,
        lastModifiedBy: req.user._id,
        metadata: {
          fileSize: req.file.size,
          uploadDate: new Date(),
          analysisDate: null,
          aiModel: "sonar-pro",
        },
      });

      await thesis.save();

      // Run AI analysis in the background
      setImmediate(() => {
        analyzeThesisInBackground({
          thesisId: thesis._id,
          organizationId: req.user.organization._id,
          userId: req.user._id,
          title,
          encodedFile,
          originalFileName: req.file.originalname,
          fileSize: req.file.size,
        }).catch((err) => {
          console.error(
            `[THESIS] Background analysis failed for thesis ${thesis._id}:`,
            err
          );
        });
      });

      res.status(201).json({
        message: "Thesis uploaded; analysis is running in the background",
        thesis: {
          id: thesis._id,
          title: thesis.title,
          content: thesis.content,
          version: thesis.version,
          createdAt: thesis.createdAt,
          analysisPending: true,
        },
      });
    } catch (error) {
      console.error("Thesis upload error:", error);
      res.status(500).json({ message: "Server error during thesis upload" });
    }
  }
);

// Get all theses (SA and Analysts can view)
router.get("/", authMiddleware, requireSAOrAnalyst, async (req, res) => {
  try {
    const theses = await Thesis.find({
      organization: req.user.organization._id,
      isActive: true,
    })
      .populate("createdBy", "firstName lastName email")
      .populate("lastModifiedBy", "firstName lastName email")
      .sort({ createdAt: -1 });

    res.json({ theses });
  } catch (error) {
    console.error("Get theses error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// Get specific thesis
router.get("/:id", authMiddleware, requireSAOrAnalyst, async (req, res) => {
  try {
    const thesis = await Thesis.findOne({
      _id: req.params.id,
      organization: req.user.organization._id,
      isActive: true,
    })
      .populate("createdBy", "firstName lastName email")
      .populate("lastModifiedBy", "firstName lastName email");

    if (!thesis) {
      return res.status(404).json({ message: "Thesis not found" });
    }

    res.json({
      thesis: {
        ...thesis.toObject(),
        originalPdfUrl: "",
      },
    });
  } catch (error) {
    console.error("Get thesis error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// Update thesis (SA only)
router.put(
  "/:id",
  authMiddleware,
  requireSA,
  upload.single("thesis"),
  async (req, res) => {
    try {
      const thesis = await Thesis.findOne({
        _id: req.params.id,
        organization: req.user.organization._id,
        isActive: true,
      });

      if (!thesis) {
        return res.status(404).json({ message: "Thesis not found" });
      }

      const updateData = {
        lastModifiedBy: req.user._id,
        version: thesis.version + 1,
      };

      // If new file is uploaded (analyze in-memory, no storage) - run in background
      if (req.file) {
        updateData.metadata = {
          ...thesis.metadata,
          fileSize: req.file.size,
          uploadDate: new Date(),
          analysisDate: null,
        };

        const encodedFile = req.file.buffer.toString("base64");

        setImmediate(() => {
          analyzeThesisInBackground({
            thesisId: thesis._id,
            organizationId: req.user.organization._id,
            userId: req.user._id,
            title: req.body.title || thesis.title,
            encodedFile,
            originalFileName: req.file.originalname,
            fileSize: req.file.size,
          }).catch((err) => {
            console.error(
              `[THESIS] Background re-analysis failed for thesis ${thesis._id}:`,
              err
            );
          });
        });
      }

      // Update title if provided
      if (req.body.title) {
        updateData.title = req.body.title;
      }

      const updatedThesis = await Thesis.findByIdAndUpdate(
        req.params.id,
        updateData,
        { new: true }
      )
        .populate("createdBy", "firstName lastName email")
        .populate("lastModifiedBy", "firstName lastName email");

      res.json({
        message: "Thesis updated successfully",
        thesis: updatedThesis,
      });
    } catch (error) {
      console.error("Update thesis error:", error);
      res.status(500).json({ message: "Server error" });
    }
  }
);

// Delete thesis (SA only)
router.delete("/:id", authMiddleware, requireSA, async (req, res) => {
  try {
    const thesis = await Thesis.findOne({
      _id: req.params.id,
      organization: req.user.organization._id,
      isActive: true,
    });

    if (!thesis) {
      return res.status(404).json({ message: "Thesis not found" });
    }

    // Soft delete thesis
    thesis.isActive = false;
    await thesis.save();

    res.json({ message: "Thesis deleted successfully" });
  } catch (error) {
    console.error("Delete thesis error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
