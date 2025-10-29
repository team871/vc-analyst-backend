const AWS = require("aws-sdk");
const multer = require("multer");
const path = require("path");
const crypto = require("crypto");

// Configure AWS S3
AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
});

const s3 = new AWS.S3();

// Configure multer for memory storage
const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      "application/pdf",
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        new Error(
          "Invalid file type. Only PDF and PowerPoint files are allowed."
        ),
        false
      );
    }
  },
});

// Generate unique file key
const generateFileKey = (originalName, organizationId, type) => {
  const timestamp = Date.now();
  const randomString = crypto.randomBytes(8).toString("hex");
  const extension = path.extname(originalName);
  return `${type}/${organizationId}/${timestamp}-${randomString}${extension}`;
};

// Upload file to S3
const uploadToS3 = async (file, key) => {
  const params = {
    Bucket: process.env.S3_BUCKET_NAME,
    Key: key,
    Body: file.buffer,
    ContentType: file.mimetype,
    ACL: "private", // Private access
  };

  try {
    const result = await s3.upload(params).promise();
    return result.Location;
  } catch (error) {
    console.error("S3 upload error:", error);
    throw new Error("Failed to upload file to S3");
  }
};

// Delete file from S3
const deleteFromS3 = async (key) => {
  const params = {
    Bucket: process.env.S3_BUCKET_NAME,
    Key: key,
  };

  try {
    await s3.deleteObject(params).promise();
    return true;
  } catch (error) {
    console.error("S3 delete error:", error);
    throw new Error("Failed to delete file from S3");
  }
};

// Generate signed URL for file access
const generateSignedUrl = async (key, expiresIn = 3600) => {
  const params = {
    Bucket: process.env.S3_BUCKET_NAME,
    Key: key,
    Expires: expiresIn,
  };

  try {
    const url = await s3.getSignedUrlPromise("getObject", params);
    return url;
  } catch (error) {
    console.error("Generate signed URL error:", error);
    throw new Error("Failed to generate file access URL");
  }
};

module.exports = {
  upload,
  uploadToS3,
  deleteFromS3,
  generateSignedUrl,
  generateFileKey,
};
