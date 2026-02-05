import { chromium } from "playwright";
import crypto from "crypto";
import dotenv from "dotenv";
import fs from "fs/promises";
import path from "path";

dotenv.config();

const TARGET_API = process.env.TARGET_API || "http://localhost:5214/api/InventoryStock/GetInventoryStockSummary";
const TARGET_API_HINTS = [
  "GetInventoryStockSummary",
  "GetInventoryStock",
];

function looksLikeTarget(url) {
  if (url === TARGET_API) return true;
  const lower = url.toLowerCase();
  return TARGET_API_HINTS.some((h) => lower.includes(String(h).toLowerCase()));
}

function maskBearer(authHeader) {
  if (!authHeader) return null;
  const lower = authHeader.toLowerCase();
  if (!lower.startsWith("bearer ")) return null;
  const token = authHeader.slice(7).trim();
  if (token.length < 20) return "Bearer [token_curto]";
  return `Bearer ${token.slice(0, 12)}...${token.slice(-8)}`;
}

function extractBearerToken(authHeader) {
  if (!authHeader) return null;
  const lower = authHeader.toLowerCase();
  if (!lower.startsWith("bearer ")) return null;
  return authHeader.slice(7).trim();
}

function sha256Short(value) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function pickTenant(headers) {
  return (
    headers["x-tenantid"] ||
    headers["x-tenant-id"] ||
    headers["tenantid"] ||
    headers["tenant_id"] ||
    null
  );
}

