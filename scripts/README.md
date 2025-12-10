# VC Analyst Backend - Deployment Scripts

This directory contains scripts for deploying the VC Analyst backend to AWS EC2.

## Scripts Overview

### `setup-ec2.sh`
Initial setup script that installs all required dependencies on a fresh EC2 instance.
- Installs Node.js 18.x
- Installs Git, PM2, and build tools
- Configures firewall rules
- Creates application directory

**Usage:**
```bash
chmod +x scripts/setup-ec2.sh
./scripts/setup-ec2.sh
```

### `deploy.sh`
Deployment script that installs and starts the application.
- Copies application files to `/opt/vc-analyst`
- Installs npm dependencies
- Sets up systemd service
- Starts the application

**Usage:**
```bash
chmod +x scripts/deploy.sh
./scripts/deploy.sh
```

### `quick-deploy.sh`
Combined script that runs both setup and deployment in one go.
Perfect for fresh EC2 instances.

**Usage:**
```bash
chmod +x scripts/quick-deploy.sh
./scripts/quick-deploy.sh
```

### `health-check.sh`
Health check script to verify the deployment is working correctly.
- Checks service status
- Tests health endpoint
- Verifies environment variables
- Checks system resources

**Usage:**
```bash
chmod +x scripts/health-check.sh
./scripts/health-check.sh
```

### `user-data.sh`
EC2 User Data script for automatic setup on instance launch.
Can be used in EC2 Launch Configuration or Instance User Data.

**Note:** This only sets up the environment. Application code must be deployed separately.

### `vc-analyst.service`
Systemd service file for running the application as a system service.
Automatically installed by `deploy.sh`.

## Quick Start Guide

### Option 1: Fresh EC2 Instance (Recommended)

1. **SSH into your EC2 instance:**
   ```bash
   ssh -i your-key.pem ec2-user@your-ec2-ip
   ```

2. **Clone or upload your repository:**
   ```bash
   # Option A: Clone from Git
   cd /opt
   sudo git clone https://github.com/your-username/vc-analyst.git
   sudo chown -R ec2-user:ec2-user vc-analyst
   cd vc-analyst
   
   # Option B: Upload via SCP (from your local machine)
   # scp -i your-key.pem -r . ec2-user@your-ec2-ip:/opt/vc-analyst
   ```

3. **Create `.env` file:**
   ```bash
   cd /opt/vc-analyst
   nano .env
   # Add your environment variables (see DEPLOYMENT_GUIDE.md)
   ```

4. **Run quick deploy:**
   ```bash
   chmod +x scripts/quick-deploy.sh
   ./scripts/quick-deploy.sh
   ```

### Option 2: Step-by-Step Deployment

1. **Run setup:**
   ```bash
   ./scripts/setup-ec2.sh
   ```

2. **Configure environment:**
   ```bash
   nano .env
   ```

3. **Deploy application:**
   ```bash
   ./scripts/deploy.sh
   ```

4. **Verify deployment:**
   ```bash
   ./scripts/health-check.sh
   ```

## Environment Variables

Create a `.env` file in the project root with the following variables:

```env
NODE_ENV=production
PORT=5000
MONGODB_URI=mongodb://localhost:27017/vc-analyst
JWT_SECRET=your-secret-key
ENCRYPTION_KEY=your-encryption-key
AWS_ACCESS_KEY_ID=your-aws-key
AWS_SECRET_ACCESS_KEY=your-aws-secret
AWS_REGION=us-east-1
S3_BUCKET_NAME=your-bucket
PERPLEXITY_API_KEY=your-key
OPENAI_API_KEY=your-key
```

See `DEPLOYMENT_GUIDE.md` for detailed instructions.

## Service Management

After deployment, manage the service using systemd:

```bash
# Check status
sudo systemctl status vc-analyst

# Start service
sudo systemctl start vc-analyst

# Stop service
sudo systemctl stop vc-analyst

# Restart service
sudo systemctl restart vc-analyst

# View logs
sudo journalctl -u vc-analyst -f

# View recent logs
sudo journalctl -u vc-analyst -n 100
```

## Troubleshooting

### Service won't start
1. Check logs: `sudo journalctl -u vc-analyst -n 50`
2. Verify `.env` file exists and has correct values
3. Check MongoDB connection
4. Verify file permissions: `ls -la /opt/vc-analyst`

### Port already in use
```bash
sudo lsof -i :5000
sudo kill -9 <PID>
```

### Permission issues
```bash
sudo chown -R ec2-user:ec2-user /opt/vc-analyst
chmod +x /opt/vc-analyst/server.js
```

## Updating the Application

When you need to update:

```bash
cd /opt/vc-analyst
git pull origin main  # or upload new files
./scripts/deploy.sh
```

## Security Notes

- Never commit `.env` file to version control
- Use strong, random values for `JWT_SECRET` and `ENCRYPTION_KEY`
- Consider using AWS Secrets Manager for production
- Restrict EC2 security group to necessary IPs/ports only
- Enable MongoDB authentication if running MongoDB on EC2

## Additional Resources

- See `DEPLOYMENT_GUIDE.md` for comprehensive deployment instructions
- Check application logs: `sudo journalctl -u vc-analyst -f`
- Test health endpoint: `curl http://localhost:5000/api/health`

