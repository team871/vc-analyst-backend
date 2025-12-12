const OpenAI = require("openai");
const { getOrganizationApiKey } = require("./organizationApiKeys");
// Note: We import downloadFromS3 inside the function to avoid circular dependencies

// Initialize OpenAI client with organization-specific API key
let openaiClients = new Map(); // Cache clients per organization

async function getOpenAIClient(organizationId) {
  if (!organizationId) {
    // Fallback to environment variable
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OpenAI API key not configured. Please set it in API Settings or environment variable."
      );
    }
    return new OpenAI({ apiKey });
  }

  // Check cache first
  if (openaiClients.has(organizationId.toString())) {
    return openaiClients.get(organizationId.toString());
  }

  // Get organization-specific API key
  const apiKey = await getOrganizationApiKey(organizationId, "openai");
  if (!apiKey) {
    throw new Error(
      "OpenAI API key not configured. Please set it in API Settings."
    );
  }

  const client = new OpenAI({ apiKey });
  openaiClients.set(organizationId.toString(), client);
  return client;
}

/**
 * Generate a mini summary/caption for a document using GPT-4o-mini
 * @param {Buffer|string} fileBufferOrS3Key - The document file buffer OR S3 file key
 * @param {string} fileName - Original file name
 * @param {string} mimeType - File MIME type
 * @param {string} organizationId - Organization ID for API key lookup
 * @returns {Promise<{summary: string, category: string}>} Summary and category
 */
