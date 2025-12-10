#!/bin/bash

# VC Analyst Backend - EC2 Setup Script
# This script sets up the EC2 instance with all necessary dependencies

set -e  # Exit on error

echo "========================================="
echo "VC Analyst Backend - EC2 Setup"
echo "========================================="

# Update system packages
echo "Updating system packages..."
sudo yum update -y

# Install Node.js 18.x (LTS)
echo "Installing Node.js..."
if ! command -v node &> /dev/null; then
    curl -fsSL https://rpm.nodesource.com/setup_18.x | sudo bash -
    sudo yum install -y nodejs
else
    echo "Node.js already installed: $(node --version)"
fi

# Verify Node.js and npm installation
node --version
npm --version

# Install Git (if not already installed)
echo "Installing Git..."
sudo yum install -y git

# Install MongoDB (if not using external MongoDB)
# Uncomment the following lines if you want to install MongoDB on the EC2 instance
# echo "Installing MongoDB..."
# sudo tee /etc/yum.repos.d/mongodb-org-7.0.repo <<EOF
# [mongodb-org-7.0]
# name=MongoDB Repository
# baseurl=https://repo.mongodb.org/yum/amazon/2023/mongodb-org/7.0/x86_64/
# gpgcheck=1
# enabled=1
# gpgkey=https://www.mongodb.org/static/pgp/server-7.0.asc
# EOF
# sudo yum install -y mongodb-org
# sudo systemctl enable mongod
# sudo systemctl start mongod

# Install PM2 for process management (alternative to systemd)
echo "Installing PM2 globally..."
sudo npm install -g pm2

# Install build tools (needed for some npm packages)
echo "Installing build tools..."
sudo yum groupinstall -y "Development Tools"
sudo yum install -y python3

# Create application directory
echo "Creating application directory..."
APP_DIR="/opt/vc-analyst"
sudo mkdir -p $APP_DIR
sudo chown $USER:$USER $APP_DIR

# Set up firewall (if needed)
echo "Configuring firewall..."
# Allow HTTP (port 80), HTTPS (port 443), and application port (5000)
sudo firewall-cmd --permanent --add-port=5000/tcp || true
sudo firewall-cmd --permanent --add-service=http || true
sudo firewall-cmd --permanent --add-service=https || true
sudo firewall-cmd --reload || true

# For Amazon Linux 2023, use firewalld or security groups
# Note: EC2 security groups should be configured in AWS Console

echo "========================================="
echo "Setup completed successfully!"
echo "========================================="
echo "Next steps:"
echo "1. Clone your repository to $APP_DIR"
echo "2. Run the deploy script: ./scripts/deploy.sh"
echo "3. Configure environment variables"
echo "4. Start the service"

