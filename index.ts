import { resolve } from "dns/promises";
import crypto from "crypto";

// Generate a unique DNS TXT verification token
function generateVerificationToken(): string {
  return "link-redirect-verify=" + crypto.randomBytes(24).toString("hex");
}

// Check DNS TXT records for the verification token
async function verifyDomainOwnership(
  domainName: string,
  token: string
): Promise<boolean> {
  try {
    const records = await resolve(domainName, "TXT");
    // records is string[][], each entry is an array of string chunks for one TXT record
    for (const record of records) {
      const full = record.join("");
      if (full === token) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// 获取客户端 IP
function getClientIP(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    req.headers.get("cf-connecting-ip") ||
    "unknown"
  );
}

// 获取地区信息（基于 IP）
async function getCountryFromIP(ip: string): Promise<string> {
  try {
    const res = await fetch(`https://ipapi.co/${ip}/json/`);
    const data = await res.json();
    return data.country_code || "unknown";
  } catch {
    return "unknown";
  }
}

// 初始化数据库
async function initDB() {
  const dbUrl = Bun.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL not set");
    return;
  }

  try {
    const sql = Bun.sql;
    
    // 创建表
    await sql`
      CREATE TABLE IF NOT EXISTS domains (
        id SERIAL PRIMARY KEY,
        domain_name VARCHAR(255) UNIQUE NOT NULL,
        verification_token VARCHAR(255),
        is_verified BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;

    // Add new columns to existing domains table if they don't exist yet
    await sql`
      ALTER TABLE domains
        ADD COLUMN IF NOT EXISTS verification_token VARCHAR(255),
        ADD COLUMN IF NOT EXISTS is_verified BOOLEAN NOT NULL DEFAULT FALSE
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS links (
        id SERIAL PRIMARY KEY,
        domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
        order_num INTEGER NOT NULL,
        target_url VARCHAR(2048) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS ip_assignments (
        id SERIAL PRIMARY KEY,
        domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
        ip_address VARCHAR(45) NOT NULL,
        link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
        country_code VARCHAR(2),
        assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(domain_id, ip_address)
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS blocked_countries (
        id SERIAL PRIMARY KEY,
        domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
        country_code VARCHAR(2) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;

    console.log("Database initialized successfully");
  } catch (error) {
    console.error("Database initialization error:", error);
  }
}

// 初始化数据库
await initDB();

// 路由处理
async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  // 管理面板首页
  if (path === "/" && method === "GET") {
    return new Response(getAdminHTML(), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // API: Register domain (step 1 — issues a verification token)
  if (path === "/api/domains/register" && method === "POST") {
    try {
      const { domain_name } = await req.json();
      if (!domain_name) {
        return new Response(JSON.stringify({ error: "domain_name is required" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      const token = generateVerificationToken();
      const sql = Bun.sql;
      const result = await sql`
        INSERT INTO domains (domain_name, verification_token, is_verified)
        VALUES (${domain_name}, ${token}, FALSE)
        ON CONFLICT (domain_name) DO UPDATE
          SET verification_token = ${token}, is_verified = FALSE
        RETURNING id, domain_name, verification_token, is_verified
      `;
      return new Response(
        JSON.stringify({
          ...result[0],
          instructions: `Add the following DNS TXT record to ${domain_name}, then call POST /api/domains/verify`,
          txt_record: token,
        }),
        {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }
      );
    } catch (error) {
      return new Response(JSON.stringify({ error: "Failed to register domain" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // API: Verify domain ownership (step 2 — checks DNS TXT record)
  if (path === "/api/domains/verify" && method === "POST") {
    try {
      const { domain_name } = await req.json();
      if (!domain_name) {
        return new Response(JSON.stringify({ error: "domain_name is required" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      const sql = Bun.sql;
      const domainResult = await sql`
        SELECT id, domain_name, verification_token, is_verified
        FROM domains WHERE domain_name = ${domain_name}
      `;
      if (domainResult.length === 0) {
        return new Response(
          JSON.stringify({ error: "Domain not found. Register it first via POST /api/domains/register" }),
          { status: 404, headers: { "Content-Type": "application/json" } }
        );
      }
      const domain = domainResult[0];
      if (domain.is_verified) {
        return new Response(
          JSON.stringify({ message: "Domain is already verified", domain }),
          { headers: { "Content-Type": "application/json" } }
        );
      }
      const verified = await verifyDomainOwnership(domain_name, domain.verification_token);
      if (!verified) {
        return new Response(
          JSON.stringify({
            error: "DNS TXT record not found or does not match",
            expected_txt_record: domain.verification_token,
            hint: `Add a TXT record to ${domain_name} with the value above, then retry`,
          }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
      await sql`
        UPDATE domains SET is_verified = TRUE WHERE id = ${domain.id}
      `;
      return new Response(
        JSON.stringify({ message: "Domain verified successfully", domain_name, id: domain.id }),
        { headers: { "Content-Type": "application/json" } }
      );
    } catch (error) {
      return new Response(JSON.stringify({ error: "Verification failed" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // API: 获取所有域名
  if (path === "/api/domains" && method === "GET") {
    try {
      const sql = Bun.sql;
      const domains = await sql`SELECT * FROM domains`;
      return new Response(JSON.stringify(domains), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: "Failed to fetch domains" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // API: 添加链接 (only allowed for verified domains)
  const addLinkMatch = path.match(/^\/api\/domains\/(\d+)\/links$/);
  if (addLinkMatch && method === "POST") {
    try {
      const domainId = parseInt(addLinkMatch[1]);
      const sql = Bun.sql;

      // Enforce domain ownership verification before allowing link management
      const domainCheck = await sql`
        SELECT is_verified, domain_name FROM domains WHERE id = ${domainId}
      `;
      if (domainCheck.length === 0) {
        return new Response(JSON.stringify({ error: "Domain not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (!domainCheck[0].is_verified) {
        return new Response(
          JSON.stringify({
            error: "Domain ownership not verified",
            hint: `Verify ${domainCheck[0].domain_name} first via POST /api/domains/verify`,
          }),
          { status: 403, headers: { "Content-Type": "application/json" } }
        );
      }

      const { order_num, target_url } = await req.json();
      const result = await sql`
        INSERT INTO links (domain_id, order_num, target_url)
        VALUES (${domainId}, ${order_num}, ${target_url})
        RETURNING *
      `;
      return new Response(JSON.stringify(result[0]), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: "Failed to create link" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // API: 获取域名的所有链接
  const getLinksMatch = path.match(/^\/api\/domains\/(\d+)\/links$/);
  if (getLinksMatch && method === "GET") {
    try {
      const domainId = parseInt(getLinksMatch[1]);
      const sql = Bun.sql;
      const links = await sql`
        SELECT * FROM links WHERE domain_id = ${domainId}
        ORDER BY order_num ASC
      `;
      return new Response(JSON.stringify(links), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: "Failed to fetch links" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // API: 删除链接
  const deleteLinkMatch = path.match(/^\/api\/links\/(\d+)$/);
  if (deleteLinkMatch && method === "DELETE") {
    try {
      const linkId = parseInt(deleteLinkMatch[1]);
      const sql = Bun.sql;
      await sql`DELETE FROM links WHERE id = ${linkId}`;
      return new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: "Failed to delete link" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // API: 核心功能 - 用户访问链接（IP 固定分配到一个子链接）
  const redirectMatch = path.match(/^\/api\/redirect\/(.+)$/);
  if (redirectMatch && method === "GET") {
    try {
      const domainName = redirectMatch[1];
      const clientIP = getClientIP(req);
      const sql = Bun.sql;

      // 获取域名 ID
      const domainResult = await sql`
        SELECT id FROM domains WHERE domain_name = ${domainName}
      `;

      if (domainResult.length === 0) {
        return new Response(JSON.stringify({ error: "Domain not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }

      const domainId = domainResult[0].id;

      // 检查地区限制
      const country = await getCountryFromIP(clientIP);
      const blockedResult = await sql`
        SELECT * FROM blocked_countries 
        WHERE domain_id = ${domainId} AND country_code = ${country}
      `;

      if (blockedResult.length > 0) {
        return new Response(
          JSON.stringify({ error: "Access denied from your country" }),
          {
            status: 403,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      // 检查 IP 是否已经被分配过
      const existingAssignment = await sql`
        SELECT link_id FROM ip_assignments 
        WHERE domain_id = ${domainId} AND ip_address = ${clientIP}
      `;

      let assignedLinkId: number;

      if (existingAssignment.length > 0) {
        // IP 已经被分配过，返回固定的链接
        assignedLinkId = existingAssignment[0].link_id;
      } else {
        // IP 是新的，随机分配一个链接
        const allLinks = await sql`
          SELECT id FROM links WHERE domain_id = ${domainId}
          ORDER BY order_num ASC
        `;

        if (allLinks.length === 0) {
          return new Response(JSON.stringify({ error: "No links available" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }

        // 随机选择一个链接
        assignedLinkId = allLinks[Math.floor(Math.random() * allLinks.length)].id;

        // 记录 IP 分配
        await sql`
          INSERT INTO ip_assignments (domain_id, ip_address, link_id, country_code)
          VALUES (${domainId}, ${clientIP}, ${assignedLinkId}, ${country})
        `;
      }

      // 获取分配的链接信息
      const linkResult = await sql`
        SELECT * FROM links WHERE id = ${assignedLinkId}
      `;

      if (linkResult.length === 0) {
        return new Response(JSON.stringify({ error: "Link not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }

      const link = linkResult[0];

      return new Response(
        JSON.stringify({
          url: link.target_url,
          order: link.order_num,
          message: "This IP is locked to this link",
        }),
        {
          headers: { "Content-Type": "application/json" },
        }
      );
    } catch (error) {
      console.error("Redirect error:", error);
      return new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // API: 获取 IP 分配记录
  const recordsMatch = path.match(/^\/api\/domains\/(\d+)\/assignments$/);
  if (recordsMatch && method === "GET") {
    try {
      const domainId = parseInt(recordsMatch[1]);
      const sql = Bun.sql;
      const records = await sql`
        SELECT ia.*, l.target_url, l.order_num
        FROM ip_assignments ia
        JOIN links l ON ia.link_id = l.id
        WHERE ia.domain_id = ${domainId}
        ORDER BY ia.assigned_at DESC
      `;
      return new Response(JSON.stringify(records), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: "Failed to fetch assignments" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  return new Response(JSON.stringify({ error: "Not found" }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
}

function getAdminHTML(): string {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Link Redirect Manager</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; }
        .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
        .header { background: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
        .card { background: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
        input, textarea { width: 100%; padding: 10px; margin: 10px 0; border: 1px solid #ddd; border-radius: 4px; }
        button { background: #0066cc; color: white; padding: 10px 20px; border: none; border-radius: 4px; cursor: pointer; margin: 10px 0; }
        button:hover { background: #0052a3; }
        .btn-verify { background: #2e7d32; }
        .btn-verify:hover { background: #1b5e20; }
        .link-item { background: #f9f9f9; padding: 15px; margin: 10px 0; border-radius: 4px; border-left: 4px solid #0066cc; }
        .delete-btn { background: #cc0000; padding: 5px 10px; font-size: 12px; }
        .delete-btn:hover { background: #990000; }
        h2 { margin: 20px 0 10px 0; color: #333; }
        .success { color: green; }
        .error { color: red; }
        .warning { color: #e65100; }
        .info { background: #e3f2fd; padding: 15px; border-radius: 4px; margin: 10px 0; border-left: 4px solid #2196F3; }
        .warn-box { background: #fff3e0; padding: 15px; border-radius: 4px; margin: 10px 0; border-left: 4px solid #ff9800; }
        .verified-badge { display: inline-block; background: #2e7d32; color: white; font-size: 11px; padding: 2px 8px; border-radius: 10px; margin-left: 8px; }
        .unverified-badge { display: inline-block; background: #e65100; color: white; font-size: 11px; padding: 2px 8px; border-radius: 10px; margin-left: 8px; }
        .txt-record { font-family: monospace; background: #f5f5f5; padding: 10px; border-radius: 4px; word-break: break-all; border: 1px solid #ddd; margin: 8px 0; }
        .step { margin-bottom: 12px; }
        .step-num { display: inline-block; background: #0066cc; color: white; width: 22px; height: 22px; border-radius: 50%; text-align: center; line-height: 22px; font-size: 12px; margin-right: 6px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>🔗 Link Redirect Manager</h1>
          <p>Manage verified domains, links, and track access with IP locking and geo-blocking</p>
        </div>

        <div class="card">
          <div class="info">
            <strong>🔒 Domain Ownership Verification Required</strong><br>
            To prevent domain hijacking, you must prove you own a domain before managing links on it.
            Registration issues a DNS TXT record you add to your domain; verification checks that record via live DNS lookup.
          </div>
        </div>

        <div class="card">
          <h2>Step 1 — Register Domain</h2>
          <p style="margin-bottom:10px; color:#555;">Enter your domain name to receive a unique DNS TXT verification token.</p>
          <input type="text" id="domainName" placeholder="example.com">
          <button onclick="registerDomain()">Register Domain</button>
          <div id="registerMessage"></div>
          <div id="verifyInstructions" style="display:none;">
            <div class="warn-box">
              <strong>⚠️ Action Required — Add this DNS TXT record to your domain:</strong>
              <div class="txt-record" id="txtRecord"></div>
              <p style="margin-top:8px;">Once the record is live (DNS propagation may take a few minutes), click <strong>Verify Ownership</strong> below.</p>
            </div>
            <h2 style="margin-top:16px;">Step 2 — Verify Ownership</h2>
            <button class="btn-verify" onclick="verifyDomain()">Verify Ownership</button>
            <div id="verifyMessage"></div>
          </div>
        </div>

        <div class="card">
          <h2>Manage Domains</h2>
          <div id="domainsList"></div>
        </div>
      </div>

      <script>
        let pendingVerifyDomain = '';

        async function registerDomain() {
          const name = document.getElementById('domainName').value.trim();
          if (!name) return alert('Enter a domain name');

          try {
            const res = await fetch('/api/domains/register', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ domain_name: name })
            });
            const data = await res.json();
            if (!res.ok) {
              document.getElementById('registerMessage').innerHTML = \`<p class="error">\${data.error || 'Registration failed'}</p>\`;
              return;
            }
            pendingVerifyDomain = name;
            document.getElementById('registerMessage').innerHTML = \`<p class="success">Domain registered! Now add the TXT record below to your DNS.</p>\`;
            document.getElementById('txtRecord').textContent = data.txt_record;
            document.getElementById('verifyInstructions').style.display = 'block';
            document.getElementById('verifyMessage').innerHTML = '';
            loadDomains();
          } catch (e) {
            document.getElementById('registerMessage').innerHTML = '<p class="error">Error registering domain</p>';
          }
        }

        async function verifyDomain() {
          const name = pendingVerifyDomain || document.getElementById('domainName').value.trim();
          if (!name) return alert('Register a domain first');

          document.getElementById('verifyMessage').innerHTML = '<p>Checking DNS records…</p>';
          try {
            const res = await fetch('/api/domains/verify', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ domain_name: name })
            });
            const data = await res.json();
            if (!res.ok) {
              document.getElementById('verifyMessage').innerHTML =
                \`<p class="error">\${data.error}</p><p class="warning" style="margin-top:6px;">\${data.hint || ''}</p>\`;
              return;
            }
            document.getElementById('verifyMessage').innerHTML = \`<p class="success">✅ \${data.message}</p>\`;
            document.getElementById('verifyInstructions').style.display = 'none';
            document.getElementById('domainName').value = '';
            pendingVerifyDomain = '';
            loadDomains();
          } catch (e) {
            document.getElementById('verifyMessage').innerHTML = '<p class="error">Error during verification</p>';
          }
        }

        async function loadDomains() {
          try {
            const res = await fetch('/api/domains');
            const domains = await res.json();
            if (!Array.isArray(domains) || domains.length === 0) {
              document.getElementById('domainsList').innerHTML = '<p style="color:#888;">No domains registered yet.</p>';
              return;
            }
            const html = domains.map(d => \`
              <div class="card">
                <h3>
                  \${d.domain_name}
                  \${d.is_verified
                    ? '<span class="verified-badge">✓ Verified</span>'
                    : '<span class="unverified-badge">⚠ Unverified</span>'}
                </h3>
                \${d.is_verified
                  ? \`<button onclick="toggleDomain(\${d.id})">Manage Links</button>
                     <button onclick="viewAssignments(\${d.id})">View IP Assignments</button>\`
                  : \`<div class="warn-box" style="margin-top:10px;">
                       Domain not yet verified. Complete Step 1 &amp; 2 above to unlock link management.
                     </div>\`}
                <div id="domain-\${d.id}" style="display:none; margin-top: 20px;">
                  <h4>Add Link</h4>
                  <input type="number" id="order-\${d.id}" placeholder="Order (1, 2, 3...)">
                  <input type="url" id="url-\${d.id}" placeholder="Target URL">
                  <button onclick="addLink(\${d.id})">Add Link</button>
                  <div id="link-msg-\${d.id}"></div>
                  <h4>Links</h4>
                  <div id="links-\${d.id}"></div>
                </div>
                <div id="assignments-\${d.id}" style="display:none; margin-top: 20px;">
                  <h4>IP Assignments</h4>
                  <div id="assignments-list-\${d.id}"></div>
                </div>
              </div>
            \`).join('');
            document.getElementById('domainsList').innerHTML = html;
          } catch (e) {
            console.error(e);
          }
        }

        async function toggleDomain(id) {
          const el = document.getElementById(\`domain-\${id}\`);
          el.style.display = el.style.display === 'none' ? 'block' : 'none';
          if (el.style.display === 'block') loadLinks(id);
        }

        async function viewAssignments(id) {
          const el = document.getElementById(\`assignments-\${id}\`);
          el.style.display = el.style.display === 'none' ? 'block' : 'none';
          if (el.style.display === 'block') loadAssignments(id);
        }

        async function addLink(domainId) {
          const order = document.getElementById(\`order-\${domainId}\`).value;
          const url = document.getElementById(\`url-\${domainId}\`).value;
          if (!order || !url) return alert('Fill all fields');

          try {
            const res = await fetch(\`/api/domains/\${domainId}/links\`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ order_num: parseInt(order), target_url: url })
            });
            const data = await res.json();
            if (!res.ok) {
              document.getElementById(\`link-msg-\${domainId}\`).innerHTML =
                \`<p class="error">\${data.error || 'Failed to add link'}</p>\`;
              return;
            }
            document.getElementById(\`link-msg-\${domainId}\`).innerHTML = '';
            document.getElementById(\`order-\${domainId}\`).value = '';
            document.getElementById(\`url-\${domainId}\`).value = '';
            loadLinks(domainId);
          } catch (e) {
            alert('Error adding link');
          }
        }

        async function loadLinks(domainId) {
          try {
            const res = await fetch(\`/api/domains/\${domainId}/links\`);
            const links = await res.json();
            const html = links.map(l => \`
              <div class="link-item">
                <strong>Link #\${l.order_num}:</strong> \${l.target_url}
                <button class="delete-btn" onclick="deleteLink(\${l.id}, \${domainId})">Delete</button>
              </div>
            \`).join('');
            document.getElementById(\`links-\${domainId}\`).innerHTML = html || '<p>No links yet</p>';
          } catch (e) {
            console.error(e);
          }
        }

        async function loadAssignments(domainId) {
          try {
            const res = await fetch(\`/api/domains/\${domainId}/assignments\`);
            const assignments = await res.json();
            const html = assignments.map(a => \`
              <div class="link-item">
                <strong>IP:</strong> \${a.ip_address} |
                <strong>Country:</strong> \${a.country_code} |
                <strong>Link #\${a.order_num}:</strong> \${a.target_url} |
                <strong>Assigned:</strong> \${new Date(a.assigned_at).toLocaleString()}
              </div>
            \`).join('');
            document.getElementById(\`assignments-list-\${domainId}\`).innerHTML = html || '<p>No assignments yet</p>';
          } catch (e) {
            console.error(e);
          }
        }

        async function deleteLink(linkId, domainId) {
          if (!confirm('Delete this link?')) return;
          try {
            await fetch(\`/api/links/\${linkId}\`, { method: 'DELETE' });
            loadLinks(domainId);
          } catch (e) {
            alert('Error deleting link');
          }
        }

        loadDomains();
      </script>
    </body>
    </html>
  `;
}

// 启动服务器
Bun.serve({
  port: 3000,
  fetch: handleRequest,
});

console.log("Server running on http://localhost:3000");
