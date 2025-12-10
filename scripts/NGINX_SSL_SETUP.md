# Nginx + SSL Setup Guide

This guide will help you set up Nginx as a reverse proxy with SSL certificate for your VC Analyst backend.

## Prerequisites

1. **Domain name** pointing to your EC2 instance's public IP
2. **EC2 Security Group** configured to allow:
   - Port 80 (HTTP) - for Let's Encrypt verification
   - Port 443 (HTTPS) - for secure connections
3. **DNS A record** configured (can be done after setup, but needed for SSL)

## Quick Setup

### Option 1: Automated Script (Recommended)

```bash
# Run the setup script
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

### Option 2: Manual Setup

Follow the steps below if you prefer manual setup.

## Manual Setup Steps

### Step 1: Install Nginx

```bash
sudo yum install -y nginx
sudo systemctl enable nginx
sudo systemctl start nginx
```

### Step 2: Configure DNS

Point your domain to your EC2 instance's public IP:

```
Type: A
Name: api (or @ for root domain)
Value: YOUR_EC2_PUBLIC_IP
TTL: 300
```

Wait for DNS propagation (can take a few minutes to hours).

### Step 3: Create Nginx Configuration

Create `/etc/nginx/conf.d/vc-analyst.conf`:

```nginx
upstream vc_analyst {
    server localhost:5000;
    keepalive 64;
}

# HTTP server - redirect to HTTPS
server {
    listen 80;
    server_name api.yourdomain.com;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://$server_name$request_uri;
    }
}

# HTTPS server
server {
    listen 443 ssl http2;
    server_name api.yourdomain.com;

    # SSL certificates (will be added by Certbot)
    ssl_certificate /etc/letsencrypt/live/api.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.yourdomain.com/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    # Security headers
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;

    # Logging
    access_log /var/log/nginx/vc-analyst-access.log;
    error_log /var/log/nginx/vc-analyst-error.log;

    # File upload size limit
    client_max_body_size 50M;

    # WebSocket support
    location /socket.io/ {
        proxy_pass http://vc_analyst;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }

    # API endpoints
    location /api/ {
        proxy_pass http://vc_analyst;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Health check
    location /api/health {
        proxy_pass http://vc_analyst;
        access_log off;
    }
}
```

Replace `api.yourdomain.com` with your actual domain.

### Step 4: Test Nginx Configuration

```bash
sudo nginx -t
```

If successful, reload Nginx:

```bash
sudo systemctl reload nginx
```

### Step 5: Install Certbot

```bash
sudo yum install -y certbot python3-certbot-nginx
```

### Step 6: Obtain SSL Certificate

```bash
# With email (recommended)
sudo certbot --nginx -d api.yourdomain.com --email your-email@example.com

# Without email
sudo certbot --nginx -d api.yourdomain.com --register-unsafely-without-email
```

Certbot will:
- Verify domain ownership
- Obtain SSL certificate
- Update Nginx configuration automatically
- Set up auto-renewal

### Step 7: Verify SSL Certificate

```bash
# Test your API
curl https://api.yourdomain.com/api/health

# Check certificate
sudo certbot certificates
```

### Step 8: Update Environment Variables

Update your `.env` file to include your domain in `ALLOWED_ORIGINS`:

```env
ALLOWED_ORIGINS=https://api.yourdomain.com,https://yourdomain.com
```

Restart your backend service:

```bash
sudo systemctl restart vc-analyst
```

## SSL Certificate Auto-Renewal

Certbot automatically sets up renewal. Certificates expire every 90 days and auto-renew 30 days before expiration.

### Test Auto-Renewal

```bash
sudo certbot renew --dry-run
```

### Manual Renewal (if needed)

```bash
sudo certbot renew
sudo systemctl reload nginx
```

## Nginx Management

### Check Status
```bash
sudo systemctl status nginx
```

### Restart Nginx
```bash
sudo systemctl restart nginx
```

### Reload Configuration (without downtime)
```bash
sudo systemctl reload nginx
```

### View Logs
```bash
# Error logs
sudo tail -f /var/log/nginx/vc-analyst-error.log

# Access logs
sudo tail -f /var/log/nginx/vc-analyst-access.log

# All Nginx logs
sudo tail -f /var/log/nginx/error.log
```

### Test Configuration
```bash
sudo nginx -t
```

## Troubleshooting

### SSL Certificate Failed

**Error: "Failed to obtain certificate"**

1. **Check DNS**: Ensure your domain points to EC2 IP
   ```bash
   dig api.yourdomain.com
   nslookup api.yourdomain.com
   ```

2. **Check Port 80**: Ensure port 80 is open in security group
   ```bash
   curl http://api.yourdomain.com
   ```

3. **Check Nginx**: Ensure Nginx is running
   ```bash
   sudo systemctl status nginx
   ```

4. **Check firewall**: Ensure firewall allows port 80
   ```bash
   sudo firewall-cmd --list-ports
   ```

### 502 Bad Gateway

**Error: "502 Bad Gateway"**

1. **Check backend service**:
   ```bash
   sudo systemctl status vc-analyst
   curl http://localhost:5000/api/health
   ```

2. **Check Nginx error logs**:
   ```bash
   sudo tail -f /var/log/nginx/vc-analyst-error.log
   ```

3. **Verify upstream** in Nginx config points to correct port

### WebSocket Connection Failed

1. **Check Nginx config** has WebSocket location block (`/socket.io/`)
2. **Verify backend** is running on correct port
3. **Check CORS** settings in backend `.env` file

### Certificate Expired

```bash
# Renew certificate
sudo certbot renew

# Reload Nginx
sudo systemctl reload nginx
```

## Security Best Practices

1. **Use HTTPS only**: HTTP automatically redirects to HTTPS
2. **Security headers**: Already configured in Nginx config
3. **Keep certificates updated**: Auto-renewal is set up
4. **Restrict access**: Use security groups to limit access
5. **Regular updates**: Keep Nginx and Certbot updated
   ```bash
   sudo yum update nginx certbot
   ```

## Multiple Domains

To add multiple domains:

```bash
sudo certbot --nginx -d api1.yourdomain.com -d api2.yourdomain.com
```

Or add them to the same Nginx server block:

```nginx
server {
    listen 443 ssl http2;
    server_name api1.yourdomain.com api2.yourdomain.com;
    # ... rest of config
}
```

## Performance Tuning

### Increase Worker Connections

Edit `/etc/nginx/nginx.conf`:

```nginx
worker_processes auto;
worker_connections 1024;
```

### Enable Gzip Compression

Add to your server block:

```nginx
gzip on;
gzip_vary on;
gzip_min_length 1024;
gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript;
```

## Monitoring

### Set up Log Rotation

Nginx logs are automatically rotated. Check configuration:

```bash
cat /etc/logrotate.d/nginx
```

### Monitor Certificate Expiry

```bash
# Check certificate expiry
echo | openssl s_client -servername api.yourdomain.com -connect api.yourdomain.com:443 2>/dev/null | openssl x509 -noout -dates
```

## Support

For issues:
- Check Nginx logs: `sudo tail -f /var/log/nginx/vc-analyst-error.log`
- Check backend logs: `sudo journalctl -u vc-analyst -f`
- Test backend directly: `curl http://localhost:5000/api/health`
- Test through Nginx: `curl https://api.yourdomain.com/api/health`

