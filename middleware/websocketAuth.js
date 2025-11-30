const jwt = require("jsonwebtoken");
const User = require("../models/User");

const websocketAuth = async (socket, next) => {
  try {
    // Get token from handshake auth or query
    const token =
      socket.handshake.auth?.token || socket.handshake.query?.token;

    if (!token) {
      return next(new Error("Authentication error: No token provided"));
    }

    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.userId).populate("organization");

    if (!user || !user.isActive) {
      return next(new Error("Authentication error: Invalid token"));
    }

    // Attach user to socket
    socket.user = user;
    socket.userId = user._id.toString();
    socket.organizationId = user.organization._id.toString();

    next();
  } catch (error) {
    console.error("WebSocket auth error:", error);
    next(new Error("Authentication error: " + error.message));
  }
};

module.exports = { websocketAuth };

