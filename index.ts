/// <reference types="bun" />

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

type DomainRotationRow = {
  domain_id: number;
  next_link_index: number;
  updated_at: string;
};

const COUNTRY_OPTIONS = [
  { code: "US", name: "美国" },
  { code: "JP", name: "日本" },
  { code: "TW", name: "台湾" },
  { code: "HK", name: "香港" },
  { code: "SG", name: "新加坡" },
  { code: "TH", name: "泰国" },
  { code: "VN", name: "越南" },
  { code: "MY", name: "马来西亚" },
  { code: "CN", name: "中国大陆" },
  { code: "KR", name: "韩国" },
  { code: "GB", name: "英国" },
  { code: "CA", name: "加拿大" },
  { code: "AU", name: "澳大利亚" },
  { code: "DE", name: "德国" },
  { code: "FR", name: "法国" },
  { code: "IN", name: "印度" },
  { code: "BR", name: "巴西" },
  { code: "RU", name: "俄罗斯" },
  { code: "PH", name: "菲律宾" },
  { code: "ID", name: "印度尼西亚" },
  { code: "MX", name: "墨西哥" },
  { code: "IT", name: "意大利" },
  { code: "ES", name: "西班牙" },
  { code: "NL", name: "荷兰" },
  { code: "SE", name: "瑞典" },
  { code: "NO", name: "挪威" },
  { code: "DK", name: "丹麦" },
  { code: "FI", name: "芬兰" },
  { code: "PL", name: "波兰" },
  { code: "TR", name: "土耳其" },
  { code: "SA", name: "沙特阿拉伯" },
  { code: "AE", name: "阿联酋" },
  { code: "ZA", name: "南非" },
] as const;

const COUNTRY_NAME_BY_CODE = Object.fromEntries(COUNTRY_OPTIONS.map((item) => [item.code, item.name]));

export {};

const PORT = Number(Bun.env.PORT || 8000);
const HAS_DATABASE_URL = Boolean(Bun.env.DATABASE_URL);
const CLOUDFLARE_API_TOKEN = Bun.env.CLOUDFLARE_API_TOKEN || "";
const CLOUDFLARE_API_BASE = Bun.env.CLOUDFLARE_API_BASE || "https://api.cloudflare.com/client/v4";
const CLOUDFLARE_ZONE_ID = Bun.env.CLOUDFLARE_ZONE_ID || "";
const CLOUDFLARE_DNS_TARGET = Bun.env.CLOUDFLARE_DNS_TARGET || "";
const CLOUDFLARE_DNS_PROXIED = (Bun.env.CLOUDFLARE_DNS_PROXIED || "true").toLowerCase() === "true";
const CLOUDFLARE_TOKEN_CONFIGURED = Boolean(CLOUDFLARE_API_TOKEN);
const CLOUDFLARE_AUTO_DNS_ENABLED = Boolean(CLOUDFLARE_API_TOKEN && CLOUDFLARE_DNS_TARGET);
const CLOUDFLARE_ZONE_CACHE = new Map<string, string>();
const APP_VERSION =
  Bun.env.RAILWAY_GIT_COMMIT_SHA ||
  Bun.env.VERCEL_GIT_COMMIT_SHA ||
  Bun.env.RENDER_GIT_COMMIT ||
  Bun.env.COMMIT_SHA ||
  "local-dev";

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