async function generateDocumentSummary(
  fileBufferOrS3Key,
  fileName,
  mimeType,
  organizationId = null
) {
  try {
    if (!process.env.OPENAI_API_KEY) {
      console.warn("OPENAI_API_KEY not set, skipping AI summary generation");
      return {
        summary: `Document: ${fileName}`,
        category: "",
      };
    }

    const client = await getOpenAIClient(organizationId);

    // IMPORTANT: OpenAI's API doesn't support external URLs (including S3 signed URLs)
    // OpenAI requires files to be uploaded to their servers first via the Files API
    // This is why we upload to OpenAI even though the file is already in S3
    //
    // Flow:
    // 1. File arrives as buffer (initial upload) OR we download from S3 (regenerate)
    // 2. Upload to OpenAI Files API (required for OpenAI to process)
    // 3. Use OpenAI file_id in chat completion
    // 4. Clean up OpenAI file after processing
    //
    // Alternative approaches considered but not viable:
    // - Using S3 signed URLs: OpenAI can't access private S3 buckets
    // - Public S3 URLs: Security risk, not recommended
    const fs = require("fs");
    const path = require("path");
    const os = require("os");
    const { downloadFromS3 } = require("./s3Upload");

    // Determine if we have a buffer or S3 key
    let fileBuffer;
    if (Buffer.isBuffer(fileBufferOrS3Key)) {
      // Already a buffer (from initial upload)
      fileBuffer = fileBufferOrS3Key;
    } else if (typeof fileBufferOrS3Key === "string") {
      // It's an S3 key - download from S3
      console.log(
        `[DOC-SUMMARY] Downloading file from S3: ${fileBufferOrS3Key}`
      );
      fileBuffer = await downloadFromS3(fileBufferOrS3Key);
      if (!Buffer.isBuffer(fileBuffer)) {
        fileBuffer = Buffer.from(fileBuffer);
      }
    } else {
      throw new Error("Invalid input: expected Buffer or S3 file key string");
    }

    // Create temporary file
    const tempDir = os.tmpdir();
    const tempFilePath = path.join(
      tempDir,
      `doc-summary-${Date.now()}-${Math.random()
        .toString(36)
        .substring(7)}-${fileName}`
    );

    try {
      // Write buffer to temp file
      fs.writeFileSync(tempFilePath, fileBuffer);

      // OpenAI chat completions file input ONLY supports PDFs
      // For other file types, we need different approaches
      const fileExtension = path.extname(fileName).toLowerCase();
      const isImage = [".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(
        fileExtension
      );
      const isPDF = fileExtension === ".pdf";
      const isText = [".txt", ".csv", ".md"].includes(fileExtension);
      const isOfficeDoc = [
        ".xlsx",
        ".xls",
        ".docx",
        ".doc",
        ".pptx",
        ".ppt",
      ].includes(fileExtension);

      let completion;

      if (isPDF) {
        // Upload file to OpenAI for vision/PDF analysis
        const uploadedFile = await client.files.create({
          file: fs.createReadStream(tempFilePath),
          purpose: "assistants",
        });
        console.log("uploadedFile", uploadedFile);
        // Wait for file processing (longer wait for PDFs)
        const waitTime = isPDF ? 5000 : 2000;
        await new Promise((resolve) => setTimeout(resolve, waitTime));

        // Check file status
        let fileStatus = await client.files.retrieve(uploadedFile.id);
        let retries = 0;
        while (fileStatus.status !== "processed" && retries < 10) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          fileStatus = await client.files.retrieve(uploadedFile.id);
          retries++;
        }

        if (fileStatus.status !== "processed") {
          throw new Error("File processing timeout");
        }

        const prompt = `You are analyzing a document from a venture capital deal's data room. Generate a concise, informative summary/caption for this document.

Guidelines:
- Create a brief, professional summary (1-3 sentences maximum)
- Identify the document type and key information
- Examples:
  * "This document is the company's balance sheet for the fiscal year 2024-2025."
  * "This document is a breakdown of their technical infrastructure and architecture."
  * "This document is the shareholder agreement dated January 2024."
  * "This document contains the company's cap table showing ownership distribution."
- Be specific about dates, periods, or relevant details if visible
- If the document type is unclear, provide a general description

Return ONLY a JSON object with this structure:
{
  "summary": "Your concise summary here",
  "category": "Document category (e.g., 'Balance Sheet', 'Shareholder Agreement', 'Tech Infrastructure', 'Cap Table', etc.)"
}

Output valid JSON only.`;

        // For PDFs: OpenAI chat completions supports PDF files via file input
        // Format: type: "file" with file_id property (OpenAI API v2 format)
        completion = await client.chat.completions.create({
          model: "gpt-4o",
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: prompt,
                },
                {
                  type: "file",
                  file: {
                    file_id: uploadedFile.id,
                  },
                },
              ],
            },
          ],
          response_format: { type: "json_object" },
          temperature: 0.3,
        });

        // Clean up OpenAI file
        // await client.files.del(uploadedFile.id).catch(() => {
        //   // Ignore cleanup errors
        // });
      } else if (isImage) {
        // For images, use vision API with base64 (chat completions doesn't support image files)
        const base64Image = fileBuffer.toString("base64");
        const imageDataUrl = `data:${mimeType};base64,${base64Image}`;

        const prompt = `You are analyzing a document from a venture capital deal's data room. Generate a concise, informative summary/caption for this document.

Guidelines:
- Create a brief, professional summary (1-3 sentences maximum)
- Identify the document type and key information
- Be specific about dates, periods, or relevant details if visible

Return ONLY a JSON object with this structure:
{
  "summary": "Your concise summary here",
  "category": "Document category (e.g., 'Balance Sheet', 'Shareholder Agreement', 'Tech Infrastructure', 'Cap Table', etc.)"
}

Output valid JSON only.`;

        completion = await client.chat.completions.create({
          model: "gpt-4o",
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: prompt,
                },
                {
                  type: "image_url",
                  image_url: {
                    url: imageDataUrl,
                  },
                },
              ],
            },
          ],
          response_format: { type: "json_object" },
          temperature: 0.3,
        });
      } else if (isText) {
        // For text files, read content directly
        const fileContent = fs.readFileSync(tempFilePath, "utf8");
        const contentPreview = fileContent.substring(0, 10000); // Limit to first 10k chars

        const prompt = `You are analyzing a document from a venture capital deal's data room. Generate a concise, informative summary/caption for this document.

Document Content:
${contentPreview}

Guidelines:
- Create a brief, professional summary (1-3 sentences maximum)
- Identify the document type and key information
- Be specific about dates, periods, or relevant details if visible

Return ONLY a JSON object with this structure:
{
  "summary": "Your concise summary here",
  "category": "Document category (e.g., 'Balance Sheet', 'Shareholder Agreement', 'Tech Infrastructure', 'Cap Table', etc.)"
}

Output valid JSON only.`;

        completion = await client.chat.completions.create({
          model: "gpt-4o", // gpt-4o-mini doesn't support file inputs
          messages: [
            {
              role: "user",
              content: prompt,
            },
          ],
          response_format: { type: "json_object" },
          temperature: 0.3,
        });
      } else if (isOfficeDoc) {
        // For Office documents (Excel, Word, PowerPoint): OpenAI chat completions doesn't support these file types
        // Provide a summary based on filename and metadata
        const baseName = path.basename(fileName, fileExtension);
        let inferredCategory = "";
        const lowerName = baseName.toLowerCase();

        if (
          lowerName.includes("balance") ||
          lowerName.includes("financial") ||
          lowerName.includes("statement")
        ) {
          inferredCategory = "Financial Statement";
        } else if (
          lowerName.includes("shareholder") ||
          lowerName.includes("agreement") ||
          lowerName.includes("contract")
        ) {
          inferredCategory = "Legal Document";
        } else if (lowerName.includes("cap") || lowerName.includes("equity")) {
          inferredCategory = "Cap Table";
        } else if (
          lowerName.includes("tech") ||
          lowerName.includes("infrastructure")
        ) {
          inferredCategory = "Technical Documentation";
        } else if (fileExtension.includes("xls")) {
          inferredCategory = "Spreadsheet";
        } else if (fileExtension.includes("doc")) {
          inferredCategory = "Document";
        } else if (fileExtension.includes("ppt")) {
          inferredCategory = "Presentation";
        }

        // Use AI to generate a summary based on filename and file type
        const prompt = `You are analyzing a document from a venture capital deal's data room. 

Document Information:
- File Name: ${fileName}
- File Type: ${fileExtension.substring(1).toUpperCase()} file
- Inferred Category: ${inferredCategory || "Unknown"}

Generate a concise, informative summary/caption for this document based on its filename and type.

Guidelines:
- Create a brief, professional summary (1-3 sentences maximum)
- Infer what the document likely contains based on the filename
- Be specific if dates or periods are mentioned in the filename

Return ONLY a JSON object with this structure:
{
  "summary": "Your concise summary here",
  "category": "Document category"
}

Output valid JSON only.`;

        completion = await client.chat.completions.create({
          model: "gpt-4o-mini", // Can use mini for text-only prompts
          messages: [
            {
              role: "user",
              content: prompt,
            },
          ],
          response_format: { type: "json_object" },
          temperature: 0.3,
        });
      }

      // Clean up: delete temp file
      fs.unlinkSync(tempFilePath);

      const responseText = completion.choices[0].message.content;

      const parsed = JSON.parse(responseText);

      return {
        summary: parsed.summary || `Document: ${fileName}`,
        category: parsed.category || "",
      };
    } catch (uploadError) {
      // If file upload fails, try alternative approach with base64
      console.warn(
        "OpenAI file upload failed, trying alternative approach:",
        uploadError
      );

      // Clean up temp file if it exists
      if (tempFilePath && fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }

      // Fallback: Use text-based analysis (extract filename info)
      const fileExtension = path.extname(fileName).toLowerCase();
      const baseName = path.basename(fileName, fileExtension);

      // Try to infer category from filename
      let inferredCategory = "";
      const lowerName = baseName.toLowerCase();
      if (lowerName.includes("balance") || lowerName.includes("financial")) {
        inferredCategory = "Financial Statement";
      } else if (
        lowerName.includes("shareholder") ||
        lowerName.includes("agreement")
      ) {
        inferredCategory = "Legal Document";
      } else if (lowerName.includes("cap") || lowerName.includes("equity")) {
        inferredCategory = "Cap Table";
      } else if (
        lowerName.includes("tech") ||
        lowerName.includes("infrastructure")
      ) {
        inferredCategory = "Technical Documentation";
      }

      return {
        summary: `This document is ${baseName}${
          fileExtension
            ? ` (${fileExtension.substring(1).toUpperCase()} file)`
            : ""
        }.`,
        category: inferredCategory,
      };
    } finally {
      // Ensure temp file is cleaned up
      if (tempFilePath && fs.existsSync(tempFilePath)) {
        try {
          fs.unlinkSync(tempFilePath);
        } catch (e) {
          // Ignore cleanup errors
        }
      }
    }
  } catch (error) {
    console.error("Error generating document summary:", error);
    // Fallback to basic summary
    return {
      summary: `Document: ${fileName}`,
      category: "",
    };
  }
}

module.exports = {
  generateDocumentSummary,
};
