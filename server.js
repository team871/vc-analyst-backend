const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mongoose = require("mongoose");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
require("dotenv").config();

const authRoutes = require("./routes/auth");
const thesisRoutes = require("./routes/thesis.js");
const pitchDeckRoutes = require("./routes/pitchDeck");
const userRoutes = require("./routes/users.js");
const liveConversationRoutes = require("./routes/liveConversation").router;
const auditTrailRoutes = require("./routes/auditTrail");
const apiSettingsRoutes = require("./routes/apiSettings");
const { websocketAuth } = require("./middleware/websocketAuth");

const app = express();
// Trust proxy (so req.secure and IPs work correctly behind Nginx)
app.set("trust proxy", 1);

// Security middleware
// app.use(helmet());
// CORS configuration: allow specific frontends and handle preflight
// CORS configuration: Allow all origins (for development/testing)
// TODO: Restrict to specific origins in production
const corsOptions = {
  origin: true, // Allow all origins
  credentials: true,
  methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "Accept",
    "Origin",
    "X-Requested-With",
    "Access-Control-Request-Method",
    "Access-Control-Request-Headers",
  ],
  exposedHeaders: ["Content-Type", "Authorization"],
  maxAge: 86400, // 24 hours - cache preflight requests
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// Rate limiting
// const limiter = rateLimit({
//   windowMs: 15 * 60 * 1000, // 15 minutes
//   max: 100, // limit each IP to 100 requests per windowMs
// });
// app.use(limiter);

// Body parsing middleware
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Serve static files (for test UI)
app.use(express.static("public"));

// Connect to MongoDB
mongoose
  .connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.error("MongoDB connection error:", err));

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/thesis", thesisRoutes);
app.use("/api/pitch-decks", pitchDeckRoutes);
app.use("/api/users", userRoutes);
app.use("/api/live-conversations", liveConversationRoutes);
app.use("/api/audit-trail", auditTrailRoutes);
app.use("/api/api-settings", apiSettingsRoutes);

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({ status: "OK", timestamp: new Date().toISOString() });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);

  // Handle CORS errors specifically
  if (err.message === "Not allowed by CORS") {
    return res.status(403).json({
      message: "CORS: Origin not allowed",
      error: process.env.NODE_ENV === "development" ? err.message : "Forbidden",
    });
  }

  res.status(500).json({
    message: "Something went wrong!",
    error:
      process.env.NODE_ENV === "development"
        ? err.message
        : "Internal server error",
  });
});

// 404 handler
app.use("*", (req, res) => {
  res.status(404).json({ message: "Route not found" });
});

const PORT = process.env.PORT || 5000;

// Create HTTP server from Express app
const server = http.createServer(app);

// Initialize Socket.IO with CORS configuration
const io = new Server(server, {
  cors: {
    origin: true, // Allow all origins for Socket.IO
    methods: ["GET", "POST"],
    credentials: true,
  },
  transports: ["websocket", "polling"],
});

// WebSocket authentication middleware
io.use(websocketAuth);

// WebSocket connection handler
io.on("connection", (socket) => {
  console.log(`WebSocket client connected: ${socket.userId}`);

  // Initialize WebSocket handlers
  const {
    setupLiveConversationHandlers,
  } = require("./routes/liveConversation");
  setupLiveConversationHandlers(io, socket);

  socket.on("disconnect", (reason) => {
    console.log(
      `WebSocket client disconnected: ${socket.userId}, reason: ${reason}`
    );
  });

  socket.on("error", (error) => {
    console.error(`WebSocket error for ${socket.userId}:`, error);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`WebSocket server ready`);
});

module.exports = { app, server, io };
