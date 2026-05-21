type SqlClient = typeof Bun.sql;

type DomainRow = {
  id: number;
  domain_name: string;
  created_at: string;
};

type LinkRow = {
  id: number;
  domain_id: number;
  domain_name: string;
  order_num: number;
  target_url: string;
  created_at: string;
};

const PORT = Number(Bun.env.PORT || 3000);

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function getClientIP(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

function getRequestHost(req: Request): string {
  return (
    req.headers.get("x-forwarded-host")?.split(",")[0].trim() ||
    req.headers.get("host") ||
    ""
  );
}

function normalizeHostToDomain(hostRaw: string): string {
  return hostRaw.split(":")[0].trim().toLowerCase();
}

async function getCountryFromIP(ip: string): Promise<string> {
  if (!ip || ip === "unknown" || ip === "127.0.0.1" || ip === "::1") {
    return "LOCAL";
  }

  try {
    const res = await fetch(`https://ipapi.co/${ip}/json/`);
    if (!res.ok) {
      return "unknown";
    }

    const data = await res.json();
    return String(data.country_code || "unknown").toUpperCase();
  } catch {
    return "unknown";
  }
}

function normalizeCountryCode(countryCode: string): string {
  return countryCode.trim().toUpperCase();
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

    await sql`
      CREATE TABLE IF NOT EXISTS ip_assignments (
        id SERIAL PRIMARY KEY,
        domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
        link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
        ip_address VARCHAR(45) NOT NULL,
        country_code VARCHAR(16),
        assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(domain_id, ip_address)
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS blocked_countries (
        id SERIAL PRIMARY KEY,
        domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
        country_code VARCHAR(16) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(domain_id, country_code)
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS access_logs (
        id SERIAL PRIMARY KEY,
        domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
        link_id INTEGER REFERENCES links(id) ON DELETE SET NULL,
        ip_address VARCHAR(45) NOT NULL,
        country_code VARCHAR(16),
        event_type VARCHAR(32) NOT NULL,
        status_code INTEGER NOT NULL,
        detail TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;

    console.log("Database initialized successfully");
  } catch (error) {
    console.error("Database initialization error:", error);
  }
}

async function resolveDomain(sql: SqlClient, domainName: string): Promise<DomainRow | null> {
  const result = await sql`
    SELECT * FROM domains WHERE domain_name = ${domainName}
  `;

  return result[0] ?? null;
}

async function writeAccessLog(
  sql: SqlClient,
  params: {
    domainId: number;
    linkId?: number | null;
    ipAddress: string;
    countryCode: string;
    eventType: string;
    statusCode: number;
    detail: string;
  }
) {
  await sql`
    INSERT INTO access_logs (
      domain_id,
      link_id,
      ip_address,
      country_code,
      event_type,
      status_code,
      detail
    )
    VALUES (
      ${params.domainId},
      ${params.linkId ?? null},
      ${params.ipAddress},
      ${params.countryCode},
      ${params.eventType},
      ${params.statusCode},
      ${params.detail}
    )
  `;
}

function getAdminHTML(): string {
  return String.raw`
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Link Redirect Manager</title>
  <style>
    :root {
      --bg: linear-gradient(135deg, #f4efe5 0%, #d9e4f5 100%);
      --panel: rgba(255, 255, 255, 0.88);
      --panel-strong: #ffffff;
      --line: rgba(20, 35, 60, 0.12);
      --text: #1d2636;
      --muted: #59657c;
      --accent: #0d7c66;
      --accent-dark: #0a5a4b;
      --danger: #b42318;
      --warning: #b54708;
      --shadow: 0 18px 60px rgba(28, 45, 78, 0.12);
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      font-family: "IBM Plex Sans", "Noto Sans SC", sans-serif;
      color: var(--text);
      background: var(--bg);
    }

    .shell {
      max-width: 1360px;
      margin: 0 auto;
      padding: 32px 20px 56px;
    }

    .hero {
      display: grid;
      gap: 16px;
      padding: 28px;
      background: linear-gradient(140deg, rgba(255,255,255,0.92), rgba(244,248,255,0.76));
      border: 1px solid rgba(255,255,255,0.6);
      border-radius: 28px;
      box-shadow: var(--shadow);
      backdrop-filter: blur(14px);
    }

    .hero h1 {
      margin: 0;
      font-family: "Space Grotesk", "IBM Plex Sans", sans-serif;
      font-size: clamp(34px, 6vw, 56px);
      line-height: 0.95;
      letter-spacing: -0.04em;
    }

    .hero p {
      margin: 0;
      max-width: 760px;
      color: var(--muted);
      font-size: 16px;
      line-height: 1.6;
    }

    .hero-grid {
      display: grid;
      gap: 14px;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    }

    .stat {
      padding: 16px 18px;
      border-radius: 18px;
      background: rgba(255,255,255,0.7);
      border: 1px solid var(--line);
    }

    .stat strong {
      display: block;
      font-size: 28px;
      font-family: "Space Grotesk", sans-serif;
    }

    .layout {
      display: grid;
      gap: 20px;
      grid-template-columns: 340px minmax(0, 1fr);
      margin-top: 24px;
    }

    .panel {
      background: var(--panel);
      border: 1px solid rgba(255,255,255,0.68);
      border-radius: 24px;
      box-shadow: var(--shadow);
      padding: 22px;
      backdrop-filter: blur(12px);
    }

    .panel h2,
    .panel h3 {
      margin: 0 0 14px;
      font-family: "Space Grotesk", sans-serif;
      letter-spacing: -0.02em;
    }

    .stack {
      display: grid;
      gap: 12px;
    }

    .field {
      display: grid;
      gap: 8px;
    }

    .field label {
      font-size: 13px;
      color: var(--muted);
      font-weight: 600;
    }

    input,
    select,
    textarea,
    button {
      font: inherit;
    }

    input,
    select {
      width: 100%;
      padding: 12px 14px;
      border-radius: 14px;
      border: 1px solid var(--line);
      background: rgba(255,255,255,0.9);
      color: var(--text);
    }

    button {
      border: 0;
      border-radius: 14px;
      padding: 12px 16px;
      cursor: pointer;
      transition: transform 120ms ease, opacity 120ms ease, background 120ms ease;
    }

    button:hover {
      transform: translateY(-1px);
    }

    .primary {
      background: var(--accent);
      color: white;
      font-weight: 700;
    }

    .secondary {
      background: rgba(13, 124, 102, 0.12);
      color: var(--accent-dark);
      font-weight: 700;
    }

    .danger {
      background: rgba(180, 35, 24, 0.12);
      color: var(--danger);
      font-weight: 700;
    }

    .warning {
      background: rgba(181, 71, 8, 0.12);
      color: var(--warning);
      font-weight: 700;
    }

    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
    }

    .hint {
      margin: 0;
      color: var(--muted);
      font-size: 14px;
      line-height: 1.5;
    }

    .domain-list,
    .card-grid,
    .table-wrap {
      display: grid;
      gap: 12px;
    }

    .domain-item,
    .card-item {
      border: 1px solid var(--line);
      border-radius: 18px;
      padding: 14px 16px;
      background: rgba(255,255,255,0.76);
    }

    .domain-item.active {
      border-color: rgba(13, 124, 102, 0.42);
      background: rgba(13, 124, 102, 0.08);
    }

    .domain-head,
    .row {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
    }

    .domain-name,
    .card-title {
      margin: 0;
      font-weight: 700;
    }

    .meta {
      color: var(--muted);
      font-size: 13px;
    }

    .chip-list {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .chip {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border-radius: 999px;
      border: 1px solid var(--line);
      background: rgba(255,255,255,0.9);
      font-size: 13px;
      font-weight: 600;
    }

    .chip button {
      padding: 0;
      background: transparent;
      color: var(--danger);
    }

    .table {
      width: 100%;
      border-collapse: collapse;
      overflow: hidden;
      border-radius: 18px;
      background: var(--panel-strong);
      border: 1px solid var(--line);
    }

    .table th,
    .table td {
      text-align: left;
      padding: 12px 14px;
      border-bottom: 1px solid rgba(20, 35, 60, 0.08);
      font-size: 14px;
      vertical-align: top;
    }

    .table th {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }

    .message {
      min-height: 22px;
      font-size: 14px;
      font-weight: 600;
    }

    .message.success {
      color: var(--accent-dark);
    }

    .message.error {
      color: var(--danger);
    }

    .empty {
      padding: 22px;
      border-radius: 18px;
      border: 1px dashed var(--line);
      color: var(--muted);
      text-align: center;
      background: rgba(255,255,255,0.56);
    }

    .grid-two {
      display: grid;
      gap: 20px;
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .mono {
      font-family: "IBM Plex Mono", monospace;
      font-size: 13px;
    }

    @media (max-width: 1024px) {
      .layout,
      .grid-two {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <main class="shell">
    <section class="hero">
      <h1>Link Redirect Manager</h1>
      <p>为每个域名维护独立的跳转池。新 IP 首次访问时随机分配目标链接，以后固定命中同一子链接；同时支持国家代码封禁、访问日志和分配记录查询。</p>
      <div class="hero-grid">
        <div class="stat"><span class="meta">域名数量</span><strong id="stat-domains">0</strong></div>
        <div class="stat"><span class="meta">链接数量</span><strong id="stat-links">0</strong></div>
        <div class="stat"><span class="meta">IP 分配数</span><strong id="stat-assignments">0</strong></div>
        <div class="stat"><span class="meta">访问日志数</span><strong id="stat-logs">0</strong></div>
      </div>
    </section>

    <section class="layout">
      <aside class="stack">
        <div class="panel stack">
          <div>
            <h2>新建域名</h2>
            <p class="hint">域名是独立管理单元。链接池、国家限制和分配记录都按域名隔离。</p>
          </div>
          <div class="field">
            <label for="domain-name">域名</label>
            <input id="domain-name" placeholder="example.com">
          </div>
          <button class="primary" id="create-domain-btn">创建域名</button>
          <div id="domain-message" class="message"></div>
        </div>

        <div class="panel stack">
          <div class="toolbar">
            <h2>域名列表</h2>
            <button class="secondary" id="reload-domains-btn">刷新</button>
          </div>
          <div id="domains-list" class="domain-list"></div>
        </div>
      </aside>

      <section class="stack">
        <div class="panel stack">
          <div class="toolbar">
            <div>
              <h2 id="selected-domain-title">未选择域名</h2>
              <p class="hint" id="selected-domain-hint">先创建或选择一个域名，再管理链接和地区限制。</p>
            </div>
            <div class="row">
              <button class="secondary" id="copy-endpoint-btn">复制接口路径</button>
              <button class="danger" id="delete-domain-btn">删除域名</button>
            </div>
          </div>
          <div class="grid-two">
            <div class="stack">
              <h3>添加子链接</h3>
              <div class="field">
                <label for="link-order">顺序号</label>
                <input id="link-order" type="number" min="1" placeholder="1">
              </div>
              <div class="field">
                <label for="link-url">目标 URL</label>
                <input id="link-url" type="url" placeholder="https://target.example/path">
              </div>
              <button class="primary" id="add-link-btn">添加链接</button>
              <div id="link-message" class="message"></div>
            </div>
            <div class="stack">
              <h3>地区限制</h3>
              <div class="field">
                <label for="country-code">国家代码</label>
                <input id="country-code" maxlength="16" placeholder="CN / US / HK">
              </div>
              <button class="warning" id="add-country-btn">添加封禁国家</button>
              <div id="country-message" class="message"></div>
              <div id="countries-list" class="chip-list"></div>
            </div>
          </div>
        </div>

        <div class="panel stack">
          <div class="toolbar">
            <div>
              <h2>链接池</h2>
              <p class="hint">同一个域名下首次命中的 IP 会随机绑定到其中一个目标链接。</p>
            </div>
            <button class="secondary" id="reload-links-btn">刷新链接</button>
          </div>
          <div id="links-list" class="card-grid"></div>
        </div>

        <div class="panel stack">
          <div class="toolbar">
            <div>
              <h2>IP 分配记录</h2>
              <p class="hint">这里展示每个域名下 IP 到目标子链接的固定绑定。</p>
            </div>
            <button class="secondary" id="reload-assignments-btn">刷新记录</button>
          </div>
          <div id="assignments-table"></div>
        </div>

        <div class="panel stack">
          <div class="toolbar">
            <div>
              <h2>访问日志</h2>
              <p class="hint">记录允许访问、首次分配、复用绑定、国家拦截和域名不存在等事件。</p>
            </div>
            <button class="secondary" id="reload-logs-btn">刷新日志</button>
          </div>
          <div id="logs-table"></div>
        </div>
      </section>
    </section>
  </main>

  <script>
    const state = {
      domains: [],
      selectedDomainId: null,
      selectedDomainName: '',
      stats: { domains: 0, links: 0, assignments: 0, logs: 0 }
    };

    function setMessage(id, text, type) {
      const el = document.getElementById(id);
      el.textContent = text || '';
      el.className = 'message' + (type ? ' ' + type : '');
    }

    function requireDomain() {
      if (state.selectedDomainId) {
        return true;
      }

      setMessage('link-message', '请先选择域名', 'error');
      setMessage('country-message', '请先选择域名', 'error');
      return false;
    }

    function formatDate(value) {
      return value ? new Date(value).toLocaleString() : '-';
    }

    function escapeHtml(value) {
      return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }

    async function api(path, options) {
      const res = await fetch(path, {
        headers: { 'Content-Type': 'application/json', ...(options && options.headers ? options.headers : {}) },
        ...options
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Request failed');
      }
      return data;
    }

    function updateStats(stats) {
      state.stats = stats;
      document.getElementById('stat-domains').textContent = String(stats.domains || 0);
      document.getElementById('stat-links').textContent = String(stats.links || 0);
      document.getElementById('stat-assignments').textContent = String(stats.assignments || 0);
      document.getElementById('stat-logs').textContent = String(stats.logs || 0);
    }

    async function loadOverview() {
      const overview = await api('/api/overview');
      updateStats(overview.stats);
      state.domains = overview.domains;

      if (!state.selectedDomainId && state.domains.length > 0) {
        state.selectedDomainId = state.domains[0].id;
        state.selectedDomainName = state.domains[0].domain_name;
      }

      if (state.selectedDomainId) {
        const match = state.domains.find((domain) => domain.id === state.selectedDomainId);
        if (!match) {
          state.selectedDomainId = state.domains[0] ? state.domains[0].id : null;
          state.selectedDomainName = state.domains[0] ? state.domains[0].domain_name : '';
        } else {
          state.selectedDomainName = match.domain_name;
        }
      }

      renderDomains();
      renderSelectedDomain();

      if (state.selectedDomainId) {
        await loadDomainData();
      } else {
        renderLinks([]);
        renderAssignments([]);
        renderLogs([]);
        renderCountries([]);
      }
    }

    function renderDomains() {
      const wrap = document.getElementById('domains-list');

      if (!state.domains.length) {
        wrap.innerHTML = '<div class="empty">还没有域名，先创建一个。</div>';
        return;
      }

      wrap.innerHTML = state.domains.map((domain) => {
        const active = domain.id === state.selectedDomainId ? ' active' : '';
        return `
          <div class="domain-item${active}">
            <div class="domain-head">
              <button class="secondary" data-domain-id="${domain.id}" data-domain-name="${escapeHtml(domain.domain_name)}">${escapeHtml(domain.domain_name)}</button>
              <span class="meta">${domain.link_count} 链接</span>
            </div>
            <div class="meta">${domain.blocked_country_count} 个国家限制 · ${domain.assignment_count} 个 IP 绑定</div>
          </div>
        `;
      }).join('');

      wrap.querySelectorAll('[data-domain-id]').forEach((button) => {
        button.addEventListener('click', () => {
          state.selectedDomainId = Number(button.getAttribute('data-domain-id'));
          state.selectedDomainName = button.getAttribute('data-domain-name') || '';
          renderDomains();
          renderSelectedDomain();
          loadDomainData().catch((error) => {
            setMessage('link-message', error.message, 'error');
          });
        });
      });
    }

    function renderSelectedDomain() {
      const title = document.getElementById('selected-domain-title');
      const hint = document.getElementById('selected-domain-hint');

      if (!state.selectedDomainId) {
        title.textContent = '未选择域名';
        hint.textContent = '先创建或选择一个域名，再管理链接和地区限制。';
        return;
      }

      title.textContent = state.selectedDomainName;
      hint.textContent = '/api/redirect/' + state.selectedDomainName + ' 是该域名的重定向入口。';
    }

    async function loadDomainData() {
      if (!state.selectedDomainId) {
        return;
      }

      const [links, assignments, logs, countries] = await Promise.all([
        api('/api/links?domain_id=' + state.selectedDomainId),
        api('/api/assignments?domain_id=' + state.selectedDomainId),
        api('/api/access-logs?domain_id=' + state.selectedDomainId),
        api('/api/blocked-countries?domain_id=' + state.selectedDomainId)
      ]);

      renderLinks(links);
      renderAssignments(assignments);
      renderLogs(logs);
      renderCountries(countries);
    }

    function renderLinks(links) {
      const wrap = document.getElementById('links-list');
      if (!links.length) {
        wrap.innerHTML = '<div class="empty">当前域名还没有子链接。</div>';
        return;
      }

      wrap.innerHTML = links.map((link) => `
        <div class="card-item">
          <div class="row">
            <p class="card-title">#${link.order_num}</p>
            <button class="danger" data-delete-link="${link.id}">删除</button>
          </div>
          <p class="mono">${escapeHtml(link.target_url)}</p>
          <p class="meta">创建时间 ${formatDate(link.created_at)}</p>
        </div>
      `).join('');

      wrap.querySelectorAll('[data-delete-link]').forEach((button) => {
        button.addEventListener('click', async () => {
          if (!confirm('确定删除这个子链接吗？已有的 IP 绑定和日志会被级联删除。')) {
            return;
          }

          try {
            await api('/api/links/' + button.getAttribute('data-delete-link'), { method: 'DELETE' });
            await loadOverview();
          } catch (error) {
            setMessage('link-message', error.message, 'error');
          }
        });
      });
    }

    function renderCountries(countries) {
      const wrap = document.getElementById('countries-list');
      if (!countries.length) {
        wrap.innerHTML = '<div class="empty">当前域名没有地区限制。</div>';
        return;
      }

      wrap.innerHTML = countries.map((country) => `
        <span class="chip">
          ${escapeHtml(country.country_code)}
          <button title="删除" data-delete-country="${escapeHtml(country.country_code)}">×</button>
        </span>
      `).join('');

      wrap.querySelectorAll('[data-delete-country]').forEach((button) => {
        button.addEventListener('click', async () => {
          try {
            const countryCode = button.getAttribute('data-delete-country');
            await api('/api/blocked-countries/' + encodeURIComponent(countryCode), {
              method: 'DELETE',
              headers: { 'X-Domain-Id': String(state.selectedDomainId) }
            });
            setMessage('country-message', '已删除国家限制', 'success');
            await loadOverview();
          } catch (error) {
            setMessage('country-message', error.message, 'error');
          }
        });
      });
    }

    function renderAssignments(assignments) {
      const wrap = document.getElementById('assignments-table');
      if (!assignments.length) {
        wrap.innerHTML = '<div class="empty">当前域名还没有 IP 分配记录。</div>';
        return;
      }

      wrap.innerHTML = `
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>IP</th>
                <th>国家</th>
                <th>绑定顺序号</th>
                <th>目标 URL</th>
                <th>首次分配时间</th>
              </tr>
            </thead>
            <tbody>
              ${assignments.map((item) => `
                <tr>
                  <td class="mono">${escapeHtml(item.ip_address)}</td>
                  <td>${escapeHtml(item.country_code || 'unknown')}</td>
                  <td>#${item.order_num}</td>
                  <td class="mono">${escapeHtml(item.target_url)}</td>
                  <td>${formatDate(item.assigned_at)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    }

    function renderLogs(logs) {
      const wrap = document.getElementById('logs-table');
      if (!logs.length) {
        wrap.innerHTML = '<div class="empty">当前域名还没有访问日志。</div>';
        return;
      }

      wrap.innerHTML = `
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>时间</th>
                <th>IP</th>
                <th>国家</th>
                <th>事件</th>
                <th>状态</th>
                <th>详情</th>
              </tr>
            </thead>
            <tbody>
              ${logs.map((log) => `
                <tr>
                  <td>${formatDate(log.created_at)}</td>
                  <td class="mono">${escapeHtml(log.ip_address)}</td>
                  <td>${escapeHtml(log.country_code || 'unknown')}</td>
                  <td>${escapeHtml(log.event_type)}</td>
                  <td>${log.status_code}</td>
                  <td>${escapeHtml(log.detail || '-')}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    }

    document.getElementById('create-domain-btn').addEventListener('click', async () => {
      const input = document.getElementById('domain-name');
      const domainName = input.value.trim();
      if (!domainName) {
        setMessage('domain-message', '请输入域名', 'error');
        return;
      }

      try {
        const domain = await api('/api/domains', {
          method: 'POST',
          body: JSON.stringify({ domain_name: domainName })
        });
        input.value = '';
        state.selectedDomainId = domain.id;
        state.selectedDomainName = domain.domain_name;
        setMessage('domain-message', '域名已创建', 'success');
        await loadOverview();
      } catch (error) {
        setMessage('domain-message', error.message, 'error');
      }
    });

    document.getElementById('add-link-btn').addEventListener('click', async () => {
      if (!requireDomain()) {
        return;
      }

      const orderInput = document.getElementById('link-order');
      const urlInput = document.getElementById('link-url');
      const orderNum = Number(orderInput.value);
      const targetUrl = urlInput.value.trim();

      if (!orderNum || !targetUrl) {
        setMessage('link-message', '请填写顺序号和目标 URL', 'error');
        return;
      }

      try {
        await api('/api/links', {
          method: 'POST',
          body: JSON.stringify({
            domain_id: state.selectedDomainId,
            order_num: orderNum,
            target_url: targetUrl
          })
        });
        orderInput.value = '';
        urlInput.value = '';
        setMessage('link-message', '链接已添加', 'success');
        await loadOverview();
      } catch (error) {
        setMessage('link-message', error.message, 'error');
      }
    });

    document.getElementById('add-country-btn').addEventListener('click', async () => {
      if (!requireDomain()) {
        return;
      }

      const input = document.getElementById('country-code');
      const countryCode = input.value.trim();

      if (!countryCode) {
        setMessage('country-message', '请输入国家代码', 'error');
        return;
      }

      try {
        await api('/api/blocked-countries', {
          method: 'POST',
          body: JSON.stringify({ domain_id: state.selectedDomainId, country_code: countryCode })
        });
        input.value = '';
        setMessage('country-message', '国家限制已添加', 'success');
        await loadOverview();
      } catch (error) {
        setMessage('country-message', error.message, 'error');
      }
    });

    document.getElementById('delete-domain-btn').addEventListener('click', async () => {
      if (!state.selectedDomainId) {
        setMessage('domain-message', '没有可删除的域名', 'error');
        return;
      }

      if (!confirm('删除域名会同时删除它的链接、分配记录、地区限制和访问日志，确定继续吗？')) {
        return;
      }

      try {
        await api('/api/domains/' + state.selectedDomainId, { method: 'DELETE' });
        setMessage('domain-message', '域名已删除', 'success');
        state.selectedDomainId = null;
        state.selectedDomainName = '';
        await loadOverview();
      } catch (error) {
        setMessage('domain-message', error.message, 'error');
      }
    });

    document.getElementById('copy-endpoint-btn').addEventListener('click', async () => {
      if (!state.selectedDomainName) {
        setMessage('domain-message', '请先选择域名', 'error');
        return;
      }

      const endpoint = location.origin + '/api/redirect/' + state.selectedDomainName;
      try {
        await navigator.clipboard.writeText(endpoint);
        setMessage('domain-message', '接口路径已复制', 'success');
      } catch {
        setMessage('domain-message', endpoint, 'success');
      }
    });

    document.getElementById('reload-domains-btn').addEventListener('click', () => loadOverview().catch((error) => setMessage('domain-message', error.message, 'error')));
    document.getElementById('reload-links-btn').addEventListener('click', () => loadDomainData().catch((error) => setMessage('link-message', error.message, 'error')));
    document.getElementById('reload-assignments-btn').addEventListener('click', () => loadDomainData().catch((error) => setMessage('link-message', error.message, 'error')));
    document.getElementById('reload-logs-btn').addEventListener('click', () => loadDomainData().catch((error) => setMessage('link-message', error.message, 'error')));

    loadOverview().catch((error) => {
      setMessage('domain-message', error.message, 'error');
    });
  </script>
</body>
</html>`;
}

function parseJsonBody<T>(req: Request): Promise<T> {
  return req.json() as Promise<T>;
}

async function handleOverview(sql: SqlClient): Promise<Response> {
  const domains = await sql`
    SELECT
      d.id,
      d.domain_name,
      d.created_at,
      COUNT(DISTINCT l.id) AS link_count,
      COUNT(DISTINCT ia.id) AS assignment_count,
      COUNT(DISTINCT bc.id) AS blocked_country_count
    FROM domains d
    LEFT JOIN links l ON l.domain_id = d.id
    LEFT JOIN ip_assignments ia ON ia.domain_id = d.id
    LEFT JOIN blocked_countries bc ON bc.domain_id = d.id
    GROUP BY d.id
    ORDER BY d.created_at DESC
  `;

  const [linkCountResult, assignmentCountResult, logCountResult] = await Promise.all([
    sql`SELECT COUNT(*)::int AS count FROM links`,
    sql`SELECT COUNT(*)::int AS count FROM ip_assignments`,
    sql`SELECT COUNT(*)::int AS count FROM access_logs`,
  ]);

  return jsonResponse({
    stats: {
      domains: domains.length,
      links: linkCountResult[0]?.count ?? 0,
      assignments: assignmentCountResult[0]?.count ?? 0,
      logs: logCountResult[0]?.count ?? 0,
    },
    domains,
  });
}

async function handleCreateDomain(req: Request, sql: SqlClient): Promise<Response> {
  const body = await parseJsonBody<{ domain_name?: string }>(req);
  const domainName = body.domain_name?.trim().toLowerCase();

  if (!domainName) {
    return jsonResponse({ error: "domain_name is required" }, 400);
  }

  const result = await sql`
    INSERT INTO domains (domain_name)
    VALUES (${domainName})
    ON CONFLICT (domain_name) DO NOTHING
    RETURNING *
  `;

  if (!result[0]) {
    return jsonResponse({ error: "Domain already exists" }, 409);
  }

  return jsonResponse(result[0], 201);
}

async function handleDeleteDomain(domainId: number, sql: SqlClient): Promise<Response> {
  const result = await sql`
    DELETE FROM domains WHERE id = ${domainId}
    RETURNING id
  `;

  if (!result[0]) {
    return jsonResponse({ error: "Domain not found" }, 404);
  }

  return jsonResponse({ success: true });
}

async function handleCreateLink(req: Request, sql: SqlClient): Promise<Response> {
  const body = await parseJsonBody<{
    domain_id?: number;
    order_num?: number;
    target_url?: string;
  }>(req);

  const domainId = Number(body.domain_id);
  const orderNum = Number(body.order_num);
  const targetUrl = body.target_url?.trim();

  if (!domainId || !orderNum || !targetUrl) {
    return jsonResponse({ error: "domain_id, order_num and target_url are required" }, 400);
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
    return jsonResponse({ error: "Failed to create link. Check domain existence and uniqueness." }, 400);
  }
}

async function handleListLinks(url: URL, sql: SqlClient): Promise<Response> {
  const domainId = Number(url.searchParams.get("domain_id"));

  if (domainId) {
    const links = await sql`
      SELECT l.*, d.domain_name
      FROM links l
      JOIN domains d ON d.id = l.domain_id
      WHERE l.domain_id = ${domainId}
      ORDER BY l.order_num ASC, l.created_at ASC
    `;
    return jsonResponse(links);
  }

  const links = await sql`
    SELECT l.*, d.domain_name
    FROM links l
    JOIN domains d ON d.id = l.domain_id
    ORDER BY d.domain_name ASC, l.order_num ASC, l.created_at ASC
  `;
  return jsonResponse(links);
}

async function handleDeleteLink(linkId: number, sql: SqlClient): Promise<Response> {
  const result = await sql`
    DELETE FROM links WHERE id = ${linkId}
    RETURNING id
  `;

  if (!result[0]) {
    return jsonResponse({ error: "Link not found" }, 404);
  }

  return jsonResponse({ success: true });
}

async function handleListAssignments(url: URL, sql: SqlClient): Promise<Response> {
  const domainId = Number(url.searchParams.get("domain_id"));

  const records = domainId
    ? await sql`
        SELECT ia.*, l.order_num, l.target_url, d.domain_name
        FROM ip_assignments ia
        JOIN links l ON l.id = ia.link_id
        JOIN domains d ON d.id = ia.domain_id
        WHERE ia.domain_id = ${domainId}
        ORDER BY ia.assigned_at DESC
      `
    : await sql`
        SELECT ia.*, l.order_num, l.target_url, d.domain_name
        FROM ip_assignments ia
        JOIN links l ON l.id = ia.link_id
        JOIN domains d ON d.id = ia.domain_id
        ORDER BY ia.assigned_at DESC
      `;

  return jsonResponse(records);
}

async function handleListBlockedCountries(url: URL, sql: SqlClient): Promise<Response> {
  const domainId = Number(url.searchParams.get("domain_id"));

  if (!domainId) {
    return jsonResponse({ error: "domain_id is required" }, 400);
  }

  const rows = await sql`
    SELECT country_code, created_at
    FROM blocked_countries
    WHERE domain_id = ${domainId}
    ORDER BY country_code ASC
  `;

  return jsonResponse(rows);
}

async function handleCreateBlockedCountry(req: Request, sql: SqlClient): Promise<Response> {
  const body = await parseJsonBody<{ domain_id?: number; country_code?: string }>(req);
  const domainId = Number(body.domain_id);
  const countryCode = normalizeCountryCode(body.country_code || "");

  if (!domainId || !countryCode) {
    return jsonResponse({ error: "domain_id and country_code are required" }, 400);
  }

  try {
    const result = await sql`
      INSERT INTO blocked_countries (domain_id, country_code)
      VALUES (${domainId}, ${countryCode})
      ON CONFLICT (domain_id, country_code) DO NOTHING
      RETURNING *
    `;

    if (!result[0]) {
      return jsonResponse({ error: "Country is already blocked for this domain" }, 409);
    }

    return jsonResponse(result[0], 201);
  } catch (error) {
    console.error("Create blocked country error:", error);
    return jsonResponse({ error: "Failed to add blocked country" }, 400);
  }
}

async function handleDeleteBlockedCountry(req: Request, countryCodeRaw: string, sql: SqlClient): Promise<Response> {
  const domainId = Number(req.headers.get("x-domain-id"));
  const countryCode = normalizeCountryCode(decodeURIComponent(countryCodeRaw));

  if (!domainId || !countryCode) {
    return jsonResponse({ error: "Domain header and country code are required" }, 400);
  }

  const result = await sql`
    DELETE FROM blocked_countries
    WHERE domain_id = ${domainId} AND country_code = ${countryCode}
    RETURNING id
  `;

  if (!result[0]) {
    return jsonResponse({ error: "Blocked country not found" }, 404);
  }

  return jsonResponse({ success: true });
}

async function handleListAccessLogs(url: URL, sql: SqlClient): Promise<Response> {
  const domainId = Number(url.searchParams.get("domain_id"));

  const rows = domainId
    ? await sql`
        SELECT al.*, d.domain_name, l.order_num, l.target_url
        FROM access_logs al
        JOIN domains d ON d.id = al.domain_id
        LEFT JOIN links l ON l.id = al.link_id
        WHERE al.domain_id = ${domainId}
        ORDER BY al.created_at DESC
        LIMIT 200
      `
    : await sql`
        SELECT al.*, d.domain_name, l.order_num, l.target_url
        FROM access_logs al
        JOIN domains d ON d.id = al.domain_id
        LEFT JOIN links l ON l.id = al.link_id
        ORDER BY al.created_at DESC
        LIMIT 200
      `;

  return jsonResponse(rows);
}

async function handleRedirect(
  domainNameRaw: string,
  req: Request,
  sql: SqlClient,
  responseMode: "json" | "http" = "json"
): Promise<Response> {
  const domainName = decodeURIComponent(domainNameRaw).trim().toLowerCase();
  const domain = await resolveDomain(sql, domainName);
  const clientIP = getClientIP(req);
  const countryCode = await getCountryFromIP(clientIP);

  if (!domain) {
    return jsonResponse({ error: "Domain not found" }, 404);
  }

  const blockedCountry = await sql`
    SELECT id FROM blocked_countries
    WHERE domain_id = ${domain.id} AND country_code = ${countryCode}
  `;

  if (blockedCountry[0]) {
    await writeAccessLog(sql, {
      domainId: domain.id,
      ipAddress: clientIP,
      countryCode,
      eventType: "country_blocked",
      statusCode: 403,
      detail: `Blocked by country policy for ${countryCode}`,
    });

    return jsonResponse({ error: "Access denied from your country" }, 403);
  }

  const existingAssignment = await sql`
    SELECT ia.link_id, l.order_num, l.target_url
    FROM ip_assignments ia
    JOIN links l ON l.id = ia.link_id
    WHERE ia.domain_id = ${domain.id} AND ia.ip_address = ${clientIP}
  `;

  let assignedLink: LinkRow | null = null;
  let eventType = "assignment_reused";
  let detail = "Existing IP assignment reused";

  if (existingAssignment[0]) {
    assignedLink = {
      id: existingAssignment[0].link_id,
      domain_id: domain.id,
      domain_name: domain.domain_name,
      order_num: existingAssignment[0].order_num,
      target_url: existingAssignment[0].target_url,
      created_at: "",
    };
  } else {
    const allLinks = await sql`
      SELECT l.*, d.domain_name
      FROM links l
      JOIN domains d ON d.id = l.domain_id
      WHERE l.domain_id = ${domain.id}
      ORDER BY l.order_num ASC, l.created_at ASC
    `;

    if (!allLinks.length) {
      await writeAccessLog(sql, {
        domainId: domain.id,
        ipAddress: clientIP,
        countryCode,
        eventType: "missing_links",
        statusCode: 404,
        detail: "Domain has no links configured",
      });

      return jsonResponse({ error: "No links available" }, 404);
    }

    assignedLink = allLinks[Math.floor(Math.random() * allLinks.length)];
    eventType = "assignment_created";
    detail = `Assigned IP to order ${assignedLink.order_num}`;

    await sql`
      INSERT INTO ip_assignments (domain_id, link_id, ip_address, country_code)
      VALUES (${domain.id}, ${assignedLink.id}, ${clientIP}, ${countryCode})
      ON CONFLICT (domain_id, ip_address)
      DO UPDATE SET link_id = EXCLUDED.link_id, country_code = EXCLUDED.country_code
    `;
  }

  await writeAccessLog(sql, {
    domainId: domain.id,
    linkId: assignedLink.id,
    ipAddress: clientIP,
    countryCode,
    eventType,
    statusCode: 200,
    detail,
  });

  if (responseMode === "http") {
    return Response.redirect(assignedLink.target_url, 302);
  }

  return jsonResponse({
    url: assignedLink.target_url,
    order: assignedLink.order_num,
    message: "This IP is locked to this link",
  });
}

async function tryDomainHostRedirect(path: string, req: Request, sql: SqlClient): Promise<Response | null> {
  if (path.startsWith("/api")) {
    return null;
  }

  const host = normalizeHostToDomain(getRequestHost(req));
  if (!host) {
    return null;
  }

  const domain = await resolveDomain(sql, host);
  if (!domain) {
    return null;
  }

  return handleRedirect(host, req, sql, "http");
}

await initDB();

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;
  const sql = Bun.sql;

  try {
    const hostRedirect = await tryDomainHostRedirect(path, req, sql);
    if (hostRedirect) {
      return hostRedirect;
    }

    if (path === "/admin" && method === "GET") {
      return new Response(getAdminHTML(), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (path === "/" && method === "GET") {
      return new Response(getAdminHTML(), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (path === "/api/overview" && method === "GET") {
      return handleOverview(sql);
    }

    if (path === "/api/domains" && method === "POST") {
      return handleCreateDomain(req, sql);
    }

    const domainMatch = path.match(/^\/api\/domains\/(\d+)$/);
    if (domainMatch && method === "DELETE") {
      return handleDeleteDomain(Number(domainMatch[1]), sql);
    }

    if (path === "/api/links" && method === "POST") {
      return handleCreateLink(req, sql);
    }

    if (path === "/api/links" && method === "GET") {
      return handleListLinks(url, sql);
    }

    const deleteLinkMatch = path.match(/^\/api\/links\/(\d+)$/);
    if (deleteLinkMatch && method === "DELETE") {
      return handleDeleteLink(Number(deleteLinkMatch[1]), sql);
    }

    if (path === "/api/assignments" && method === "GET") {
      return handleListAssignments(url, sql);
    }

    if (path === "/api/blocked-countries" && method === "GET") {
      return handleListBlockedCountries(url, sql);
    }

    if (path === "/api/blocked-countries" && method === "POST") {
      return handleCreateBlockedCountry(req, sql);
    }

    const deleteCountryMatch = path.match(/^\/api\/blocked-countries\/(.+)$/);
    if (deleteCountryMatch && method === "DELETE") {
      return handleDeleteBlockedCountry(req, deleteCountryMatch[1], sql);
    }

    if (path === "/api/access-logs" && method === "GET") {
      return handleListAccessLogs(url, sql);
    }

    const redirectMatch = path.match(/^\/api\/redirect\/(.+)$/);
    if (redirectMatch && method === "GET") {
      return handleRedirect(redirectMatch[1], req, sql);
    }

    return jsonResponse({ error: "Not found" }, 404);
  } catch (error) {
    console.error("Request error:", error);
    return jsonResponse({ error: "Internal server error" }, 500);
  }
}

Bun.serve({
  port: PORT,
  fetch: handleRequest,
});

console.log(`Link Redirect Manager running on port ${PORT}`);