function normalizeDomainInput(domainInput: string): string {
  const trimmed = domainInput.trim().toLowerCase();

  if (!trimmed) {
    return "";
  }

  try {
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      return normalizeHostToDomain(new URL(trimmed).hostname);
    }

    if (trimmed.startsWith("//")) {
      return normalizeHostToDomain(new URL(`https:${trimmed}`).hostname);
    }
  } catch {
    // Fall through to hostname-style parsing below.
  }

  return normalizeHostToDomain(trimmed.replace(/^https?:\/\//, ""));
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

function decodeUnicodeEscapes(input: string): string {
  return input.replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getCountryDisplayName(code: string): string {
  const normalizedCode = String(code || "").trim().toUpperCase();
  if (!normalizedCode) {
    return "未知";
  }

  return COUNTRY_NAME_BY_CODE[normalizedCode as keyof typeof COUNTRY_NAME_BY_CODE] || normalizedCode;
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
      CREATE TABLE IF NOT EXISTS domain_rotations (
        domain_id INTEGER PRIMARY KEY REFERENCES domains(id) ON DELETE CASCADE,
        next_link_index INTEGER NOT NULL DEFAULT 1,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
  const normalizedTarget = normalizeDomainInput(domainName);
  if (!normalizedTarget) {
    return null;
  }

  const result = await sql`SELECT * FROM domains ORDER BY created_at DESC`;
  return (
    (result as DomainRow[]).find((row) => normalizeDomainInput(row.domain_name) === normalizedTarget) ?? null
  );
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

async function verifyCloudflareApiToken(): Promise<{
  valid: boolean;
  message: string;
  expiresOn?: string | null;
  notBefore?: string | null;
}> {
  if (!CLOUDFLARE_TOKEN_CONFIGURED) {
    return { valid: false, message: "CLOUDFLARE_API_TOKEN not set" };
  }

  if (CLOUDFLARE_ZONE_ID) {
    try {
      const response = await fetch(
        `${CLOUDFLARE_API_BASE}/zones/${encodeURIComponent(CLOUDFLARE_ZONE_ID)}/dns_records?per_page=1`,
        {
          headers: {
            Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
            "Content-Type": "application/json",
          },
        }
      );

      const data = await response.json().catch(() => ({} as Record<string, unknown>));
      const success = Boolean((data as { success?: boolean }).success);
      const errorMessage = (data as { errors?: Array<{ message?: string }> }).errors?.[0]?.message;

      if (response.ok && success) {
        return {
          valid: true,
          message: "Token is active and has access to configured zone DNS",
        };
      }

      return {
        valid: false,
        message: errorMessage || "Token cannot access configured zone DNS",
      };
    } catch (error) {
      console.error("Cloudflare zone permission verify failed:", error);
      return { valid: false, message: "Unable to verify token against configured zone" };
    }
  }

  try {
    const response = await fetch(`${CLOUDFLARE_API_BASE}/user/tokens/verify`, {
      headers: {
        Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
    });

    const data = await response.json().catch(() => ({} as Record<string, unknown>));
    const success = Boolean((data as { success?: boolean }).success);
    const result = (data as {
      result?: { status?: string; expires_on?: string; not_before?: string };
      errors?: Array<{ message?: string }>;
    }).result;
    const errorMessage = (data as { errors?: Array<{ message?: string }> }).errors?.[0]?.message;

    const active = success && result?.status === "active";
    return {
      valid: active,
      message: active ? "Token is active" : (errorMessage || "Token is invalid or inactive"),
      expiresOn: result?.expires_on ?? null,
      notBefore: result?.not_before ?? null,
    };
  } catch (error) {
    console.error("Cloudflare token verify failed:", error);
    return { valid: false, message: "Unable to verify token" };
  }
}

async function handleCloudflareTokenStatus(): Promise<Response> {
  const verified = await verifyCloudflareApiToken();
  return jsonResponse({
    configured: CLOUDFLARE_TOKEN_CONFIGURED,
    valid: verified.valid,
    message: verified.message,
    expiresOn: verified.expiresOn ?? null,
    notBefore: verified.notBefore ?? null,
    autoDnsEnabled: CLOUDFLARE_AUTO_DNS_ENABLED,
    zoneIdConfigured: Boolean(CLOUDFLARE_ZONE_ID),
    dnsTargetConfigured: Boolean(CLOUDFLARE_DNS_TARGET),
    dnsTarget: CLOUDFLARE_DNS_TARGET || null,
  });
}

async function cloudflareApiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${CLOUDFLARE_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });

  const data = await response.json().catch(() => ({} as Record<string, unknown>));
  const payload = data as {
    success?: boolean;
    errors?: Array<{ message?: string }>;
  };

  if (!response.ok || !payload.success) {
    const message = payload.errors?.[0]?.message || `Cloudflare API request failed: ${path}`;
    throw new Error(message);
  }

  return data as T;
}

type CloudflareZone = { id: string; name: string };
type CloudflareZonesResponse = { result: CloudflareZone[] };

async function resolveCloudflareZoneId(domainName: string): Promise<string> {
  const normalizedDomain = normalizeDomainInput(domainName);
  if (!normalizedDomain) {
    throw new Error("domainName is required");
  }

  const cachedZoneId = CLOUDFLARE_ZONE_CACHE.get(normalizedDomain);
  if (cachedZoneId) {
    return cachedZoneId;
  }

  if (CLOUDFLARE_ZONE_ID) {
    const zone = await cloudflareApiRequest<{ result: CloudflareZone }>(
      `/zones/${encodeURIComponent(CLOUDFLARE_ZONE_ID)}`
    );
    const zoneName = normalizeDomainInput(zone.result?.name || "");

    if (zoneName !== normalizedDomain) {
      throw new Error(
        `Configured CLOUDFLARE_ZONE_ID belongs to ${zone.result?.name || "unknown"}, not ${normalizedDomain}. Remove CLOUDFLARE_ZONE_ID to auto-discover zones per domain.`
      );
    }

    CLOUDFLARE_ZONE_CACHE.set(normalizedDomain, zone.result.id);
    return zone.result.id;
  }

  const response = await cloudflareApiRequest<CloudflareZonesResponse>(
    `/zones?name=${encodeURIComponent(normalizedDomain)}&status=active&per_page=1`
  );

  const zoneId = response.result?.[0]?.id;
  if (!zoneId) {
    throw new Error(`No active Cloudflare zone found for ${normalizedDomain}`);
  }

  CLOUDFLARE_ZONE_CACHE.set(normalizedDomain, zoneId);
  return zoneId;
}

async function syncCloudflareCnameRecord(domainName: string): Promise<{ synced: boolean; message: string }> {
  if (!CLOUDFLARE_AUTO_DNS_ENABLED) {
    return {
      synced: false,
      message: "Auto DNS sync skipped (missing CLOUDFLARE_API_TOKEN or CLOUDFLARE_DNS_TARGET)",
    };
  }

  type CloudflareDnsRecord = { id: string; type: string };
  type CloudflareListResponse = { result: CloudflareDnsRecord[] };
  const zoneId = await resolveCloudflareZoneId(domainName);

  const syncableTypes = new Set(["A", "AAAA", "CNAME"]);
  const body = JSON.stringify({
    type: "CNAME",
    name: domainName,
    content: CLOUDFLARE_DNS_TARGET,
    proxied: CLOUDFLARE_DNS_PROXIED,
    ttl: 1,
  });

  async function deleteConflictingRecords() {
    const freshList = await cloudflareApiRequest<CloudflareListResponse>(
      `/zones/${encodeURIComponent(zoneId)}/dns_records?name=${encodeURIComponent(domainName)}&per_page=100`
    );
    const conflictingRecords = (freshList.result || []).filter((record) => syncableTypes.has(record.type));

    for (const record of conflictingRecords) {
      await cloudflareApiRequest(
        `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(record.id)}`,
        {
          method: "DELETE",
        }
      );
    }
  }

  async function createWithRetry() {
    let lastError: unknown = null;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await deleteConflictingRecords();

        await cloudflareApiRequest(`/zones/${encodeURIComponent(zoneId)}/dns_records`, {
          method: "POST",
          body,
        });

        return { synced: true, message: attempt === 0 ? "Cloudflare DNS record created" : "Cloudflare DNS record created after retry" };
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);

        if (!/same host already exists|already exists/i.test(message) || attempt === 2) {
          throw error;
        }

        await delay(400 * (attempt + 1));
      }
    }

    throw lastError instanceof Error ? lastError : new Error("Cloudflare DNS sync failed");
  }

  return createWithRetry();
}

function getAdminHTML(): string {
  return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>暴富的小张</title>
  <style>
    :root {
      --bg: radial-gradient(circle at 20% -20%, #172858 0%, #090d18 45%, #05070f 100%);
      --panel: #0f1727;
      --panel-soft: #121e33;
      --line: rgba(118, 146, 214, 0.2);
      --text: #e8edff;
      --muted: #8fa0c9;
      --primary: #3a66ff;
      --primary-strong: #2147c8;
      --green: #00c886;
      --warn: #f4a63d;
      --danger: #ff5f73;
      --shadow: 0 18px 48px rgba(2, 7, 22, 0.55);
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
      font-family: "IBM Plex Sans", "Noto Sans SC", sans-serif;
    }

    .shell {
      max-width: 1480px;
      margin: 0 auto;
      padding: 22px;
      display: grid;
      gap: 18px;
    }

    .top {
      background: linear-gradient(140deg, rgba(20, 32, 58, 0.92), rgba(9, 14, 28, 0.92));
      border: 1px solid var(--line);
      border-radius: 18px;
      padding: 18px;
      box-shadow: var(--shadow);
    }

    .title-row {
      display: flex;
      justify-content: space-between;
      gap: 14px;
      align-items: center;
      flex-wrap: wrap;
      margin-bottom: 14px;
    }

    h1 {
      margin: 0;
      font-size: 26px;
      letter-spacing: -0.02em;
    }

    .desc {
      margin: 0;
      color: var(--muted);
      font-size: 13px;
    }

    .top-grid {
      display: grid;
      gap: 12px;
      grid-template-columns: repeat(4, minmax(0, 1fr));
    }

    .stat {
      border: 1px solid var(--line);
      background: rgba(13, 20, 36, 0.75);
      border-radius: 14px;
      padding: 12px 14px;
    }

    .stat p {
      margin: 0;
      color: var(--muted);
      font-size: 12px;
    }

    .stat strong {
      display: block;
      margin-top: 4px;
      font-size: 30px;
      font-family: "Space Grotesk", "IBM Plex Sans", sans-serif;
    }

    .layout {
      display: grid;
      gap: 18px;
      grid-template-columns: 320px minmax(0, 1fr);
      align-items: start;
    }

    .panel {
      border: 1px solid var(--line);
      background: linear-gradient(180deg, rgba(14, 23, 39, 0.9), rgba(9, 14, 27, 0.95));
      border-radius: 16px;
      padding: 14px;
      box-shadow: var(--shadow);
    }

    .panel h2 {
      margin: 0;
      font-size: 16px;
    }

    .panel p {
      margin: 0;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.5;
    }

    .stack { display: grid; gap: 12px; }

    .field { display: grid; gap: 6px; }

    .field label {
      font-size: 12px;
      color: var(--muted);
    }

    input,
    button,
    select {
      font: inherit;
    }

    input,
    select {
      width: 100%;
      border: 1px solid rgba(127, 160, 255, 0.22);
      background: rgba(8, 14, 28, 0.85);
      color: var(--text);
      border-radius: 12px;
      padding: 11px 12px;
      outline: none;
    }

    button {
      border: 1px solid transparent;
      border-radius: 12px;
      cursor: pointer;
      padding: 10px 14px;
      transition: all 120ms ease;
      color: #e9efff;
    }

    button:hover { transform: translateY(-1px); }

    .btn-primary {
      background: linear-gradient(120deg, var(--primary), var(--primary-strong));
      box-shadow: 0 6px 20px rgba(58, 102, 255, 0.32);
    }

    .btn-soft {
      background: rgba(66, 95, 175, 0.25);
      border-color: rgba(102, 130, 214, 0.35);
    }

    .btn-danger {
      background: rgba(255, 95, 115, 0.14);
      border-color: rgba(255, 95, 115, 0.4);
      color: #ffc5cc;
    }

    .btn-warning {
      background: rgba(244, 166, 61, 0.14);
      border-color: rgba(244, 166, 61, 0.4);
      color: #ffd9a1;
    }

    .toolbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }

    .domain-list {
      display: grid;
      gap: 10px;
      max-height: 60vh;
      overflow: auto;
      padding-right: 2px;
    }

    .domain-card {
      border: 1px solid rgba(102, 130, 214, 0.24);
      border-radius: 14px;
      background: rgba(9, 15, 30, 0.84);
      padding: 10px;
      display: grid;
      gap: 8px;
    }

    .domain-card.active {
      border-color: rgba(58, 102, 255, 0.78);
      box-shadow: 0 0 0 1px rgba(58, 102, 255, 0.35) inset;
    }

    .domain-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      font-size: 14px;
      font-weight: 700;
    }

    .domain-meta {
      color: var(--muted);
      font-size: 12px;
    }

    .main-stack { display: grid; gap: 14px; }

    .hero {
      padding: 16px;
      border: 1px solid rgba(102, 130, 214, 0.24);
      border-radius: 16px;
      background: linear-gradient(115deg, rgba(18, 30, 50, 0.9), rgba(7, 11, 22, 0.9));
    }

    .hero h2 {
      margin: 0;
      font-size: 24px;
      line-height: 1.1;
    }

    .hero .hint {
      margin-top: 8px;
      color: var(--muted);
      font-size: 13px;
    }

    .hero-actions {
      margin-top: 14px;
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }

    .tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .tab-btn {
      background: rgba(66, 95, 175, 0.18);
      border: 1px solid rgba(102, 130, 214, 0.26);
      color: #c9d7ff;
      padding: 9px 12px;
      border-radius: 10px;
    }

    .tab-btn.active {
      background: linear-gradient(120deg, var(--primary), var(--primary-strong));
      border-color: transparent;
      color: white;
      box-shadow: 0 6px 18px rgba(58, 102, 255, 0.32);
    }

    .tab-panel { display: none; }
    .tab-panel.active { display: grid; gap: 12px; }

    .grid-2 {
      display: grid;
      gap: 12px;
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .link-grid {
      display: grid;
      gap: 12px;
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .link-card {
      border: 1px solid rgba(102, 130, 214, 0.24);
      border-radius: 14px;
      background: rgba(9, 15, 30, 0.86);
      padding: 12px;
      display: grid;
      gap: 8px;
    }

    .line {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
    }

    .mono {
      font-family: "IBM Plex Mono", monospace;
      font-size: 12px;
      color: #b8c9ff;
      word-break: break-all;
    }

    .small { color: var(--muted); font-size: 12px; }

    .badge {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 4px 10px;
      font-size: 11px;
      border: 1px solid rgba(0, 200, 134, 0.32);
      background: rgba(0, 200, 134, 0.12);
      color: #8dffd8;
    }

    .chip-list { display: flex; flex-wrap: wrap; gap: 8px; }

    .chip {
      border: 1px solid rgba(102, 130, 214, 0.3);
      background: rgba(9, 15, 30, 0.86);
      border-radius: 999px;
      padding: 7px 10px;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
    }

    .chip button {
      background: transparent;
      border: 0;
      color: #ff9fae;
      padding: 0;
      min-width: 16px;
    }

    .table-wrap { overflow: auto; }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
      border: 1px solid rgba(102, 130, 214, 0.24);
      border-radius: 12px;
      overflow: hidden;
      background: rgba(9, 15, 30, 0.84);
    }

    th, td {
      text-align: left;
      padding: 10px;
      border-bottom: 1px solid rgba(118, 146, 214, 0.16);
      vertical-align: top;
    }

    th {
      color: var(--muted);
      font-size: 11px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      background: rgba(18, 29, 51, 0.92);
    }

    .empty {
      text-align: center;
      padding: 20px;
      border: 1px dashed rgba(102, 130, 214, 0.3);
      border-radius: 12px;
      color: var(--muted);
      background: rgba(9, 15, 30, 0.68);
    }

    .message { min-height: 18px; font-size: 13px; }
    .message.success { color: #8dffd8; }
    .message.error { color: #ff9fae; }

    .kpi-grid {
      display: grid;
      gap: 10px;
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }

    .kpi {
      border: 1px solid rgba(102, 130, 214, 0.24);
      border-radius: 12px;
      padding: 10px;
      background: rgba(9, 15, 30, 0.84);
    }

    .kpi p { margin: 0; color: var(--muted); font-size: 12px; }

    .kpi strong {
      margin-top: 6px;
      display: block;
      font-size: 30px;
      font-family: "Space Grotesk", "IBM Plex Sans", sans-serif;
    }

    .chart-box {
      border: 1px solid rgba(102, 130, 214, 0.24);
      border-radius: 14px;
      background: rgba(9, 15, 30, 0.9);
      padding: 10px;
    }

    canvas {
      width: 100%;
      height: 240px;
      display: block;
    }

    .analytics-grid {
      display: grid;
      gap: 10px;
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }

    .metric-box {
      border: 1px solid rgba(102, 130, 214, 0.24);
      border-radius: 12px;
      background: rgba(9, 15, 30, 0.84);
      padding: 10px;
    }

    .metric-title {
      margin: 0 0 8px;
      color: var(--muted);
      font-size: 12px;
    }

    .metric-line {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      font-size: 12px;
      padding: 4px 0;
    }

    @media (max-width: 1180px) {
      .layout { grid-template-columns: 1fr; }
      .top-grid, .grid-2, .link-grid, .kpi-grid, .analytics-grid { grid-template-columns: 1fr; }
      .domain-list { max-height: 360px; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <section class="top">
      <div class="title-row">
        <div>
          <h1>暴富的小张</h1>
          <p class="desc">深色看板 · 链接分发 · 允许国家 · 访问分析</p>
        </div>
        <button class="btn-soft" id="reload-domains-btn">刷新数据</button>
      </div>
      <div class="top-grid">
        <div class="stat"><p>入口域名数量</p><strong id="stat-domains">0</strong></div>
        <div class="stat"><p>链接数量</p><strong id="stat-links">0</strong></div>
        <div class="stat"><p>IP 分配</p><strong id="stat-assignments">0</strong></div>
        <div class="stat"><p>访问日志</p><strong id="stat-logs">0</strong></div>
      </div>
    </section>

    <section class="layout">
      <aside class="stack">
        <div class="panel stack">
          <div class="toolbar">
            <h2>新建子链接入口域名</h2>
          </div>
          <p>用于子链接跳转的统一入口域名。用户访问该域名时直接进入分配逻辑，不展示前端首页。创建前会校验 Cloudflare API Token。</p>
          <div class="field">
            <label for="domain-name">子链接入口域名</label>
            <input id="domain-name" placeholder="go.example.com">
          </div>
          <button class="btn-primary" id="create-domain-btn">创建子链接入口</button>
          <div id="domain-message" class="message"></div>
        </div>

        <div class="panel stack">
          <div class="toolbar">
            <h2>项目列表</h2>
            <button class="btn-soft" id="reload-links-btn">刷新</button>
          </div>
          <div id="domains-list" class="domain-list"></div>
        </div>
      </aside>

      <section class="main-stack">
        <div class="hero">
          <h2 id="selected-domain-title">未选择子链接入口</h2>
          <p class="hint" id="selected-domain-hint">选择左侧子链接入口后配置分发策略和访问限制。</p>
          <div class="hero-actions">
            <button class="btn-soft" id="copy-endpoint-btn">复制跳转入口</button>
            <button class="btn-danger" id="delete-domain-btn">删除入口</button>
          </div>
        </div>

        <div class="tabs" id="tabs">
          <button class="tab-btn active" data-tab="tab-links">子链接池</button>
          <button class="tab-btn" data-tab="tab-config">分发配置</button>
          <button class="tab-btn" data-tab="tab-analytics">访问分析</button>
          <button class="tab-btn" data-tab="tab-logs">访问日志</button>
          <button class="tab-btn" data-tab="tab-assignments">IP 固定分配</button>
        </div>

        <section id="tab-links" class="tab-panel active panel">
          <div class="toolbar">
            <h2>链接卡片</h2>
          </div>
          <div id="links-list" class="link-grid"></div>
          <div id="link-message" class="message"></div>
        </section>

        <section id="tab-config" class="tab-panel panel">
          <div class="grid-2">
            <div class="stack">
              <h2>添加目标链接</h2>
              <div class="field">
                <label for="link-order">顺序号</label>
                <input id="link-order" type="number" min="1" placeholder="1">
              </div>
              <div class="field">
                <label for="link-url">目标 URL</label>
                <input id="link-url" type="url" placeholder="https://wa.me/xxxxxxxx?text=Start">
              </div>
              <button class="btn-primary" id="add-link-btn">添加链接</button>
            </div>
            <div class="stack">
              <h2>允许国家</h2>
              <div class="field">
                <label for="country-code">国家/地区</label>
                <select id="country-code"></select>
              </div>
              <button class="btn-warning" id="add-country-btn">添加允许国家</button>
              <div id="country-message" class="message"></div>
              <div id="countries-list" class="chip-list"></div>
            </div>
          </div>
        </section>

        <section id="tab-analytics" class="tab-panel panel">
          <div class="kpi-grid">
            <div class="kpi"><p>总点击量</p><strong id="kpi-total">0</strong></div>
            <div class="kpi"><p>独立访客</p><strong id="kpi-unique">0</strong></div>
            <div class="kpi"><p>访问率</p><strong id="kpi-rate">0%</strong></div>
          </div>
          <div class="chart-box">
            <canvas id="trend-chart" width="1200" height="360"></canvas>
          </div>
          <div class="analytics-grid">
            <div class="metric-box">
              <p class="metric-title">访问地区</p>
              <div id="metric-country"></div>
            </div>
            <div class="metric-box">
              <p class="metric-title">事件类型</p>
              <div id="metric-event"></div>
            </div>
            <div class="metric-box">
              <p class="metric-title">状态分布</p>
              <div id="metric-status"></div>
            </div>
          </div>
        </section>

        <section id="tab-logs" class="tab-panel panel">
          <div class="toolbar">
            <h2>访问日志</h2>
            <button class="btn-soft" id="reload-logs-btn">刷新日志</button>
          </div>
          <div id="logs-table"></div>
        </section>

        <section id="tab-assignments" class="tab-panel panel">
          <div class="toolbar">
            <h2>IP 绑定记录</h2>
            <button class="btn-soft" id="reload-assignments-btn">刷新记录</button>
          </div>
          <div id="assignments-table"></div>
        </section>
      </section>
    </section>
  </main>

  <script>
    const CLOUDFLARE_TOKEN_CONFIGURED = ${JSON.stringify(CLOUDFLARE_TOKEN_CONFIGURED)};
    const COUNTRY_OPTIONS = ${JSON.stringify(COUNTRY_OPTIONS)};

    const state = {
      domains: [],
      selectedDomainId: null,
      selectedDomainName: '',
      stats: { domains: 0, links: 0, assignments: 0, logs: 0 },
      links: [],
      assignments: [],
      logs: [],
      countries: []
    };

    function setMessage(id, text, type) {
      const el = document.getElementById(id);
      el.textContent = text || '';
      el.className = 'message' + (type ? ' ' + type : '');
    }

    function getCountryDisplayName(code) {
      const normalizedCode = String(code || '').trim().toUpperCase();
      const match = COUNTRY_OPTIONS.find((item) => item.code === normalizedCode);
      return match ? match.name : normalizedCode || '未知';
    }

    function renderCountryPicker() {
      const select = document.getElementById('country-code');
      select.innerHTML = [
        '<option value="">选择国家/地区</option>',
        ...COUNTRY_OPTIONS.map((item) => '<option value="' + item.code + '">' + item.name + '</option>')
      ].join('');
      select.value = 'US';
    }

    async function ensureCloudflareTokenReady() {
      if (!CLOUDFLARE_TOKEN_CONFIGURED) {
        throw new Error('Cloudflare Token 未配置，请先设置 CLOUDFLARE_API_TOKEN');
      }

      const status = await api('/api/cloudflare/token/status');
      if (status.valid) {
        return;
      }

      throw new Error('Cloudflare Token 校验失败：' + (status.message || 'invalid'));
    }

    function requireDomain() {
      if (state.selectedDomainId) {
        return true;
      }
      setMessage('link-message', '请先选择入口域名', 'error');
      setMessage('country-message', '请先选择入口域名', 'error');
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

    function countBy(rows, keyFn) {
      const map = new Map();
      rows.forEach((row) => {
        const key = keyFn(row);
        map.set(key, (map.get(key) || 0) + 1);
      });
      return [...map.entries()].sort((a, b) => b[1] - a[1]);
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

    function renderDomains() {
      const wrap = document.getElementById('domains-list');
      if (!state.domains.length) {
        wrap.innerHTML = '<div class="empty">还没有入口域名，先创建一个。</div>';
        return;
      }

      wrap.innerHTML = state.domains.map((domain) => {
        const active = domain.id === state.selectedDomainId ? ' active' : '';
        return [
          '<div class="domain-card' + active + '">',
          '  <div class="domain-top">',
          '    <span>' + escapeHtml(domain.domain_name) + '</span>',
          '    <span class="badge">运行中</span>',
          '  </div>',
          '  <div class="domain-meta">链接 ' + domain.link_count + ' · 限制 ' + domain.blocked_country_count + ' · 绑定 ' + domain.assignment_count + '</div>',
          '  <button class="btn-soft" data-domain-id="' + domain.id + '" data-domain-name="' + escapeHtml(domain.domain_name) + '">进入看板</button>',
          '</div>'
        ].join('');
      }).join('');

      wrap.querySelectorAll('[data-domain-id]').forEach((button) => {
        button.addEventListener('click', () => {
          state.selectedDomainId = Number(button.getAttribute('data-domain-id'));
          state.selectedDomainName = button.getAttribute('data-domain-name') || '';
          renderDomains();
          renderSelectedDomain();
          loadDomainData().catch((error) => setMessage('link-message', error.message, 'error'));
        });
      });
    }

    function renderSelectedDomain() {
      const title = document.getElementById('selected-domain-title');
      const hint = document.getElementById('selected-domain-hint');
      if (!state.selectedDomainId) {
        title.textContent = '未选择子链接入口';
        hint.textContent = '选择左侧子链接入口后配置分发策略和访问限制。';
        return;
      }

      title.textContent = state.selectedDomainName;
      hint.textContent = '/api/redirect/' + state.selectedDomainName + ' 是该子链接入口的跳转入口，最终会直接跳到子链接。';
    }

    function renderLinks(links) {
      const wrap = document.getElementById('links-list');
      if (!links.length) {
        wrap.innerHTML = '<div class="empty">当前子链接入口还没有目标链接。</div>';
        return;
      }

      wrap.innerHTML = links.map((link) => [
        '<div class="link-card">',
        '  <div class="line">',
        '    <strong>#' + link.order_num + '</strong>',
        '    <button class="btn-danger" data-delete-link="' + link.id + '">删除</button>',
        '  </div>',
        '  <div class="mono">' + escapeHtml(link.target_url) + '</div>',
        '  <div class="small">创建时间：' + formatDate(link.created_at) + '</div>',
        '</div>'
      ].join('')).join('');

      wrap.querySelectorAll('[data-delete-link]').forEach((button) => {
        button.addEventListener('click', async () => {
          if (!confirm('确定删除这个子链接吗？已有 IP 绑定和日志会级联删除。')) {
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
        wrap.innerHTML = '<div class="empty">当前子链接入口没有允许国家限制，默认全部国家都可访问。</div>';
        return;
      }

      wrap.innerHTML = countries.map((country) => [
        '<span class="chip">',
        '  ' + escapeHtml(getCountryDisplayName(country.country_code)),
        '  <button data-delete-country="' + escapeHtml(country.country_code) + '">×</button>',
        '</span>'
      ].join('')).join('');

      wrap.querySelectorAll('[data-delete-country]').forEach((button) => {
        button.addEventListener('click', async () => {
          try {
            const countryCode = button.getAttribute('data-delete-country');
            await api('/api/blocked-countries/' + encodeURIComponent(countryCode), {
              method: 'DELETE',
              headers: { 'X-Domain-Id': String(state.selectedDomainId) }
            });
            setMessage('country-message', '已删除允许国家', 'success');
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
        wrap.innerHTML = '<div class="empty">当前子链接入口暂无 IP 固定分配记录。</div>';
        return;
      }

      wrap.innerHTML = [
        '<div class="table-wrap">',
        '<table>',
        '<thead><tr><th>IP</th><th>国家</th><th>顺序号</th><th>目标 URL</th><th>首次分配</th></tr></thead>',
        '<tbody>',
        assignments.map((item) => [
          '<tr>',
          '  <td class="mono">' + escapeHtml(item.ip_address) + '</td>',
          '  <td>' + escapeHtml(getCountryDisplayName(item.country_code || 'unknown')) + '</td>',
          '  <td>#' + item.order_num + '</td>',
          '  <td class="mono">' + escapeHtml(item.target_url) + '</td>',
          '  <td>' + formatDate(item.assigned_at) + '</td>',
          '</tr>'
        ].join('')).join(''),
        '</tbody></table></div>'
      ].join('');
    }

    function renderLogs(logs) {
      const wrap = document.getElementById('logs-table');
      if (!logs.length) {
        wrap.innerHTML = '<div class="empty">当前子链接入口暂无访问日志。</div>';
        return;
      }

      wrap.innerHTML = [
        '<div class="table-wrap">',
        '<table>',
        '<thead><tr><th>时间</th><th>IP</th><th>国家</th><th>事件</th><th>状态</th><th>详情</th></tr></thead>',
        '<tbody>',
        logs.map((log) => [
          '<tr>',
          '  <td>' + formatDate(log.created_at) + '</td>',
          '  <td class="mono">' + escapeHtml(log.ip_address) + '</td>',
          '  <td>' + escapeHtml(getCountryDisplayName(log.country_code || 'unknown')) + '</td>',
          '  <td>' + escapeHtml(log.event_type) + '</td>',
          '  <td>' + log.status_code + '</td>',
          '  <td>' + escapeHtml(log.detail || '-') + '</td>',
          '</tr>'
        ].join('')).join(''),
        '</tbody></table></div>'
      ].join('');
    }

    function drawTrend(logs) {
      const canvas = document.getElementById('trend-chart');
      const ctx = canvas.getContext('2d');
      const labels = [];
      const counts = [];
      const today = new Date();

      for (let i = 6; i >= 0; i -= 1) {
        const d = new Date(today);
        d.setDate(today.getDate() - i);
        const key = d.toISOString().slice(0, 10);
        labels.push(key.slice(5));
        counts.push(0);
      }

      logs.forEach((log) => {
        const key = new Date(log.created_at).toISOString().slice(0, 10);
        const idx = labels.findIndex((value) => value === key.slice(5));
        if (idx >= 0) {
          counts[idx] += 1;
        }
      });

      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      ctx.fillStyle = '#0b1222';
      ctx.fillRect(0, 0, w, h);

      ctx.strokeStyle = 'rgba(148, 171, 235, 0.22)';
      ctx.lineWidth = 1;
      for (let i = 0; i <= 4; i += 1) {
        const y = 24 + i * ((h - 48) / 4);
        ctx.beginPath();
        ctx.moveTo(40, y);
        ctx.lineTo(w - 20, y);
        ctx.stroke();
      }

      const max = Math.max(...counts, 5);
      const stepX = (w - 80) / (counts.length - 1 || 1);
      ctx.strokeStyle = '#3a66ff';
      ctx.lineWidth = 3;
      ctx.beginPath();

      counts.forEach((v, i) => {
        const x = 40 + i * stepX;
        const y = h - 24 - (v / max) * (h - 58);
        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      });
      ctx.stroke();

      ctx.fillStyle = '#9eb3ea';
      ctx.font = '12px IBM Plex Sans';
      labels.forEach((label, i) => {
        const x = 40 + i * stepX - 12;
        ctx.fillText(label, x, h - 6);
      });
    }

    function renderMetricList(id, items) {
      const wrap = document.getElementById(id);
      if (!items.length) {
        wrap.innerHTML = '<div class="small">暂无数据</div>';
        return;
      }

      wrap.innerHTML = items.slice(0, 6).map((item) => {
        return '<div class="metric-line"><span>' + escapeHtml(String(item[0])) + '</span><strong>' + item[1] + '</strong></div>';
      }).join('');
    }

    function renderAnalytics() {
      const logs = state.logs;
      const uniqueIPs = new Set(logs.map((log) => log.ip_address)).size;
      const total = logs.length;
      const successCount = logs.filter((log) => Number(log.status_code) < 400).length;
      const rate = total ? ((successCount / total) * 100).toFixed(1) : '0.0';

      document.getElementById('kpi-total').textContent = String(total);
      document.getElementById('kpi-unique').textContent = String(uniqueIPs);
      document.getElementById('kpi-rate').textContent = rate + '%';

      drawTrend(logs);
      renderMetricList('metric-country', countBy(logs, (row) => getCountryDisplayName(row.country_code || 'unknown')));
      renderMetricList('metric-event', countBy(logs, (row) => row.event_type || 'unknown'));
      renderMetricList('metric-status', countBy(logs, (row) => row.status_code || 'unknown'));
    }

    async function loadDomainData() {
      if (!state.selectedDomainId) {
        state.links = [];
        state.assignments = [];
        state.logs = [];
        state.countries = [];
        renderLinks([]);
        renderAssignments([]);
        renderLogs([]);
        renderCountries([]);
        renderAnalytics();
        return;
      }

      const [links, assignments, logs, countries] = await Promise.all([
        api('/api/links?domain_id=' + state.selectedDomainId),
        api('/api/assignments?domain_id=' + state.selectedDomainId),
        api('/api/access-logs?domain_id=' + state.selectedDomainId),
        api('/api/blocked-countries?domain_id=' + state.selectedDomainId)
      ]);

      state.links = links;
      state.assignments = assignments;
      state.logs = logs;
      state.countries = countries;

      renderLinks(links);
      renderAssignments(assignments);
      renderLogs(logs);
      renderCountries(countries);
      renderAnalytics();
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
      await loadDomainData();
    }

    document.getElementById('tabs').querySelectorAll('[data-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tabId = btn.getAttribute('data-tab');
        document.querySelectorAll('.tab-btn').forEach((el) => el.classList.remove('active'));
        document.querySelectorAll('.tab-panel').forEach((el) => el.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(tabId).classList.add('active');
      });
    });

    document.getElementById('create-domain-btn').addEventListener('click', async () => {
      const input = document.getElementById('domain-name');
      const domainName = input.value.trim();
      if (!domainName) {
        setMessage('domain-message', '请输入子链接入口域名', 'error');
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
        const dnsSuffix = domain.dns_message ? ('，' + domain.dns_message) : '';
        const createLabel = domain.created ? '子链接入口已创建' : '子链接入口已同步';
        setMessage('domain-message', createLabel + dnsSuffix, domain.dns_synced ? 'success' : '');
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
        setMessage('country-message', '请选择国家/地区', 'error');
        return;
      }

      try {
        await api('/api/blocked-countries', {
          method: 'POST',
          body: JSON.stringify({ domain_id: state.selectedDomainId, country_code: countryCode })
        });
        input.value = '';
        setMessage('country-message', '允许国家已添加', 'success');
        await loadOverview();
      } catch (error) {
        setMessage('country-message', error.message, 'error');
      }
    });

    document.getElementById('delete-domain-btn').addEventListener('click', async () => {
      if (!state.selectedDomainId) {
        setMessage('domain-message', '没有可删除的子链接入口', 'error');
        return;
      }

      if (!confirm('删除子链接入口会删除其链接、分配记录、允许国家和访问日志，确定继续吗？')) {
        return;
      }

      try {
        await api('/api/domains/' + state.selectedDomainId, { method: 'DELETE' });
        setMessage('domain-message', '子链接入口已删除', 'success');
        state.selectedDomainId = null;
        state.selectedDomainName = '';
        await loadOverview();
      } catch (error) {
        setMessage('domain-message', error.message, 'error');
      }
    });

    document.getElementById('copy-endpoint-btn').addEventListener('click', async () => {
      if (!state.selectedDomainName) {
        setMessage('domain-message', '请先选择子链接入口', 'error');
        return;
      }

      const endpoint = location.origin + '/api/redirect/' + state.selectedDomainName;
      try {
        await navigator.clipboard.writeText(endpoint);
        setMessage('domain-message', '跳转入口已复制', 'success');
      } catch {
        setMessage('domain-message', endpoint, 'success');
      }
    });

    document.getElementById('reload-domains-btn').addEventListener('click', () => loadOverview().catch((error) => setMessage('domain-message', error.message, 'error')));
    document.getElementById('reload-links-btn').addEventListener('click', () => loadDomainData().catch((error) => setMessage('link-message', error.message, 'error')));
    document.getElementById('reload-assignments-btn').addEventListener('click', () => loadDomainData().catch((error) => setMessage('link-message', error.message, 'error')));
    document.getElementById('reload-logs-btn').addEventListener('click', () => loadDomainData().catch((error) => setMessage('link-message', error.message, 'error')));

    renderCountryPicker();

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
  const domainName = normalizeDomainInput(body.domain_name || "");

  if (!domainName) {
    return jsonResponse({ error: "domain_name is required" }, 400);
  }

  if (!CLOUDFLARE_AUTO_DNS_ENABLED) {
    return jsonResponse(
      {
        error:
          "Cloudflare DNS sync is not configured. Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_DNS_TARGET first.",
      },
      400
    );
  }

  const result = await sql`
    INSERT INTO domains (domain_name)
    VALUES (${domainName})
    ON CONFLICT (domain_name) DO NOTHING
    RETURNING *
  `;

  let domainRow = result[0] as DomainRow | undefined;
  let created = Boolean(domainRow);

  if (!domainRow) {
    const existingRows = await sql`
      SELECT * FROM domains WHERE domain_name = ${domainName} LIMIT 1
    `;

    domainRow = existingRows[0] as DomainRow | undefined;
    if (!domainRow) {
      return jsonResponse({ error: "Domain already exists" }, 409);
    }
  }

  let dnsSynced = false;
  let dnsMessage = "Auto DNS disabled";

  try {
    const dnsResult = await syncCloudflareCnameRecord(domainName);
    dnsSynced = dnsResult.synced;
    dnsMessage = dnsResult.message;
  } catch (error) {
    if (created && domainRow) {
      await sql`
        DELETE FROM domains WHERE id = ${domainRow.id}
      `;
    }

    const message = error instanceof Error ? error.message : "Cloudflare DNS sync failed";
    return jsonResponse({ error: `Domain creation rolled back: ${message}` }, 502);
  }

  return jsonResponse({
    ...domainRow,
    created,
    dns_synced: dnsSynced,
    dns_message: dnsMessage,
  }, created ? 201 : 200);
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
      ORDER BY
        CASE
          WHEN country_code IN ('US', 'JP', 'TW', 'HK', 'SG', 'TH', 'VN', 'MY') THEN 0
          ELSE 1
        END,
        country_code ASC
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
      return jsonResponse({ error: "Country is already allowed for this domain" }, 409);
    }

    return jsonResponse(result[0], 201);
  } catch (error) {
    console.error("Create blocked country error:", error);
    return jsonResponse({ error: "Failed to add allowed country" }, 400);
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
    return jsonResponse({ error: "Allowed country not found" }, 404);
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

  const allowedCountries = await sql`
    SELECT country_code FROM blocked_countries
    WHERE domain_id = ${domain.id}
  `;

  if (allowedCountries.length > 0) {
    const isAllowed = (allowedCountries as { country_code: string }[]).some((row) => row.country_code === countryCode);

    if (!isAllowed) {
      await writeAccessLog(sql, {
        domainId: domain.id,
        ipAddress: clientIP,
        countryCode,
        eventType: "country_not_allowed",
        statusCode: 403,
        detail: `Blocked by allowlist policy for ${countryCode}`,
      });

      return jsonResponse({ error: "Access denied from your country" }, 403);
    }
  }

  const existingAssignment = await sql`
    SELECT ia.link_id, l.order_num, l.target_url
    FROM ip_assignments ia
    JOIN links l ON l.id = ia.link_id
    WHERE ia.domain_id = ${domain.id} AND ia.ip_address = ${clientIP}
  `;

  if (existingAssignment[0]) {
    const assignedLink = {
      id: existingAssignment[0].link_id,
      domain_id: domain.id,
      domain_name: domain.domain_name,
      order_num: existingAssignment[0].order_num,
      target_url: existingAssignment[0].target_url,
      created_at: "",
    };

    await writeAccessLog(sql, {
      domainId: domain.id,
      linkId: assignedLink.id,
      ipAddress: clientIP,
      countryCode,
      eventType: "assignment_reused",
      statusCode: 200,
      detail: `Reused existing assignment for order ${assignedLink.order_num}`,
    });

    if (responseMode === "http") {
      return Response.redirect(assignedLink.target_url, 302);
    }

    return jsonResponse({
      url: assignedLink.target_url,
      order: assignedLink.order_num,
      message: "这个 IP 已固定到该链接",
    });
  }

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

  const rotationRows = await sql<DomainRotationRow[]>`
    INSERT INTO domain_rotations (domain_id, next_link_index)
    VALUES (${domain.id}, 1)
    ON CONFLICT (domain_id)
    DO UPDATE SET
      next_link_index = CASE
        WHEN domain_rotations.next_link_index >= ${allLinks.length} THEN 1
        ELSE domain_rotations.next_link_index + 1
      END,
      updated_at = CURRENT_TIMESTAMP
    RETURNING domain_id, next_link_index, updated_at
  `;

  const nextLinkIndex = rotationRows[0]?.next_link_index || 1;
  const selectedLink = allLinks[Math.max(0, Math.min(allLinks.length - 1, nextLinkIndex - 1))]!;

  await sql`
    INSERT INTO ip_assignments (domain_id, link_id, ip_address, country_code)
    VALUES (${domain.id}, ${selectedLink.id}, ${clientIP}, ${countryCode})
    ON CONFLICT (domain_id, ip_address)
    DO NOTHING
  `;

  const assignedRows = await sql`
    SELECT ia.link_id, l.order_num, l.target_url
    FROM ip_assignments ia
    JOIN links l ON l.id = ia.link_id
    WHERE ia.domain_id = ${domain.id} AND ia.ip_address = ${clientIP}
  `;

  const resolvedAssignedLink = assignedRows[0]
    ? {
        id: assignedRows[0].link_id,
        domain_id: domain.id,
        domain_name: domain.domain_name,
        order_num: assignedRows[0].order_num,
        target_url: assignedRows[0].target_url,
        created_at: "",
      }
    : selectedLink;

  await writeAccessLog(sql, {
    domainId: domain.id,
    linkId: resolvedAssignedLink.id,
    ipAddress: clientIP,
    countryCode,
    eventType: "assignment_created",
    statusCode: 200,
    detail: `Assigned IP to order ${resolvedAssignedLink.order_num}`,
  });

  if (responseMode === "http") {
    return Response.redirect(resolvedAssignedLink.target_url, 302);
  }

  return jsonResponse({
    url: resolvedAssignedLink.target_url,
    order: resolvedAssignedLink.order_num,
    message: "这个 IP 已固定到该链接",
  });
}

async function tryDomainHostRedirect(path: string, req: Request, sql: SqlClient): Promise<Response | null> {
  if (!HAS_DATABASE_URL) {
    return null;
  }

  if (path.startsWith("/api")) {
    return null;
  }

  const host = normalizeHostToDomain(getRequestHost(req));
  if (!host) {
    return null;
  }

  try {
    let domain = await resolveDomain(sql, host);

    // Accept both apex and www hostnames for the same configured entry domain.
    if (!domain && host.startsWith("www.")) {
      domain = await resolveDomain(sql, host.slice(4));
    } else if (!domain) {
      domain = await resolveDomain(sql, `www.${host}`);
    }

    if (!domain) {
      return null;
    }

    return handleRedirect(domain.domain_name, req, sql, "http");
  } catch (error) {
    console.error("Host redirect lookup failed:", error);
    return null;
  }
}

await initDB();

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;
  const sql = Bun.sql;

  try {
    if (path === "/healthz" && method === "GET") {
      return jsonResponse({
        ok: true,
        version: APP_VERSION,
        databaseConfigured: HAS_DATABASE_URL,
      });
    }

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

    if (path === "/api/version" && method === "GET") {
      return jsonResponse({
        version: APP_VERSION,
        service: "link-redirect-manager",
      });
    }

    if (path === "/api/cloudflare/token/status" && method === "GET") {
      return handleCloudflareTokenStatus();
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
      return handleRedirect(redirectMatch[1], req, sql, "http");
    }

    return jsonResponse({ error: "Not found" }, 404);
  } catch (error) {
    console.error("Request error:", error);
    return jsonResponse({ error: "Internal server error" }, 500);
  }
}

Bun.serve({
  hostname: "0.0.0.0",
  port: PORT,
  fetch: handleRequest,
});

console.log(`Link Redirect Manager running on port ${PORT}`);
console.log(`App version: ${APP_VERSION}`);
