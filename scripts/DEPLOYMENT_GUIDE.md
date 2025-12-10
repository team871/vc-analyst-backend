# VC Analyst Backend - AWS EC2 Deployment Guide

This guide will help you deploy the VC Analyst backend on an AWS EC2 instance.

## Prerequisites

- AWS EC2 instance running Amazon Linux 2023 (or similar)
- SSH access to the instance
- MongoDB database (can be on EC2 or external like MongoDB Atlas)
- AWS S3 bucket for file storage
- API keys for Perplexity, OpenAI, and optionally ElevenLabs

## Step 1: Launch EC2 Instance

1. Launch an EC2 instance using Amazon Linux 2023 AMI
2. Configure security group to allow:
   - SSH (port 22) from your IP
   - HTTP (port 80) - if using reverse proxy
   - HTTPS (port 443) - if using reverse proxy
   - Application port (port 5000) - from your load balancer or specific IPs
3. Create or use an existing key pair for SSH access

## Step 2: Connect to EC2 Instance

```bash
ssh -i your-key.pem ec2-user@your-ec2-ip
```

## Step 3: Initial Setup

### Option A: Clone Repository (Recommended)

```bash
# Install Git if not already installed
sudo yum install -y git

# Clone your repository
cd /opt
sudo git clone https://github.com/your-username/vc-analyst.git
sudo chown -R ec2-user:ec2-user vc-analyst
cd vc-analyst
```

### Option B: Upload Files via SCP

From your local machine:

```bash
scp -i your-key.pem -r . ec2-user@your-ec2-ip:/opt/vc-analyst
```

## Step 4: Run Setup Script

```bash
cd /opt/vc-analyst
chmod +x scripts/setup-ec2.sh
./scripts/setup-ec2.sh
```

This script will:
- Update system packages
- Install Node.js 18.x
- Install Git
- Install PM2 (process manager)
- Install build tools
- Configure firewall rules

## Step 5: Configure Environment Variables

Create a `.env` file in `/opt/vc-analyst`:

```bash
sudo nano /opt/vc-analyst/.env
```

Add the following environment variables:

```env
# Server Configuration
NODE_ENV=production
PORT=5000

# Database
MONGODB_URI=mongodb://localhost:27017/vc-analyst
# OR for MongoDB Atlas:
# MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/vc-analyst

# Security
JWT_SECRET=your-super-secret-jwt-key-change-this-in-production
ENCRYPTION_KEY=your-encryption-key-for-api-keys-change-this

# AWS Configuration
AWS_ACCESS_KEY_ID=your-aws-access-key-id
AWS_SECRET_ACCESS_KEY=your-aws-secret-access-key
AWS_REGION=us-east-1
S3_BUCKET_NAME=your-s3-bucket-name

# API Keys
PERPLEXITY_API_KEY=your-perplexity-api-key
OPENAI_API_KEY=your-openai-api-key
ELEVENLABS_API_KEY=your-elevenlabs-api-key  # Optional

# Optional Configuration
ALLOWED_ORIGINS=https://yourdomain.com,https://www.yourdomain.com
LOG_LEVEL=info
```

**Important Security Notes:**
- Use strong, random values for `JWT_SECRET` and `ENCRYPTION_KEY`
- Never commit `.env` file to version control
- Consider using AWS Secrets Manager for production

## Step 6: Deploy Application

```bash
cd /opt/vc-analyst
chmod +x scripts/deploy.sh
./scripts/deploy.sh
```

This script will:
- Copy application files
- Install npm dependencies
- Create necessary directories
- Install and enable systemd service
- Start the application

## Step 7: Verify Deployment

Check if the service is running:

```bash
sudo systemctl status vc-analyst
```

View logs:

```bash
sudo journalctl -u vc-analyst -f
```

Test the health endpoint:

```bash
curl http://localhost:5000/api/health
```

## Step 8: Configure Nginx + SSL (Recommended for Production)

For production, set up Nginx as a reverse proxy with SSL certificate.

### Quick Setup (Automated)

**Prerequisites:**
- Domain name pointing to your EC2 instance IP
- DNS A record configured

```bash
# Run the automated setup script
cd /opt/vc-analyst-backend
chmod +x scripts/setup-nginx-ssl.sh
sudo ./scripts/setup-nginx-ssl.sh

# Or with domain and email as arguments
sudo ./scripts/setup-nginx-ssl.sh api.yourdomain.com your-email@example.com
```

