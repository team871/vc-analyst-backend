#!/bin/bash

# Health Check Script for VC Analyst Backend
# Use this script to verify the deployment is working correctly

set -e

PORT=${PORT:-5000}
BASE_URL="http://localhost:${PORT}"

echo "========================================="
echo "VC Analyst Backend - Health Check"
echo "========================================="
echo ""

# Check if service is running
echo "1. Checking systemd service status..."
if systemctl is-active --quiet vc-analyst; then
    echo "   ✓ Service is running"
else
    echo "   ✗ Service is not running"
    echo "   Run: sudo systemctl status vc-analyst"
    exit 1
fi

# Check if port is listening
echo ""
echo "2. Checking if port ${PORT} is listening..."
if netstat -tuln | grep -q ":${PORT} "; then
    echo "   ✓ Port ${PORT} is listening"
else
    echo "   ✗ Port ${PORT} is not listening"
    exit 1
fi

# Check health endpoint
echo ""
echo "3. Checking health endpoint..."
HEALTH_RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/api/health" || echo "000")
if [ "$HEALTH_RESPONSE" = "200" ]; then
    echo "   ✓ Health endpoint returned 200 OK"
    HEALTH_BODY=$(curl -s "${BASE_URL}/api/health")
    echo "   Response: $HEALTH_BODY"
else
    echo "   ✗ Health endpoint returned $HEALTH_RESPONSE"
    exit 1
fi

# Check MongoDB connection (if mongosh is available)
echo ""
echo "4. Checking MongoDB connection..."
if command -v mongosh &> /dev/null; then
    if mongosh --eval "db.adminCommand('ping')" --quiet &> /dev/null; then
        echo "   ✓ MongoDB is accessible"
    else
        echo "   ⚠ MongoDB connection check failed (may be using external MongoDB)"
    fi
else
    echo "   ⚠ mongosh not installed, skipping MongoDB check"
fi

# Check environment variables
echo ""
echo "5. Checking critical environment variables..."
if [ -f "/opt/vc-analyst/.env" ]; then
    source /opt/vc-analyst/.env
    
    MISSING_VARS=()
    
    [ -z "$MONGODB_URI" ] && MISSING_VARS+=("MONGODB_URI")
    [ -z "$JWT_SECRET" ] && MISSING_VARS+=("JWT_SECRET")
    [ -z "$ENCRYPTION_KEY" ] && MISSING_VARS+=("ENCRYPTION_KEY")
    [ -z "$AWS_ACCESS_KEY_ID" ] && MISSING_VARS+=("AWS_ACCESS_KEY_ID")
    [ -z "$AWS_SECRET_ACCESS_KEY" ] && MISSING_VARS+=("AWS_SECRET_ACCESS_KEY")
    [ -z "$S3_BUCKET_NAME" ] && MISSING_VARS+=("S3_BUCKET_NAME")
    [ -z "$PERPLEXITY_API_KEY" ] && MISSING_VARS+=("PERPLEXITY_API_KEY")
    [ -z "$OPENAI_API_KEY" ] && MISSING_VARS+=("OPENAI_API_KEY")
    
    if [ ${#MISSING_VARS[@]} -eq 0 ]; then
        echo "   ✓ All critical environment variables are set"
    else
        echo "   ✗ Missing environment variables:"
        for var in "${MISSING_VARS[@]}"; do
            echo "     - $var"
        done
    fi
else
    echo "   ✗ .env file not found at /opt/vc-analyst/.env"
fi

# Check disk space
echo ""
echo "6. Checking disk space..."
DISK_USAGE=$(df -h /opt | tail -1 | awk '{print $5}' | sed 's/%//')
if [ "$DISK_USAGE" -lt 80 ]; then
    echo "   ✓ Disk usage: ${DISK_USAGE}% (OK)"
else
    echo "   ⚠ Disk usage: ${DISK_USAGE}% (Consider cleaning up)"
fi

# Check memory
echo ""
echo "7. Checking memory..."
MEMORY_USAGE=$(free | grep Mem | awk '{printf "%.0f", $3/$2 * 100}')
echo "   Memory usage: ${MEMORY_USAGE}%"

echo ""
echo "========================================="
echo "Health check completed!"
echo "========================================="

