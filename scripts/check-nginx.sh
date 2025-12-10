#!/bin/bash

# Quick script to check Nginx installation status

echo "Checking Nginx installation..."

if command -v nginx &> /dev/null; then
    echo "✓ Nginx is installed"
    nginx -v
    echo ""
    echo "Nginx status:"
    sudo systemctl status nginx --no-pager | head -5
else
    echo "✗ Nginx is NOT installed"
    echo ""
    echo "To install Nginx, run:"
    echo "  sudo yum install -y nginx"
    echo ""
    echo "Or run the full setup script which will install it automatically:"
    echo "  sudo ./scripts/setup-nginx-ssl.sh"
fi

echo ""
echo "Checking for Nginx configuration files..."
if [ -d "/etc/nginx" ]; then
    echo "✓ Nginx config directory exists: /etc/nginx"
    echo ""
    echo "Configuration files:"
    ls -la /etc/nginx/conf.d/ 2>/dev/null || echo "  No conf.d directory"
else
    echo "✗ Nginx config directory not found"
    echo "  Nginx is likely not installed"
fi

