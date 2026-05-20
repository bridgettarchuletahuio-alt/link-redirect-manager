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
      CREATE TABLE IF NOT EXISTS links (
        id SERIAL PRIMARY KEY,
        domain_name VARCHAR(255) NOT NULL,
        order_num INTEGER NOT NULL,
        target_url VARCHAR(2048) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;


    await sql`
      CREATE TABLE IF NOT EXISTS ip_assignments (
        id SERIAL PRIMARY KEY,
        link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
        ip_address VARCHAR(45) NOT NULL,
        country_code VARCHAR(2),
        assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(link_id, ip_address)
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS blocked_countries (
        id SERIAL PRIMARY KEY,
        link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
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


  // API: 添加链接
  if (path === "/api/links" && method === "POST") {
    try {
      const { domain_name, order_num, target_url } = await req.json();
      const sql = Bun.sql;
      const result = await sql`
        INSERT INTO links (domain_name, order_num, target_url)
        VALUES (${domain_name}, ${order_num}, ${target_url})
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

  // API: 获取所有链接
  if (path === "/api/links" && method === "GET") {
    try {
      const sql = Bun.sql;
      const links = await sql`SELECT * FROM links ORDER BY created_at DESC`;
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

      // 检查地区限制
      const country = await getCountryFromIP(clientIP);
      const blockedResult = await sql`
        SELECT * FROM blocked_countries 
        WHERE link_id IN (SELECT id FROM links WHERE domain_name = ${domainName}) AND country_code = ${country}
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
        WHERE ip_address = ${clientIP} AND link_id IN (SELECT id FROM links WHERE domain_name = ${domainName})
      `;

      let assignedLinkId: number;

      if (existingAssignment.length > 0) {
        // IP 已经被分配过，返回固定的链接
        assignedLinkId = existingAssignment[0].link_id;
      } else {
        // IP 是新的，随机分配一个链接
        const allLinks = await sql`
          SELECT id FROM links WHERE domain_name = ${domainName}
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
          INSERT INTO ip_assignments (link_id, ip_address, country_code)
          VALUES (${assignedLinkId}, ${clientIP}, ${country})
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

  // API: 获取 IP 分配记录（可选按域名过滤）
  const recordsMatch = path.match(/^\/api\/assignments(?:\/(.+))?$/);
  if (recordsMatch && method === "GET") {
    try {
      const domainName = recordsMatch[1];
      const sql = Bun.sql;
      let records;
      if (domainName) {
        records = await sql`
          SELECT ia.*, l.target_url, l.order_num, l.domain_name
          FROM ip_assignments ia
          JOIN links l ON ia.link_id = l.id
          WHERE l.domain_name = ${domainName}
          ORDER BY ia.assigned_at DESC
        `;
      } else {
        records = await sql`
          SELECT ia.*, l.target_url, l.order_num, l.domain_name
          FROM ip_assignments ia
          JOIN links l ON ia.link_id = l.id
          ORDER BY ia.assigned_at DESC
        `;
      }
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
                    <p>统一管理所有跳转链接，为每个链接设置自定义域名，支持 IP 锁定和地区限制</p>
                  </div>

                  <div class="card">
                    <div class="info">
                      <strong>🔒 IP 固定分配说明：</strong> 每个 IP 地址被随机分配到一个固定的子链接。无论访问多少次，该 IP 都只能访问分配给它的那个链接。
                    </div>
                  </div>

                  <div class="card">
                    <h2>添加新链接</h2>
                    <input type="text" id="newDomain" placeholder="自定义域名，如 example.com">
                    <input type="number" id="newOrder" placeholder="顺序号 (1, 2, 3...)" min="1">
                    <input type="url" id="newUrl" placeholder="目标跳转 URL">
                    <button onclick="addLink()">添加链接</button>
                    <div id="addLinkMsg"></div>
                  </div>

                  <div class="card">
                    <h2>所有链接</h2>
                    <div id="linksList"></div>
                  </div>

                  <div class="card">
                    <h2>IP 分配记录</h2>
                    <button onclick="loadAssignments()">刷新分配记录</button>
                    <div id="assignmentsList"></div>
                  </div>
                </div>

                <script>
                  async function addLink() {
                    const domain = document.getElementById('newDomain').value.trim();
                    const order = document.getElementById('newOrder').value;
                    const url = document.getElementById('newUrl').value.trim();
                    if (!domain || !order || !url) {
                      document.getElementById('addLinkMsg').innerHTML = '<p class="error">请填写所有字段</p>';
                      return;
                    }
                    try {
                      const res = await fetch('/api/links', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ domain_name: domain, order_num: parseInt(order), target_url: url })
                      });
                      if (res.ok) {
                        document.getElementById('addLinkMsg').innerHTML = '<p class="success">添加成功</p>';
                        document.getElementById('newDomain').value = '';
                        document.getElementById('newOrder').value = '';
                        document.getElementById('newUrl').value = '';
                        loadLinks();
                      } else {
                        document.getElementById('addLinkMsg').innerHTML = '<p class="error">添加失败</p>';
                      }
                    } catch (e) {
                      document.getElementById('addLinkMsg').innerHTML = '<p class="error">网络错误</p>';
                    }
                  }

                  async function loadLinks() {
                    try {
                      const res = await fetch('/api/links');
                      const links = await res.json();
                      const html = links.map(l => `
                        <div class="link-item">
                          <strong>域名:</strong> ${l.domain_name} <br>
                          <strong>顺序号:</strong> ${l.order_num} <br>
                          <strong>目标URL:</strong> ${l.target_url} <br>
                          <button class="delete-btn" onclick="deleteLink(${l.id})">删除</button>
                        </div>
                      `).join('');
                      document.getElementById('linksList').innerHTML = html || '<p>暂无链接</p>';
                    } catch (e) {
                      document.getElementById('linksList').innerHTML = '<p class="error">加载失败</p>';
                    }
                  }

                  async function deleteLink(linkId) {
                    if (!confirm('确定要删除此链接吗？')) return;
                    try {
                      await fetch(`/api/links/${linkId}`, { method: 'DELETE' });
                      loadLinks();
                    } catch (e) {
                      alert('删除失败');
                    }
                  }

                  async function loadAssignments() {
                    try {
                      const res = await fetch('/api/assignments');
                      const assignments = await res.json();
                      const html = assignments.map(a => `
                        <div class="link-item">
                          <strong>IP:</strong> ${a.ip_address} | 
                          <strong>国家:</strong> ${a.country_code} | 
                          <strong>域名:</strong> ${a.domain_name} | 
                          <strong>顺序号:</strong> ${a.order_num} | 
                          <strong>目标URL:</strong> ${a.target_url} | 
                          <strong>分配时间:</strong> ${new Date(a.assigned_at).toLocaleString()}
                        </div>
                      `).join('');
                      document.getElementById('assignmentsList').innerHTML = html || '<p>暂无分配记录</p>';
                    } catch (e) {
                      document.getElementById('assignmentsList').innerHTML = '<p class="error">加载失败</p>';
                    }
                  }

                  // 初始化加载
                  loadLinks();
                  loadAssignments();
                </script>
              </body>
              </html>
            `;
