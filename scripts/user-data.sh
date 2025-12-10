#!/bin/bash

# EC2 User Data Script
# This script runs automatically when the EC2 instance launches
# Use this in the EC2 Launch Configuration or Instance User Data

set -e

# Log everything
exec > >(tee /var/log/user-data.log|logger -t user-data -s 2>/dev/console) 2>&1

echo "Starting VC Analyst Backend setup..."

# Update system
yum update -y

# Install Node.js 18.x
curl -fsSL https://rpm.nodesource.com/setup_18.x | bash -
yum install -y nodejs

# Install Git
yum install -y git

# Install PM2
npm install -g pm2

# Install build tools
yum groupinstall -y "Development Tools"
yum install -y python3

# Create application directory
mkdir -p /opt/vc-analyst
chown ec2-user:ec2-user /opt/vc-analyst

# Note: The application code should be deployed separately
# Either via:
# 1. CodeDeploy
# 2. S3 + bootstrap script
# 3. Git clone (if repository is public or using deploy keys)
# 4. Manual deployment after instance launch

echo "Basic setup completed. Application deployment required."

