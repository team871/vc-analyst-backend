#!/bin/bash

# VC Analyst Backend - Nginx + SSL Setup Script
# This script sets up Nginx as a reverse proxy with SSL certificate

set -e

echo "========================================="
echo "VC Analyst Backend - Nginx + SSL Setup"
echo "========================================="

# Check if running as root or with sudo
if [ "$EUID" -ne 0 ]; then 
   echo "This script needs to be run with sudo"
   echo "Usage: sudo ./scripts/setup-nginx-ssl.sh"
   exit 1
fi

# Configuration
DOMAIN="${1:-}"
EMAIL="${2:-}"
APP_PORT="${APP_PORT:-5000}"

# Get domain name
if [ -z "$DOMAIN" ]; then
    echo ""
    echo "Enter your domain name (e.g., api.yourdomain.com):"
    read -r DOMAIN
fi

if [ -z "$DOMAIN" ]; then
    echo "Error: Domain name is required"
    exit 1
fi

# Get email for Let's Encrypt
if [ -z "$EMAIL" ]; then
    echo ""
    echo "Enter your email for Let's Encrypt certificate (optional but recommended):"
    read -r EMAIL
fi

# Install Nginx
echo ""
echo "Step 1: Installing Nginx..."
if ! command -v nginx &> /dev/null; then
    yum install -y nginx
else
    echo "Nginx is already installed"
fi

# Start and enable Nginx
systemctl enable nginx
systemctl start nginx

# Install Certbot
echo ""
echo "Step 2: Installing Certbot..."
if ! command -v certbot &> /dev/null; then
    yum install -y certbot python3-certbot-nginx
else
    echo "Certbot is already installed"
fi

# Create Nginx configuration (HTTP only first, Certbot will add SSL)
echo ""
echo "Step 3: Creating Nginx configuration..."
NGINX_CONF="/etc/nginx/conf.d/vc-analyst.conf"

cat > "$NGINX_CONF" <<EOF
# VC Analyst Backend - Nginx Configuration
# SSL will be added by Certbot automatically
upstream vc_analyst {
    server localhost:${APP_PORT};
    keepalive 64;
}

# HTTP server (will be upgraded to HTTPS by Certbot)
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    # For Let's Encrypt verification
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    # Logging
    access_log /var/log/nginx/vc-analyst-access.log;
    error_log /var/log/nginx/vc-analyst-error.log;

    # Client body size limit (for file uploads)
    client_max_body_size 50M;

    # WebSocket support for Socket.IO
    location /socket.io/ {
        proxy_pass http://vc_analyst;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        
        # WebSocket timeouts
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
    }

    # API endpoints
    location /api/ {
        proxy_pass http://vc_analyst;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        
        # Timeouts
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }

    # Health check endpoint (no logging)
    location /api/health {
        proxy_pass http://vc_analyst;
        access_log off;
    }

    # Root location
    location / {
        proxy_pass http://vc_analyst;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF

echo "Nginx configuration created at $NGINX_CONF"

# Create certbot directory
mkdir -p /var/www/certbot

# Test Nginx configuration
echo ""
echo "Step 4: Testing Nginx configuration..."
nginx -t

# Reload Nginx
systemctl reload nginx

# Obtain SSL certificate
echo ""
echo "Step 5: Obtaining SSL certificate from Let's Encrypt..."
if [ -n "$EMAIL" ]; then
    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --email "$EMAIL" --redirect
else
    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect
fi

# Set up auto-renewal
echo ""
echo "Step 6: Setting up SSL certificate auto-renewal..."
# Certbot automatically creates a cron job, but let's verify
systemctl enable certbot-renew.timer 2>/dev/null || true
systemctl start certbot-renew.timer 2>/dev/null || true

# Test certificate renewal (dry run)
echo ""
echo "Testing certificate renewal..."
certbot renew --dry-run

# Reload Nginx to apply SSL configuration
systemctl reload nginx

echo ""
echo "========================================="
echo "Nginx + SSL setup completed!"
echo "========================================="
echo ""
echo "Your backend is now accessible at:"
echo "  https://${DOMAIN}"
echo ""
echo "Next steps:"
echo "1. Update your DNS A record to point ${DOMAIN} to your EC2 instance IP"
echo "2. Update your .env file ALLOWED_ORIGINS to include https://${DOMAIN}"
echo "3. Test the API: curl https://${DOMAIN}/api/health"
echo ""
echo "Nginx commands:"
echo "  Status: sudo systemctl status nginx"
echo "  Restart: sudo systemctl restart nginx"
echo "  Reload: sudo systemctl reload nginx"
echo "  Logs: sudo tail -f /var/log/nginx/vc-analyst-error.log"
echo ""
echo "SSL certificate will auto-renew. Test renewal: sudo certbot renew --dry-run"

