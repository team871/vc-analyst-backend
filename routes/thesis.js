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

const router = express.Router();
const perplexity = new Perplexity();

// Upload and create thesis (SA only)
router.post(
  "/upload",
  authMiddleware,
  requireSA,
  upload.single("thesis"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
      }

      const { title } = req.body;
      if (!title) {
        return res.status(400).json({ message: "Title is required" });
      }

      // Convert to base64 for in-memory analysis (no storage)
      const encodedFile = req.file.buffer.toString("base64");

      // Generate AI analysis using Perplexity
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
                  text: `This PDF is an investment thesis ABOUT OUR FIRM (goals, preferences, and constraints), not a startup pitch. Extract ONLY what is explicitly present in the document and return a single JSON object with these fields:

firmSummary,
investmentObjectives,
targetSectors (array of strings),
stages (array of strings),
geographies (array of strings),
checkSize { min, max, currency },
ownershipTargets,
timeHorizon,
returnTargets,
riskTolerance,
constraints (array of strings),
exclusions (array of strings),
esgPolicy,
diligenceFramework { criteria (array of strings), redFlags (array of strings) },
sourcingStrategy (array of strings),
portfolioConstruction,
governancePreferences,
valueCreationPlan,
decisionProcess,
exampleDeals (array of strings),
openQuestions (array of strings),
confidenceScore (number 1-10).

Rules: Do not fabricate or infer beyond the PDF. If a field is not stated, set it to null (or empty array). Focus on the firm’s preferences rather than company analysis.`,
                },
                {
                  type: "file_url",
                  file_url: {
                    url: encodedFile, // base64 without prefix
                  },
                  file_name: req.file.originalname,
                },
              ],
            },
          ],
        });

        aiContent = completion.choices[0].message.content;
      } catch (aiError) {
        console.error("Perplexity AI error:", aiError);
        aiContent = "AI analysis failed. Please try again later.";
      }

      // Create thesis record (no file storage)
      const thesis = new Thesis({
        title,
        content: aiContent,
        originalPdfUrl: "",
        originalPdfKey: "",
        organization: req.user.organization._id,
        createdBy: req.user._id,
        lastModifiedBy: req.user._id,
        metadata: {
          fileSize: req.file.size,
          uploadDate: new Date(),
          analysisDate: new Date(),
          aiModel: "sonar-pro",
        },
      });

      await thesis.save();

      res.status(201).json({
        message: "Thesis uploaded and analyzed successfully",
        thesis: {
          id: thesis._id,
          title: thesis.title,
          content: thesis.content,
          version: thesis.version,
          createdAt: thesis.createdAt,
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

      // If new file is uploaded (analyze in-memory, no storage)
      if (req.file) {
        updateData.metadata = {
          ...thesis.metadata,
          fileSize: req.file.size,
          uploadDate: new Date(),
          analysisDate: new Date(),
        };

        // Generate new AI analysis
        try {
          const encodedFile = req.file.buffer.toString("base64");
          const completion = await perplexity.chat.completions.create({
            model: "sonar-pro",
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: `This PDF is an investment thesis ABOUT OUR FIRM (goals, preferences, and constraints), not a startup pitch. Extract ONLY what is explicitly present in the document and return a single JSON object with these fields:

firmSummary,
investmentObjectives,
targetSectors (array of strings),
stages (array of strings),
geographies (array of strings),
checkSize { min, max, currency },
ownershipTargets,
timeHorizon,
returnTargets,
riskTolerance,
constraints (array of strings),
exclusions (array of strings),
esgPolicy,
diligenceFramework { criteria (array of strings), redFlags (array of strings) },
sourcingStrategy (array of strings),
portfolioConstruction,
governancePreferences,
valueCreationPlan,
decisionProcess,
exampleDeals (array of strings),
openQuestions (array of strings),
confidenceScore (number 1-10).

Rules: Do not fabricate or infer beyond the PDF. If a field is not stated, set it to null (or empty array). Focus on the firm’s preferences rather than company analysis.`,
                  },
                  {
                    type: "file_url",
                    file_url: {
                      url: encodedFile,
                    },
                    file_name: req.file.originalname,
                  },
                ],
              },
            ],
          });

          updateData.content = completion.choices[0].message.content;
        } catch (aiError) {
          console.error("Perplexity AI error:", aiError);
          updateData.content = "AI analysis failed. Please try again later.";
        }
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
