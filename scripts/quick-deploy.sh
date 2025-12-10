#!/bin/bash

# VC Analyst Backend - Quick Deploy Script
# This is a combined script that does setup and deployment in one go
# Use this if you're deploying to a fresh EC2 instance

set -e

echo "========================================="
echo "VC Analyst Backend - Quick Deploy"
echo "========================================="

# Check if running as root or with sudo
if [ "$EUID" -eq 0 ]; then 
   echo "Please do not run as root. Run as ec2-user or your regular user."
   exit 1
fi

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "Project directory: $PROJECT_DIR"

# Step 1: Fix permissions and run setup script
echo ""
echo "Step 1: Running EC2 setup..."
cd "$PROJECT_DIR"

# Fix ownership if needed
if [ ! -w "scripts/setup-ec2.sh" ]; then
    echo "Fixing file ownership..."
    sudo chown -R $USER:$USER "$PROJECT_DIR"
fi

# Make scripts executable (ignore errors if already executable)
chmod +x scripts/setup-ec2.sh 2>/dev/null || true
chmod +x scripts/deploy.sh 2>/dev/null || true

./scripts/setup-ec2.sh

# Step 2: Check for .env file
echo ""
echo "Step 2: Checking environment configuration..."
if [ ! -f "$PROJECT_DIR/.env" ]; then
    echo "WARNING: .env file not found!"
    echo ""
    echo "Creating .env template..."
    cat > "$PROJECT_DIR/.env.example" << 'EOF'
# Server Configuration
NODE_ENV=production
PORT=5000

# Database
MONGODB_URI=mongodb://localhost:27017/vc-analyst

# Security
JWT_SECRET=change-this-to-a-random-secret-key
ENCRYPTION_KEY=change-this-to-a-random-encryption-key

# AWS Configuration
AWS_ACCESS_KEY_ID=your-aws-access-key-id
AWS_SECRET_ACCESS_KEY=your-aws-secret-access-key
AWS_REGION=us-east-1
S3_BUCKET_NAME=your-s3-bucket-name

# API Keys
PERPLEXITY_API_KEY=your-perplexity-api-key
OPENAI_API_KEY=your-openai-api-key
ELEVENLABS_API_KEY=your-elevenlabs-api-key

# Optional
ALLOWED_ORIGINS=https://yourdomain.com
LOG_LEVEL=info
EOF
    echo ""
    echo "Please create a .env file with your configuration:"
    echo "  cp $PROJECT_DIR/.env.example $PROJECT_DIR/.env"
    echo "  nano $PROJECT_DIR/.env"
    echo ""
    read -p "Press Enter after you've created and configured the .env file..."
fi

# Step 3: Run deployment script
echo ""
echo "Step 3: Deploying application..."
# Script should already be executable from Step 1, but ensure it is
chmod +x scripts/deploy.sh 2>/dev/null || true
./scripts/deploy.sh

echo ""
echo "========================================="
echo "Quick deploy completed!"
echo "========================================="
echo ""
echo "Next steps:"
echo "1. Verify service is running: sudo systemctl status vc-analyst"
echo "2. Check logs: sudo journalctl -u vc-analyst -f"
echo "3. Test health endpoint: curl http://localhost:5000/api/health"
echo ""
echo "If everything looks good, configure your security group to allow"
echo "traffic on port 5000 (or set up Nginx reverse proxy)."