async function loginERP(page, user, pass) {
  const rawUrl = process.env.ERP_URL || "https://erp.dev.inovepic.dev/#/login";
  const erpUrl = rawUrl.includes("#/login") ? rawUrl : rawUrl.replace(/#.*$/, "") + "#/login";
  console.log(`\n🔐 Fazendo login no ERP: ${erpUrl}`);
  
  const navTimeout = parseInt(process.env.TIMEOUT_NAV_ERP) || 60000;
  await page.goto(erpUrl, { waitUntil: "domcontentloaded", timeout: navTimeout });
  await page.waitForTimeout(2000);

  const userLocators = [
    page.getByLabel(/username|usu[aá]rio|login|user/i),
    page.locator('input[name="username"], input[name="user"], input[id*="user" i], input[id*="login" i]'),
    page.locator('input[placeholder*="username" i], input[placeholder*="usu" i], input[placeholder*="email" i]'),
    page.locator('input[type="email"]'),
  ];
  const passLocators = [
    page.getByLabel(/password|senha/i),
    page.locator('input[name="password"], input[id*="pass" i]'),
    page.locator('input[placeholder*="password" i], input[placeholder*="senha" i]'),
    page.locator('input[type="password"]'),
  ];

  const fillFirst = async (locators, value, label) => {
    for (const loc of locators) {
      try {
        if ((await loc.count()) > 0) {
          console.log(`✓ Campo de ${label} encontrado`);
          await loc.first().fill(value);
          return true;
        }
      } catch {}
    }
    return false;
  };

  if (!(await fillFirst(userLocators, user, "usuário"))) throw new Error("❌ Não achei input de usuário no login.");
  if (!(await fillFirst(passLocators, pass, "senha"))) throw new Error("❌ Não achei input de senha no login.");

  const btns = [
    page.getByRole("button", { name: /login|entrar|acessar|sign in/i }),
    page.getByRole("button", { name: /^login$/i }),
    page.locator('button[type="submit"]'),
    page.locator('input[type="submit"]'),
  ];

  let clicked = false;
  for (const b of btns) {
    if (await b.count()) {
      console.log(`✓ Botão de login encontrado`);
      await b.first().click();
      clicked = true;
      break;
    }
  }
  if (!clicked) throw new Error("❌ Não achei botão de login.");

  const timeout = parseInt(process.env.TIMEOUT_LOGIN) || 4000;
  console.log(`⏳ Aguardando ${timeout}ms para o login completar...`);
  await page.waitForTimeout(timeout);
  console.log("✓ Login concluído!");
}

function startNetworkAudit(page, { label, onlyTarget = false }) {
  const hits = [];
  const start = Date.now();

  page.on("request", (req) => {
    const url = req.url();
    const method = req.method();
    const headers = req.headers();

    if (onlyTarget && url !== TARGET_API) return;

  const auth = headers["authorization"] || headers["Authorization"];
    const tenant = pickTenant(headers);
  const bearerToken = extractBearerToken(String(auth || ""));

    const item = {
      t: Date.now() - start,
      label,
      method,
      url,
      hasBearer: !!auth && String(auth).toLowerCase().startsWith("bearer "),
      bearerMasked: maskBearer(String(auth || "")),
      bearerHash: auth ? sha256Short(String(auth)) : null,
  bearerToken,
      tenantId: tenant ? String(tenant) : null,
      tenantHash: tenant ? sha256Short(String(tenant)) : null,
      origin: headers["origin"] || null,
      referer: headers["referer"] || null,
    };

    hits.push(item);
  });

  return hits;
}

async function appendTokenCapture({ token, tenantId, url }) {
  if (!token || !tenantId) return;
  const outputFile = process.env.OUTPUT_FILE || "./bearer_tenant.txt";
  const filePath = path.resolve(process.cwd(), outputFile);
  const lines = [
    "tenantId",
    tenantId,
    "bearer",
    token,
    "---",
    "",
  ].join("\n");
  await fs.appendFile(filePath, lines, { encoding: "utf8" });
}

function printSummary(hits, { title }) {
  const total = hits.length;
  const withBearer = hits.filter((h) => h.hasBearer).length;
  const withTenant = hits.filter((h) => h.tenantId).length;

  console.log(`\n${"=".repeat(60)}`);
  console.log(`=== ${title} ===`);
  console.log(`${"=".repeat(60)}`);
  console.log(`📊 Total capturadas: ${total}`);
  console.log(`🔑 Com Bearer:       ${withBearer}`);
  console.log(`🏢 Com x-tenantid:   ${withTenant}`);

  if (hits.length === 0) {
    console.log("⚠️  Nenhuma requisição capturada!");
    return;
  }

  console.log(`\n📋 Últimas ${Math.min(20, hits.length)} requisições:\n`);

  for (const h of hits.slice(-20)) {
    console.log(
      `⏱️  [+${String(h.t).padStart(5)}ms] ${h.method} ${h.url}\n` +
      `   🔑 Bearer: ${h.bearerMasked ?? "❌ não"} (hash:${h.bearerHash ?? "-"})\n` +
      `   🏢 Tenant: ${h.tenantId ? h.tenantId : "❌ não"} (hash:${h.tenantHash ?? "-"})\n` +
      `   🌐 Origin: ${h.origin ?? "-"} | Referer: ${h.referer ?? "-"}\n`
    );
  }
}

async function auditLocalStorageAndCookies(page) {
  console.log(`\n${"=".repeat(60)}`);
  console.log("=== 💾 Auditoria de LocalStorage e Cookies ===");
  console.log(`${"=".repeat(60)}`);

  // LocalStorage
  const localStorage = await page.evaluate(() => {
    const items = {};
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      const value = window.localStorage.getItem(key);
      items[key] = value;
    }
    return items;
  });

  console.log("\n📦 LocalStorage:");
  if (Object.keys(localStorage).length === 0) {
    console.log("   ⚠️  Vazio");
  } else {
    for (const [key, value] of Object.entries(localStorage)) {
      const valueStr = String(value);
      const isLong = valueStr.length > 50;
      
      // Detecta se parece token
      const looksLikeToken = 
        key.toLowerCase().includes("token") || 
        key.toLowerCase().includes("jwt") ||
        key.toLowerCase().includes("auth") ||
        (valueStr.length > 100 && valueStr.split(".").length === 3); // JWT format

      const looksLikeTenant = 
        key.toLowerCase().includes("tenant") ||
        key.toLowerCase().includes("organization") ||
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(valueStr); // GUID

      let display = isLong ? `${valueStr.slice(0, 30)}...${valueStr.slice(-15)}` : valueStr;
      const hash = sha256Short(valueStr);

      console.log(`\n   🔑 Key: ${key}`);
      console.log(`      Value: ${display}`);
      console.log(`      Hash: ${hash}`);
      console.log(`      Tamanho: ${valueStr.length} chars`);
      
      if (looksLikeToken) console.log(`      🎯 PARECE TOKEN!`);
      if (looksLikeTenant) console.log(`      🏢 PARECE TENANT ID!`);
    }
  }

  // SessionStorage
  const sessionStorage = await page.evaluate(() => {
    const items = {};
    for (let i = 0; i < window.sessionStorage.length; i++) {
      const key = window.sessionStorage.key(i);
      const value = window.sessionStorage.getItem(key);
      items[key] = value;
    }
    return items;
  });

  console.log("\n\n📦 SessionStorage:");
  if (Object.keys(sessionStorage).length === 0) {
    console.log("   ⚠️  Vazio");
  } else {
    for (const [key, value] of Object.entries(sessionStorage)) {
      const valueStr = String(value);
      const isLong = valueStr.length > 50;
      
      const looksLikeToken = 
        key.toLowerCase().includes("token") || 
        key.toLowerCase().includes("jwt") ||
        key.toLowerCase().includes("auth") ||
        (valueStr.length > 100 && valueStr.split(".").length === 3);

      const looksLikeTenant = 
        key.toLowerCase().includes("tenant") ||
        key.toLowerCase().includes("organization") ||
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(valueStr);

      let display = isLong ? `${valueStr.slice(0, 30)}...${valueStr.slice(-15)}` : valueStr;
      const hash = sha256Short(valueStr);

      console.log(`\n   🔑 Key: ${key}`);
      console.log(`      Value: ${display}`);
      console.log(`      Hash: ${hash}`);
      console.log(`      Tamanho: ${valueStr.length} chars`);
      
      if (looksLikeToken) console.log(`      🎯 PARECE TOKEN!`);
      if (looksLikeTenant) console.log(`      🏢 PARECE TENANT ID!`);
    }
  }

  // Cookies
  const cookies = await page.context().cookies();

  console.log("\n\n🍪 Cookies:");
  if (cookies.length === 0) {
    console.log("   ⚠️  Nenhum cookie");
  } else {
    for (const cookie of cookies) {
      const valueStr = String(cookie.value);
      const isLong = valueStr.length > 50;
      
      const looksLikeToken = 
        cookie.name.toLowerCase().includes("token") || 
        cookie.name.toLowerCase().includes("jwt") ||
        cookie.name.toLowerCase().includes("auth") ||
        (valueStr.length > 100 && valueStr.split(".").length === 3);

      const looksLikeTenant = 
        cookie.name.toLowerCase().includes("tenant") ||
        cookie.name.toLowerCase().includes("organization") ||
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(valueStr);

      let display = isLong ? `${valueStr.slice(0, 30)}...${valueStr.slice(-15)}` : valueStr;
      const hash = sha256Short(valueStr);

      console.log(`\n   🍪 Name: ${cookie.name}`);
      console.log(`      Domain: ${cookie.domain}`);
      console.log(`      Value: ${display}`);
      console.log(`      Hash: ${hash}`);
      console.log(`      HttpOnly: ${cookie.httpOnly}`);
      console.log(`      Secure: ${cookie.secure}`);
      console.log(`      SameSite: ${cookie.sameSite}`);
      
      if (looksLikeToken) console.log(`      🎯 PARECE TOKEN!`);
      if (looksLikeTenant) console.log(`      🏢 PARECE TENANT ID!`);
    }
  }
}

