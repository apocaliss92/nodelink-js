# Trusted Proxy Authentication (Nginx Proxy Manager + Authentik)

This guide explains how to run **nodelink.js Manager** behind **Authentik** (SSO) using **Nginx Proxy Manager (NPM)** and the app’s **Trusted Proxy Authentication** mode.

In this mode:

- Authentik authenticates the user.
- Nginx Proxy Manager (NGINX) performs `auth_request` against the Authentik outpost.
- NPM forwards identity headers (username + groups) to the app.
- The app **trusts** those headers **only** if the TCP peer IP is allowlisted.

## Security model (important)

- **Never expose the app directly to the Internet** when Trusted Proxy auth is enabled.
- The app will only accept trusted headers if the request comes from an allowlisted proxy IP.
- Ensure the app is reachable **only** from your reverse proxy (firewall / docker networks / private LAN).

## App configuration

1. Set the **only required environment variables** for auth:

- `AUTH_ENABLED=1`
- `ADMIN_PASSWORD=...`

2. Configure Trusted Proxy auth in the UI:

- Go to **Settings → Trusted proxy (Authentik / NPM)**
- Enable **Trusted proxy auth**
- Set **Allowed proxy IPs** (comma-separated)
- Ensure header names match your setup (defaults work for Authentik)
- Set **Admin group name** (e.g. `admin`)

Notes:

- If NGINX is in a different container, the allowlist must include the **NGINX container IP** on that docker network.
- Do not allow broad ranges (e.g. `0.0.0.0/0`).

## Authentik setup (UI)

The exact UI labels may vary slightly by Authentik version, but the flow is:

1. **Create a group** (optional, for admin users)
   - Directory → Groups → Create
   - Example: group name `admin`
   - Add your user to this group.

2. **Create a Proxy Provider**
   - Applications → Providers → Create
   - Choose **Proxy Provider**
   - Configure:
     - Authentication flow: your preferred flow (default is fine for most setups)
     - Authorization flow: optional (default is fine)
     - External host: `https://nodelink.example.com` (the public URL users will open)

3. **Create an Application and bind it to the provider**
   - Applications → Applications → Create
   - Select the provider created above
   - Set the application slug/name.

4. **Deploy / configure the Outpost**
   - Applications → Outposts
   - Use (or create) an outpost and add your proxy provider to it.
   - Deploy the outpost (Docker) and make it reachable by NGINX.

Auth headers:

- Authentik’s NGINX integration returns identity headers like:
  - `X-Authentik-Username`
  - `X-Authentik-Groups`
- NGINX reads them from `auth_request` upstream response as `upstream_http_x_authentik_username` and `upstream_http_x_authentik_groups`.

## Nginx Proxy Manager configuration

This setup assumes:

- Authentik outpost is available at `http://authentik-outpost:9000`.
- The app is available at `http://nodelink-manager:3000`.

### Proxy Host (UI)

In Nginx Proxy Manager:

1. Go to **Hosts → Proxy Hosts → Add Proxy Host**
2. Configure:
   - **Domain Names**: `nodelink.example.com`
   - **Scheme**: `http`
   - **Forward Hostname / IP**: `nodelink-manager`
   - **Forward Port**: `3000`
3. Enable:
   - **Websockets Support** ✅ (this is required for live logs / WebSocket endpoints)

If you serve the site over HTTPS, also configure an SSL certificate in the **SSL** tab and enable **Force SSL**.

### Advanced (Custom Nginx Configuration)

Paste the following into the Proxy Host **Advanced** tab.

Notes:

- NPM already creates the upstream proxying; we override `location /` to inject `auth_request` and forward Authentik headers.
- If you already have custom locations in NPM, merge carefully.

```nginx
# Authentik integration (auth_request)
location = /outpost.goauthentik.io/auth/nginx {
  internal;
  proxy_pass http://authentik-outpost:9000/outpost.goauthentik.io/auth/nginx;
  proxy_pass_request_body off;
  proxy_set_header Content-Length "";
  proxy_set_header X-Original-URL $scheme://$http_host$request_uri;
  proxy_set_header X-Original-Method $request_method;
  proxy_set_header X-Original-Host $http_host;
}

location / {
  auth_request /outpost.goauthentik.io/auth/nginx;
  error_page 401 = @ak_unauthorized;

  # Pull identity from Authentik response
  auth_request_set $ak_username $upstream_http_x_authentik_username;
  auth_request_set $ak_groups   $upstream_http_x_authentik_groups;

  # Forward identity headers to the app
  proxy_set_header X-Authentik-Username $ak_username;
  proxy_set_header X-Authentik-Groups $ak_groups;

  # Standard proxy headers
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;

  # WebSockets are handled by NPM when "Websockets Support" is enabled.
  # If you disabled it, you must add Upgrade/Connection headers here.

  proxy_pass http://nodelink-manager:3000;
}

location @ak_unauthorized {
  return 302 /outpost.goauthentik.io/start?rd=$scheme://$http_host$request_uri;
}
```

### WebSocket support (NPM)

In Nginx Proxy Manager you do **not** need to manually add `Upgrade` / `Connection` headers in most setups.

- Just enable **Websockets Support** on the Proxy Host.
- If your site is served over HTTPS, browsers require `wss://` (not `ws://`).

If you override NPM’s proxying heavily in the **Advanced** config, make sure you didn’t remove WebSocket headers or the Websockets Support toggle.

## Appendix: raw NGINX (without NPM)

If you are not using Nginx Proxy Manager, you must manually enable WebSocket proxying (Upgrade headers, HTTP/1.1, timeouts). In NPM this is typically handled by the **Websockets Support** toggle.

## Troubleshooting

- **The app still shows its own login form**
  - Confirm `AUTH_ENABLED=1` is set.
  - Confirm **Settings → Trusted proxy** is enabled.
  - Confirm NGINX is forwarding the headers and they match the header names configured in Settings.

- **Trusted headers are ignored**
  - The allowlist likely doesn’t include the real TCP peer IP seen by the app.
  - If using Docker, check the NGINX container IP on the shared network.

- **Admin role not applied**
  - Confirm the `X-Authentik-Groups` header contains the group name you configured as **Admin group name**.
  - Ensure your user is a member of that Authentik group.