The script will:
- Install Nginx and Certbot
- Create Nginx configuration
- Obtain SSL certificate from Let's Encrypt
- Set up auto-renewal
- Configure HTTP to HTTPS redirect

### Manual Setup

See `scripts/NGINX_SSL_SETUP.md` for detailed manual setup instructions.

### After Setup

1. **Update your `.env` file** to include your domain:
   ```env
   ALLOWED_ORIGINS=https://api.yourdomain.com,https://yourdomain.com
   ```

2. **Restart your backend**:
   ```bash
   sudo systemctl restart vc-analyst
   ```

3. **Test your API**:
   ```bash
   curl https://api.yourdomain.com/api/health
   ```

For troubleshooting and detailed configuration, see `scripts/NGINX_SSL_SETUP.md`.

## Service Management

### Start Service
```bash
sudo systemctl start vc-analyst
```

### Stop Service
```bash
sudo systemctl stop vc-analyst
```

### Restart Service
```bash
sudo systemctl restart vc-analyst
```

### View Logs
```bash
# Real-time logs
sudo journalctl -u vc-analyst -f

# Last 100 lines
sudo journalctl -u vc-analyst -n 100

# Logs since today
sudo journalctl -u vc-analyst --since today
```

### Check Status
```bash
sudo systemctl status vc-analyst
```

## Troubleshooting

### Service won't start

1. Check logs: `sudo journalctl -u vc-analyst -n 50`
2. Verify `.env` file exists and has correct values
3. Check MongoDB connection: `mongosh "your-mongodb-uri"`
4. Verify Node.js version: `node --version` (should be 18.x or higher)
5. Check file permissions: `ls -la /opt/vc-analyst`

### Port already in use

```bash
# Find process using port 5000
sudo lsof -i :5000

# Kill the process if needed
sudo kill -9 <PID>
```

### MongoDB connection issues

- Verify MongoDB is running: `sudo systemctl status mongod`
- Check MongoDB logs: `sudo journalctl -u mongod -f`
- Verify connection string in `.env` file
- Check security group/firewall rules if using external MongoDB

### Permission issues

```bash
# Fix ownership
sudo chown -R ec2-user:ec2-user /opt/vc-analyst

# Fix permissions
chmod +x /opt/vc-analyst/server.js
```

## Updating the Application

When you need to update the application:

```bash
cd /opt/vc-analyst

# Pull latest changes (if using git)
git pull origin main

# Or upload new files via SCP

# Run deployment script
./scripts/deploy.sh
```

## Monitoring

### Set up CloudWatch Logs (Optional)

Install CloudWatch agent:

```bash
wget https://s3.amazonaws.com/amazoncloudwatch-agent/amazon_linux/amd64/latest/amazon-cloudwatch-agent.rpm
sudo rpm -U ./amazon-cloudwatch-agent.rpm
```

Configure CloudWatch to monitor:
- Application logs
- System metrics
- Application health

## Security Best Practices

1. **Use AWS Secrets Manager** for sensitive environment variables
2. **Enable AWS WAF** if using Application Load Balancer
3. **Restrict security group** to only necessary IPs/ports
4. **Regular updates**: Keep system and Node.js packages updated
5. **Enable CloudWatch alarms** for monitoring
6. **Use IAM roles** instead of access keys when possible
7. **Enable MongoDB authentication** if running MongoDB on EC2
8. **Set up automated backups** for MongoDB

## Backup Strategy

### MongoDB Backup

```bash
# Create backup script
cat > /opt/backup-mongodb.sh << 'EOF'
#!/bin/bash
BACKUP_DIR="/opt/backups/mongodb"
DATE=$(date +%Y%m%d_%H%M%S)
mkdir -p $BACKUP_DIR
mongodump --uri="your-mongodb-uri" --out="$BACKUP_DIR/backup_$DATE"
# Upload to S3
aws s3 sync $BACKUP_DIR s3://your-backup-bucket/mongodb/
EOF

chmod +x /opt/backup-mongodb.sh

# Add to crontab (daily at 2 AM)
(crontab -l 2>/dev/null; echo "0 2 * * * /opt/backup-mongodb.sh") | crontab -
```

## Support

For issues or questions, check:
- Application logs: `sudo journalctl -u vc-analyst -f`
- System logs: `sudo journalctl -xe`
- MongoDB logs: `sudo journalctl -u mongod -f`

