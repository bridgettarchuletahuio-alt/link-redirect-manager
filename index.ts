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
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
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

  // API: 创建域名
  if (path === "/api/domains" && method === "POST") {
    try {
      const { domain_name } = await req.json();
      const sql = Bun.sql;
      const result = await sql`
        INSERT INTO domains (domain_name) VALUES (${domain_name})
        RETURNING id, domain_name
      `;
      return new Response(JSON.stringify(result[0]), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: "Failed to create domain" }), {
        status: 400,
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

  // API: 添加链接
  const addLinkMatch = path.match(/^\/api\/domains\/(\d+)\/links$/);
  if (addLinkMatch && method === "POST") {
    try {
      const domainId = parseInt(addLinkMatch[1]);
      const { order_num, target_url } = await req.json();
      const sql = Bun.sql;
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
        .link-item { background: #f9f9f9; padding: 15px; margin: 10px 0; border-radius: 4px; border-left: 4px solid #0066cc; }
        .delete-btn { background: #cc0000; padding: 5px 10px; font-size: 12px; }
        .delete-btn:hover { background: #990000; }
        h2 { margin: 20px 0 10px 0; color: #333; }
        .success { color: green; }
        .error { color: red; }
        .info { background: #e3f2fd; padding: 15px; border-radius: 4px; margin: 10px 0; border-left: 4px solid #2196F3; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>🔗 Link Redirect Manager</h1>
          <p>Create domains, manage links, and track access with IP locking and geo-blocking</p>
        </div>

        <div class="card">
          <div class="info">
            <strong>🔒 IP 固定分配说明：</strong> 每个 IP 地址被随机分配到一个固定的子链接。无论访问多少次，该 IP 都只能访问分配给它的那个链接。
          </div>
        </div>

        <div class="card">
          <h2>Create New Domain</h2>
          <input type="text" id="domainName" placeholder="example.com">
          <button onclick="createDomain()">Create Domain</button>
          <div id="domainMessage"></div>
        </div>

        <div class="card">
          <h2>Manage Domains</h2>
          <div id="domainsList"></div>
        </div>
      </div>

      <script>
        async function createDomain() {
          const name = document.getElementById('domainName').value;
          if (!name) return alert('Enter domain name');
          
          try {
            const res = await fetch('/api/domains', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ domain_name: name })
            });
            const data = await res.json();
            document.getElementById('domainMessage').innerHTML = '<p class="success">Domain created!</p>';
            document.getElementById('domainName').value = '';
            loadDomains();
          } catch (e) {
            document.getElementById('domainMessage').innerHTML = '<p class="error">Error creating domain</p>';
          }
        }

        async function loadDomains() {
          try {
            const res = await fetch('/api/domains');
            const domains = await res.json();
            const html = domains.map(d => \`
              <div class="card">
                <h3>\${d.domain_name}</h3>
                <button onclick="toggleDomain(\${d.id})">Manage Links</button>
                <button onclick="viewAssignments(\${d.id})">View IP Assignments</button>
                <div id="domain-\${d.id}" style="display:none; margin-top: 20px;">
                  <h4>Add Link</h4>
                  <input type="number" id="order-\${d.id}" placeholder="Order (1, 2, 3...)">
                  <input type="url" id="url-\${d.id}" placeholder="Target URL">
                  <button onclick="addLink(\${d.id})">Add Link</button>
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
            await fetch(\`/api/domains/\${domainId}/links\`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ order_num: parseInt(order), target_url: url })
            });
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
