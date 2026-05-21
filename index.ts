import { resolve } from "dns/promises";
import crypto from "crypto";

function generateVerificationToken(): string {
  return "link-redirect-verify=" + crypto.randomBytes(24).toString("hex");
}

async function verifyDomainOwnership(
  domainName: string,
  token: string
): Promise<boolean> {
  try {
    const records = await resolve(domainName, "TXT");
    for (const record of records) {
      const full = record.join("");
      if (full === token) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

async function initDB() {
  const dbUrl = Bun.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL not set");
    return;
  }

  const sql = Bun.sql;

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS domains (
        id SERIAL PRIMARY KEY,
        domain_name VARCHAR(255) NOT NULL UNIQUE,
        verification_token VARCHAR(255) NOT NULL,
        is_verified BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS links (
        id SERIAL PRIMARY KEY,
        domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
        order_num INTEGER NOT NULL,
        target_url VARCHAR(2048) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(domain_id, order_num),
        UNIQUE(domain_id, target_url)
      )
    `;

    console.log("Database initialized successfully");
  } catch (error) {
    console.error("Database initialization error:", error);
  }
}

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;
  const sql = Bun.sql;

  try {
    // Serve admin UI
    if ((path === "/" || path === "/admin") && method === "GET") {
      return new Response(getAdminHTML(), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // POST /api/domains/register — step 1: register domain and get verification token
    if (path === "/api/domains/register" && method === "POST") {
      const body = (await req.json()) as { domain_name?: string };
      const domainName = body.domain_name?.trim().toLowerCase();

      if (!domainName) {
        return jsonResponse({ error: "domain_name is required" }, 400);
      }

      const token = generateVerificationToken();

      const result = await sql`
        INSERT INTO domains (domain_name, verification_token, is_verified)
        VALUES (${domainName}, ${token}, FALSE)
        ON CONFLICT (domain_name) DO UPDATE
          SET verification_token = ${token}, is_verified = FALSE
        RETURNING id, domain_name, verification_token, is_verified, created_at
      `;

      return jsonResponse(result[0], 201);
    }

    // POST /api/domains/verify — step 2: verify domain via DNS TXT record
    if (path === "/api/domains/verify" && method === "POST") {
      const body = (await req.json()) as { domain_name?: string };
      const domainName = body.domain_name?.trim().toLowerCase();

      if (!domainName) {
        return jsonResponse({ error: "domain_name is required" }, 400);
      }

      const rows = await sql`
        SELECT id, domain_name, verification_token, is_verified
        FROM domains
        WHERE domain_name = ${domainName}
      `;

      if (!rows[0]) {
        return jsonResponse({ error: "Domain not registered" }, 404);
      }

      const domain = rows[0];

      if (domain.is_verified) {
        return jsonResponse({ success: true, message: "Domain already verified" });
      }

      const verified = await verifyDomainOwnership(domainName, domain.verification_token);

      if (!verified) {
        return jsonResponse(
          {
            error: "DNS TXT record not found",
            hint: `Add a TXT record to ${domainName} with value: ${domain.verification_token}`,
          },
          400
        );
      }

      await sql`
        UPDATE domains SET is_verified = TRUE WHERE id = ${domain.id}
      `;

      return jsonResponse({ success: true, message: "Domain verified successfully" });
    }

    // GET /api/domains — list all verified domains
    if (path === "/api/domains" && method === "GET") {
      const domains = await sql`
        SELECT
          d.id,
          d.domain_name,
          d.is_verified,
          d.verification_token,
          d.created_at,
          COUNT(l.id)::int AS link_count
        FROM domains d
        LEFT JOIN links l ON l.domain_id = d.id
        GROUP BY d.id
        ORDER BY d.created_at DESC
      `;
      return jsonResponse(domains);
    }

    // DELETE /api/domains/:id
    const domainDeleteMatch = path.match(/^\/api\/domains\/(\d+)$/);
    if (domainDeleteMatch && method === "DELETE") {
      const domainId = Number(domainDeleteMatch[1]);
      const result = await sql`
        DELETE FROM domains WHERE id = ${domainId} RETURNING id
      `;
      if (!result[0]) {
        return jsonResponse({ error: "Domain not found" }, 404);
      }
      return jsonResponse({ success: true });
    }

    // GET /api/domains/:id/links — list links for a domain (must be verified)
    const domainLinksMatch = path.match(/^\/api\/domains\/(\d+)\/links$/);
    if (domainLinksMatch && method === "GET") {
      const domainId = Number(domainLinksMatch[1]);

      const domainRows = await sql`
        SELECT id, is_verified FROM domains WHERE id = ${domainId}
      `;
      if (!domainRows[0]) {
        return jsonResponse({ error: "Domain not found" }, 404);
      }
      if (!domainRows[0].is_verified) {
        return jsonResponse({ error: "Domain is not verified" }, 403);
      }

      const links = await sql`
        SELECT id, domain_id, order_num, target_url, created_at
        FROM links
        WHERE domain_id = ${domainId}
        ORDER BY order_num ASC, created_at ASC
      `;
      return jsonResponse(links);
    }

    // POST /api/domains/:id/links — add a link (domain must be verified)
    if (domainLinksMatch && method === "POST") {
      const domainId = Number(domainLinksMatch[1]);

      const domainRows = await sql`
        SELECT id, is_verified FROM domains WHERE id = ${domainId}
      `;
      if (!domainRows[0]) {
        return jsonResponse({ error: "Domain not found" }, 404);
      }
      if (!domainRows[0].is_verified) {
        return jsonResponse({ error: "Domain must be verified before adding links" }, 403);
      }

      const body = (await req.json()) as { order_num?: number; target_url?: string };
      const orderNum = Number(body.order_num);
      const targetUrl = body.target_url?.trim();

      if (!orderNum || !targetUrl) {
        return jsonResponse({ error: "order_num and target_url are required" }, 400);
      }

      try {
        const result = await sql`
          INSERT INTO links (domain_id, order_num, target_url)
          VALUES (${domainId}, ${orderNum}, ${targetUrl})
          RETURNING *
        `;
        return jsonResponse(result[0], 201);
      } catch (error) {
        console.error("Create link error:", error);
        return jsonResponse({ error: "Failed to create link. Check uniqueness constraints." }, 400);
      }
    }

    // DELETE /api/links/:id
    const linkDeleteMatch = path.match(/^\/api\/links\/(\d+)$/);
    if (linkDeleteMatch && method === "DELETE") {
      const linkId = Number(linkDeleteMatch[1]);
      const result = await sql`
        DELETE FROM links WHERE id = ${linkId} RETURNING id
      `;
      if (!result[0]) {
        return jsonResponse({ error: "Link not found" }, 404);
      }
      return jsonResponse({ success: true });
    }

    // GET /r/:domain — redirect endpoint
    const redirectMatch = path.match(/^\/r\/(.+)$/);
    if (redirectMatch && method === "GET") {
      const domainName = decodeURIComponent(redirectMatch[1]).trim().toLowerCase();

      const domainRows = await sql`
        SELECT id, domain_name, is_verified FROM domains WHERE domain_name = ${domainName}
      `;

      if (!domainRows[0] || !domainRows[0].is_verified) {
        return jsonResponse({ error: "Domain not found or not verified" }, 404);
      }

      const domain = domainRows[0];
      const links = await sql`
        SELECT id, target_url, order_num FROM links
        WHERE domain_id = ${domain.id}
        ORDER BY order_num ASC
      `;

      if (!links.length) {
        return jsonResponse({ error: "No links configured for this domain" }, 404);
      }

      const target = links[Math.floor(Math.random() * links.length)];
      return Response.redirect(target.target_url, 302);
    }

    return jsonResponse({ error: "Not found" }, 404);
  } catch (error) {
    console.error("Request error:", error);
    return jsonResponse({ error: "Internal server error" }, 500);
  }
}

function getAdminHTML(): string {
  return String.raw`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Link Redirect Manager</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      font-family: "Inter", "Segoe UI", system-ui, sans-serif;
      background: #f0f4f8;
      color: #1a202c;
    }

    .shell {
      max-width: 960px;
      margin: 0 auto;
      padding: 40px 20px 80px;
    }

    h1 {
      font-size: 28px;
      font-weight: 700;
      margin: 0 0 4px;
      letter-spacing: -0.02em;
    }

    .subtitle {
      color: #718096;
      margin: 0 0 32px;
      font-size: 15px;
    }

    .card {
      background: #fff;
      border: 1px solid #e2e8f0;
      border-radius: 16px;
      padding: 24px;
      margin-bottom: 20px;
      box-shadow: 0 1px 4px rgba(0,0,0,0.06);
    }

    .card h2 {
      margin: 0 0 6px;
      font-size: 17px;
      font-weight: 700;
    }

    .card .desc {
      color: #718096;
      font-size: 14px;
      margin: 0 0 18px;
    }

    .row {
      display: flex;
      gap: 10px;
      align-items: flex-start;
      flex-wrap: wrap;
    }

    input[type="text"], input[type="url"], input[type="number"] {
      flex: 1;
      min-width: 180px;
      padding: 10px 14px;
      border: 1px solid #cbd5e0;
      border-radius: 10px;
      font: inherit;
      font-size: 14px;
      background: #f7fafc;
      color: #1a202c;
      outline: none;
      transition: border-color 0.15s;
    }

    input:focus {
      border-color: #4299e1;
      background: #fff;
    }

    button {
      padding: 10px 18px;
      border: none;
      border-radius: 10px;
      font: inherit;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.15s, transform 0.1s;
      white-space: nowrap;
    }

    button:hover { opacity: 0.88; transform: translateY(-1px); }
    button:active { transform: translateY(0); }

    .btn-primary { background: #3182ce; color: #fff; }
    .btn-success { background: #38a169; color: #fff; }
    .btn-danger  { background: #e53e3e; color: #fff; }
    .btn-ghost   { background: #edf2f7; color: #4a5568; }

    .msg {
      margin-top: 10px;
      font-size: 13px;
      font-weight: 600;
      min-height: 18px;
    }
    .msg.ok  { color: #276749; }
    .msg.err { color: #c53030; }

    .token-box {
      margin-top: 14px;
      padding: 14px 16px;
      background: #ebf8ff;
      border: 1px solid #bee3f8;
      border-radius: 10px;
      font-size: 13px;
      line-height: 1.6;
    }

    .token-box code {
      display: block;
      margin-top: 6px;
      font-family: "Fira Mono", "Consolas", monospace;
      font-size: 13px;
      word-break: break-all;
      background: #fff;
      border: 1px solid #bee3f8;
      border-radius: 6px;
      padding: 8px 10px;
      color: #2b6cb0;
    }

    .domain-list {
      display: grid;
      gap: 12px;
      margin-top: 4px;
    }

    .domain-item {
      border: 1px solid #e2e8f0;
      border-radius: 12px;
      padding: 14px 16px;
      background: #f7fafc;
    }

    .domain-item.verified {
      border-color: #9ae6b4;
      background: #f0fff4;
    }

    .domain-item.unverified {
      border-color: #fbd38d;
      background: #fffaf0;
    }

    .domain-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }

    .domain-name {
      font-weight: 700;
      font-size: 15px;
    }

    .badge {
      display: inline-block;
      padding: 2px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
    }

    .badge.verified   { background: #c6f6d5; color: #22543d; }
    .badge.unverified { background: #feebc8; color: #7b341e; }

    .domain-meta {
      font-size: 13px;
      color: #718096;
      margin-top: 4px;
    }

    .domain-actions {
      display: flex;
      gap: 8px;
      margin-top: 10px;
      flex-wrap: wrap;
    }

    .links-section {
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid #e2e8f0;
    }

    .links-section h4 {
      margin: 0 0 10px;
      font-size: 13px;
      color: #4a5568;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }

    .link-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      padding: 8px 10px;
      background: #fff;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      margin-bottom: 6px;
      font-size: 13px;
    }

    .link-url {
      font-family: "Fira Mono", monospace;
      font-size: 12px;
      color: #2d3748;
      word-break: break-all;
    }

    .link-order {
      font-weight: 700;
      color: #4a5568;
      white-space: nowrap;
    }

    .add-link-form {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 8px;
    }

    .add-link-form input[type="number"] {
      max-width: 90px;
      flex: none;
    }

    .empty {
      color: #a0aec0;
      font-size: 13px;
      padding: 8px 0;
    }

    .verify-hint {
      margin-top: 10px;
      padding: 12px 14px;
      background: #fffaf0;
      border: 1px solid #fbd38d;
      border-radius: 10px;
      font-size: 13px;
      line-height: 1.6;
      color: #744210;
    }

    .verify-hint code {
      font-family: "Fira Mono", monospace;
      background: #fff;
      border: 1px solid #fbd38d;
      border-radius: 4px;
      padding: 2px 6px;
      font-size: 12px;
      word-break: break-all;
    }
  </style>
</head>
<body>
  <main class="shell">
    <h1>Link Redirect Manager</h1>
    <p class="subtitle">Register domains, verify ownership via DNS TXT record, then manage redirect links.</p>

    <!-- Step 1: Register domain -->
    <div class="card">
      <h2>Step 1 — Register a domain</h2>
      <p class="desc">Enter your domain name to generate a DNS verification token.</p>
      <div class="row">
        <input type="text" id="reg-domain" placeholder="example.com">
        <button class="btn-primary" id="reg-btn">Register</button>
      </div>
      <div id="reg-msg" class="msg"></div>
      <div id="token-display" style="display:none" class="token-box">
        <strong>Add this TXT record to your DNS:</strong>
        <code id="token-value"></code>
        <div style="margin-top:8px;color:#2b6cb0;font-size:13px;">
          Once the record propagates, click <strong>Verify</strong> next to your domain below.
        </div>
      </div>
    </div>

    <!-- Domain list -->
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <h2 style="margin:0;">Your Domains</h2>
        <button class="btn-ghost" id="refresh-btn">Refresh</button>
      </div>
      <div id="domain-list" class="domain-list">
        <div class="empty">Loading…</div>
      </div>
    </div>
  </main>

  <script>
    const $ = (id) => document.getElementById(id);

    function msg(id, text, type) {
      const el = $(id);
      el.textContent = text;
      el.className = 'msg ' + (type || '');
    }

    function esc(s) {
      return String(s)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;')
        .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    async function api(path, opts) {
      const res = await fetch(path, {
        headers: { 'Content-Type': 'application/json', ...(opts && opts.headers || {}) },
        ...opts
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Request failed');
      return data;
    }

    // Register domain
    $('reg-btn').addEventListener('click', async () => {
      const domainName = $('reg-domain').value.trim();
      if (!domainName) { msg('reg-msg', 'Enter a domain name.', 'err'); return; }
      try {
        const d = await api('/api/domains/register', {
          method: 'POST',
          body: JSON.stringify({ domain_name: domainName })
        });
        $('token-value').textContent = d.verification_token;
        $('token-display').style.display = 'block';
        msg('reg-msg', 'Domain registered. Add the TXT record shown below, then verify.', 'ok');
        $('reg-domain').value = '';
        await loadDomains();
      } catch (e) {
        msg('reg-msg', e.message, 'err');
      }
    });

    $('refresh-btn').addEventListener('click', () => loadDomains());

    async function loadDomains() {
      const wrap = $('domain-list');
      try {
        const domains = await api('/api/domains');
        if (!domains.length) {
          wrap.innerHTML = '<div class="empty">No domains yet. Register one above.</div>';
          return;
        }
        wrap.innerHTML = domains.map(renderDomain).join('');
        attachDomainEvents();
      } catch (e) {
        wrap.innerHTML = '<div class="empty" style="color:#c53030">' + esc(e.message) + '</div>';
      }
    }

    function renderDomain(d) {
      const cls = d.is_verified ? 'verified' : 'unverified';
      const badge = d.is_verified
        ? '<span class="badge verified">Verified</span>'
        : '<span class="badge unverified">Pending</span>';

      const verifyHint = !d.is_verified ? `
        <div class="verify-hint">
          Add a DNS TXT record to <strong>${esc(d.domain_name)}</strong> with value:<br>
          <code>${esc(d.verification_token)}</code>
        </div>` : '';

      const linksSection = d.is_verified ? `
        <div class="links-section">
          <h4>Links</h4>
          <div id="links-${d.id}" class="links-container">
            <div class="empty">Loading links…</div>
          </div>
          <div class="add-link-form">
            <input type="number" min="1" placeholder="#" id="order-${d.id}" title="Order number">
            <input type="url" placeholder="https://target.example/path" id="url-${d.id}" style="flex:1;min-width:200px;">
            <button class="btn-success" data-add-link="${d.id}">Add Link</button>
          </div>
          <div id="link-msg-${d.id}" class="msg"></div>
        </div>` : '';

      const verifyBtn = !d.is_verified
        ? `<button class="btn-success" data-verify="${d.id}" data-domain="${esc(d.domain_name)}">Verify</button>`
        : '';

      return `
        <div class="domain-item ${cls}" id="domain-item-${d.id}">
          <div class="domain-header">
            <span class="domain-name">${esc(d.domain_name)}</span>
            ${badge}
          </div>
          <div class="domain-meta">${d.link_count} link${d.link_count !== 1 ? 's' : ''} · Redirect: <code>/r/${esc(d.domain_name)}</code></div>
          ${verifyHint}
          <div class="domain-actions">
            ${verifyBtn}
            <button class="btn-danger" data-delete="${d.id}">Delete</button>
          </div>
          ${linksSection}
        </div>`;
    }

    function attachDomainEvents() {
      // Verify buttons
      document.querySelectorAll('[data-verify]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const domainName = btn.getAttribute('data-domain');
          try {
            const res = await api('/api/domains/verify', {
              method: 'POST',
              body: JSON.stringify({ domain_name: domainName })
            });
            await loadDomains();
          } catch (e) {
            alert('Verification failed: ' + e.message);
          }
        });
      });

      // Delete buttons
      document.querySelectorAll('[data-delete]').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Delete this domain and all its links?')) return;
          try {
            await api('/api/domains/' + btn.getAttribute('data-delete'), { method: 'DELETE' });
            await loadDomains();
          } catch (e) {
            alert('Delete failed: ' + e.message);
          }
        });
      });

      // Add link buttons
      document.querySelectorAll('[data-add-link]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const domainId = btn.getAttribute('data-add-link');
          const orderNum = Number($('order-' + domainId).value);
          const targetUrl = $('url-' + domainId).value.trim();
          if (!orderNum || !targetUrl) {
            msg('link-msg-' + domainId, 'Order number and URL are required.', 'err');
            return;
          }
          try {
            await api('/api/domains/' + domainId + '/links', {
              method: 'POST',
              body: JSON.stringify({ order_num: orderNum, target_url: targetUrl })
            });
            $('order-' + domainId).value = '';
            $('url-' + domainId).value = '';
            msg('link-msg-' + domainId, 'Link added.', 'ok');
            await loadLinksForDomain(domainId);
          } catch (e) {
            msg('link-msg-' + domainId, e.message, 'err');
          }
        });
      });

      // Load links for verified domains
      document.querySelectorAll('.links-container').forEach(el => {
        const domainId = el.id.replace('links-', '');
        loadLinksForDomain(domainId);
      });
    }

    async function loadLinksForDomain(domainId) {
      const wrap = $('links-' + domainId);
      if (!wrap) return;
      try {
        const links = await api('/api/domains/' + domainId + '/links');
        if (!links.length) {
          wrap.innerHTML = '<div class="empty">No links yet.</div>';
          return;
        }
        wrap.innerHTML = links.map(l => `
          <div class="link-item">
            <span class="link-order">#${l.order_num}</span>
            <span class="link-url">${esc(l.target_url)}</span>
            <button class="btn-danger" style="padding:4px 10px;font-size:12px;" data-delete-link="${l.id}" data-domain-id="${domainId}">×</button>
          </div>`).join('');

        wrap.querySelectorAll('[data-delete-link]').forEach(btn => {
          btn.addEventListener('click', async () => {
            if (!confirm('Delete this link?')) return;
            try {
              await api('/api/links/' + btn.getAttribute('data-delete-link'), { method: 'DELETE' });
              await loadLinksForDomain(btn.getAttribute('data-domain-id'));
            } catch (e) {
              alert('Delete failed: ' + e.message);
            }
          });
        });
      } catch (e) {
        wrap.innerHTML = '<div class="empty" style="color:#c53030">' + esc(e.message) + '</div>';
      }
    }

    loadDomains();
  </script>
</body>
</html>`;
}

await initDB();

Bun.serve({
  port: 3000,
  fetch: handleRequest,
});

console.log("Server running on http://localhost:3000");
