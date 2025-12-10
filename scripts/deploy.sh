#!/bin/bash

# VC Analyst Backend - Deployment Script
# This script deploys the application to the EC2 instance

set -e  # Exit on error

echo "========================================="
echo "VC Analyst Backend - Deployment"
echo "========================================="

# Configuration
APP_DIR="/opt/vc-analyst"
SERVICE_USER="${USER:-ec2-user}"
NODE_ENV="${NODE_ENV:-production}"

# Check if we're in the right directory
if [ ! -f "package.json" ]; then
    echo "Error: package.json not found. Please run this script from the project root."
    exit 1
fi

# Create application directory if it doesn't exist
if [ ! -d "$APP_DIR" ]; then
    echo "Creating application directory..."
    sudo mkdir -p $APP_DIR
    sudo chown $SERVICE_USER:$SERVICE_USER $APP_DIR
fi

# Copy application files
echo "Copying application files..."
sudo rsync -av --exclude 'node_modules' --exclude '.git' --exclude 'uploads/*' \
    --exclude '.env' \
    ./ $APP_DIR/

# Change to application directory
cd $APP_DIR

# Install dependencies
echo "Installing dependencies..."
npm ci --production

# Create necessary directories
echo "Creating necessary directories..."
mkdir -p uploads
mkdir -p logs

# Set permissions
echo "Setting permissions..."
chmod +x server.js
chown -R $SERVICE_USER:$SERVICE_USER $APP_DIR

# Check if .env file exists
if [ ! -f "$APP_DIR/.env" ]; then
    echo "========================================="
    echo "WARNING: .env file not found!"
    echo "========================================="
    echo "Please create a .env file with the following variables:"
    echo ""
    echo "MONGODB_URI=mongodb://localhost:27017/vc-analyst"
    echo "PORT=5000"
    echo "NODE_ENV=production"
    echo "JWT_SECRET=your-secret-key-here"
    echo "ENCRYPTION_KEY=your-encryption-key-here"
    echo "AWS_ACCESS_KEY_ID=your-aws-access-key"
    echo "AWS_SECRET_ACCESS_KEY=your-aws-secret-key"
    echo "AWS_REGION=us-east-1"
    echo "S3_BUCKET_NAME=your-bucket-name"
    echo "PERPLEXITY_API_KEY=your-perplexity-key"
    echo "OPENAI_API_KEY=your-openai-key"
    echo ""
    echo "You can create it manually or use:"
    echo "  sudo nano $APP_DIR/.env"
    exit 1
fi

# Install systemd service (if not already installed)
if [ ! -f "/etc/systemd/system/vc-analyst.service" ]; then
    echo "Installing systemd service..."
    sudo cp scripts/vc-analyst.service /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl enable vc-analyst
    echo "Systemd service installed and enabled"
else
    echo "Systemd service already installed"
fi

# Restart the service
echo "Restarting service..."
sudo systemctl restart vc-analyst

# Check service status
echo "Checking service status..."
sleep 2
sudo systemctl status vc-analyst --no-pager || true

echo "========================================="
echo "Deployment completed!"
echo "========================================="
echo "Service status: sudo systemctl status vc-analyst"
echo "View logs: sudo journalctl -u vc-analyst -f"
echo "Restart service: sudo systemctl restart vc-analyst"