async function main() {
  console.log("🚀 Iniciando auditoria web COMPLETA (com LocalStorage/Cookies)...\n");

  const ERP_USER = process.env.ERP_USER ?? "Ramon";
  const ERP_PASS = process.env.ERP_PASS ?? "dev123";
  const SWAGGER_URL = process.env.SWAGGER_URL ?? "http://localhost:4200/swagger";
  const HEADLESS = process.env.HEADLESS !== "false";

  console.log(`📝 Configurações:`);
  console.log(`   Usuário: ${ERP_USER}`);
  console.log(`   Headless: ${HEADLESS}`);
  console.log(`   Endpoint alvo: ${TARGET_API}\n`);

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext();
  const page = await context.newPage();

  // (A) Swagger
  console.log(`\n📡 Acessando Swagger: ${SWAGGER_URL}`);
  const swaggerHits = startNetworkAudit(page, { label: "swagger", onlyTarget: false });
  
  try {
    await page.goto(SWAGGER_URL, { waitUntil: "domcontentloaded", timeout: 10000 });
    await page.waitForTimeout(6000);
  } catch (err) {
    console.log(`⚠️  Aviso: Não foi possível acessar o Swagger (${err.message})`);
  }
  
  printSummary(swaggerHits, { title: "Swagger localhost:4200/swagger" });

  // (B) Login no ERP
  const erpHitsAll = startNetworkAudit(page, { label: "erp-all", onlyTarget: false });
  
  try {
    await loginERP(page, ERP_USER, ERP_PASS);
  } catch (err) {
    console.error(`\n❌ Erro no ERP (vou seguir mesmo assim): ${err?.message || err}`);
    try {
      await page.screenshot({ path: "erp-error.png", fullPage: true });
      console.log("📸 Screenshot salvo em: erp-error.png");
    } catch {}
    await browser.close();
    console.log("\n✨ Auditoria completa concluída (com falha no ERP).\n");
    return;
  }

  // Observa tráfego geral pós-login
  const timeout = parseInt(process.env.TIMEOUT_OBSERVE) || 12000;
  const stockRoute = process.env.ERP_STOCK_ROUTE || "#/stock";
  const erpBase = (process.env.ERP_URL || "https://erp.dev.inovepic.dev/#/login").replace(/#.*$/, "");
  const stockUrl = stockRoute.startsWith("http")
    ? stockRoute
    : `${erpBase}${stockRoute.startsWith("#") ? stockRoute : `#${stockRoute}`}`;

  try {
    console.log(`\n🧭 Indo para tela de estoque no ERP: ${stockUrl}`);
    await page.goto(stockUrl, { waitUntil: "domcontentloaded", timeout: parseInt(process.env.TIMEOUT_NAV_ERP) || 60000 });
  } catch (e) {
    console.log(`⚠️  Não consegui navegar para a tela de estoque (${e?.message || e}). Vou observar mesmo assim.`);
  }

  console.log(`\n👀 Observando tráfego por ${timeout}ms...`);
  await page.waitForTimeout(timeout);
  printSummary(erpHitsAll, { title: "ERP pós-login (todas requests)" });

  // (C) Auditoria de LocalStorage e Cookies
  await auditLocalStorageAndCookies(page);

  // (D) Filtro só no endpoint alvo
  const erpHitsTarget = erpHitsAll.filter((h) => h.method === "POST" && looksLikeTarget(h.url));

  console.log(`\n${"=".repeat(60)}`);
  console.log(`=== 🎯 Somente endpoint alvo ===`);
  console.log(`${"=".repeat(60)}`);
  console.log(`Endpoint (base): ${TARGET_API}`);
  console.log(`Ocorrências: ${erpHitsTarget.length}`);

  if (erpHitsTarget.length === 0) {
    console.log("\n⚠️  Nenhuma requisição para o endpoint alvo foi capturada!");
  } else {
    console.log("");
    for (const h of erpHitsTarget.slice(-10)) {
      console.log(
        `✅ POST ${h.url}\n` +
        `   🔑 Bearer: ${h.bearerMasked ?? "❌ não"}\n` +
        `   🏢 Tenant: ${h.tenantId ?? "❌ não"}\n`
      );

      try {
        await appendTokenCapture({ token: h.bearerToken, tenantId: h.tenantId, url: h.url });
      } catch (e) {
        console.log(`⚠️  Não consegui salvar token/tenant no arquivo: ${e?.message || e}`);
      }
    }
  }

  await browser.close();
  console.log("\n✨ Auditoria completa concluída!\n");
}

main().catch((e) => {
  console.error("\n💥 ERRO:", e?.message || e);
  console.error(e);
  process.exit(1);
});
