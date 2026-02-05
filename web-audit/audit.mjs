import { chromium } from "playwright";
import crypto from "crypto";
import dotenv from "dotenv";

dotenv.config();

const TARGET_API = process.env.TARGET_API || "http://localhost:5214/api/InventoryStock/GetInventoryStockSummary";
const TARGET_API_HINTS = [
  "GetInventoryStockSummary",
  "GetInventoryStockSummary/",
  "GetInventoryStockSummary?",
  "GetInventoryStock",
  "GetInventoryStockSummary".toLowerCase(),
];

function maskBearer(authHeader) {
  if (!authHeader) return null;
  const lower = authHeader.toLowerCase();
  if (!lower.startsWith("bearer ")) return null;
  const token = authHeader.slice(7).trim();
  if (token.length < 20) return "Bearer [token_curto]";
  return `Bearer ${token.slice(0, 12)}...${token.slice(-8)}`; // máscara segura
}

function sha256Short(value) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function pickTenant(headers) {
  // seu caso: x-tenantid
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

  // O ERP é ambiente externo; dá mais tempo e tenta 2x.
  const navTimeout = parseInt(process.env.TIMEOUT_NAV_ERP) || 60000;
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await page.goto(erpUrl, { waitUntil: "domcontentloaded", timeout: navTimeout });
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      console.log(`⚠️  Falha ao abrir ERP (tentativa ${attempt}/2): ${e?.message || e}`);
      await page.waitForTimeout(1500);
    }
  }
  if (lastErr) throw lastErr;

  // Aguarda um pouco para a página carregar completamente
  await page.waitForTimeout(2000);

  // Inputs por label (Playwright entende <label for> e aria-label), com fallback.
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
      } catch {
        // tenta próximo
      }
    }
    return false;
  };

  if (!(await fillFirst(userLocators, user, "usuário"))) {
    throw new Error("❌ Não achei input de usuário no login (label/placeholder/name/id). Ajuste loginERP().");
  }
  if (!(await fillFirst(passLocators, pass, "senha"))) {
    throw new Error("❌ Não achei input de senha no login (label/placeholder/name/id). Ajuste loginERP().");
  }

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
  if (!clicked) throw new Error("❌ Não achei botão de login. Ajuste os seletores em loginERP().");

  // espera a app carregar pós-login
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

    const item = {
      t: Date.now() - start,
      label,
      method,
      url,
      hasBearer: !!auth && String(auth).toLowerCase().startsWith("bearer "),
      bearerMasked: maskBearer(String(auth || "")),
      bearerHash: auth ? sha256Short(String(auth)) : null, // fingerprint
      tenantId: tenant ? String(tenant) : null,
      tenantHash: tenant ? sha256Short(String(tenant)) : null,
      origin: headers["origin"] || null,
      referer: headers["referer"] || null,
    };

    hits.push(item);
  });

  return hits;
}

function looksLikeTarget(url) {
  if (url === TARGET_API) return true;
  const lower = url.toLowerCase();
  return TARGET_API_HINTS.some((h) => lower.includes(String(h).toLowerCase()));
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

  // mostra as 20 últimas
  for (const h of hits.slice(-20)) {
    console.log(
      `⏱️  [+${String(h.t).padStart(5)}ms] ${h.method} ${h.url}\n` +
      `   🔑 Bearer: ${h.bearerMasked ?? "❌ não"} (hash:${h.bearerHash ?? "-"})\n` +
      `   🏢 Tenant: ${h.tenantId ? h.tenantId : "❌ não"} (hash:${h.tenantHash ?? "-"})\n` +
      `   🌐 Origin: ${h.origin ?? "-"} | Referer: ${h.referer ?? "-"}\n`
    );
  }
}

async function main() {
  console.log("🚀 Iniciando auditoria web...\n");

  const ERP_USER = process.env.ERP_USER ?? "Ramon";
  const ERP_PASS = process.env.ERP_PASS ?? "dev123";
  const FRONTEND_URL = process.env.FRONTEND_URL ?? "http://localhost:4200";
  const SWAGGER_URL = process.env.SWAGGER_URL ?? "";
  const HEADLESS = process.env.HEADLESS !== "false";
  const AUDIT_ERP = (process.env.AUDIT_ERP ?? "true").toLowerCase() === "true";
  const FRONTEND_OBSERVE_MS = parseInt(process.env.FRONTEND_OBSERVE_MS) || 20000;
  const WAIT_INTERACTIVE_MS = parseInt(process.env.WAIT_INTERACTIVE_MS) || 0;

  console.log(`📝 Configurações:`);
  console.log(`   Usuário: ${ERP_USER}`);
  console.log(`   Headless: ${HEADLESS}`);
  console.log(`   Endpoint alvo: ${TARGET_API}\n`);

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext();
  const page = await context.newPage();

  // (A) Captura as requests do frontend local (localhost:4200)
  // Aqui é onde normalmente nasce o Origin e onde o browser vai disparar chamadas pro backend.
  console.log(`\n🧭 Acessando Frontend local: ${FRONTEND_URL}`);
  const feHits = startNetworkAudit(page, { label: "frontend", onlyTarget: false });

  try {
    await page.goto(FRONTEND_URL, { waitUntil: "domcontentloaded", timeout: 15000 });
    console.log(`👀 Observando tráfego do frontend por ${FRONTEND_OBSERVE_MS}ms...`);
    await page.waitForTimeout(FRONTEND_OBSERVE_MS);

    if (WAIT_INTERACTIVE_MS > 0) {
      console.log(`🕹️  Modo espera: você tem ${WAIT_INTERACTIVE_MS}ms pra usar o app e disparar o POST do estoque...`);
      await page.waitForTimeout(WAIT_INTERACTIVE_MS);
    }
  } catch (err) {
    console.log(`⚠️  Aviso: Não foi possível acessar o frontend (${err.message})`);
  }

  printSummary(feHits, { title: "Frontend local (localhost:4200)" });

  // (A.2) Também destaca se o endpoint alvo já foi chamado pelo frontend
  const feTargetHits = feHits.filter((h) => h.method === "POST" && looksLikeTarget(h.url));
  console.log(`\n=== 🎯 Endpoint alvo via Frontend ===`);
  console.log(`Ocorrências: ${feTargetHits.length}`);
  for (const h of feTargetHits.slice(-10)) {
    console.log(
      `✅ POST ${h.url}\n` +
      `   🔑 Bearer: ${h.bearerMasked ?? "❌ não"}\n` +
      `   🏢 Tenant: ${h.tenantId ?? "❌ não"}\n`
    );
  }

  // (A.1) Swagger opcional (se você quiser inspecionar também)
  if (SWAGGER_URL && SWAGGER_URL.trim()) {
    console.log(`\n📡 Acessando Swagger (opcional): ${SWAGGER_URL}`);
    const swaggerHits = startNetworkAudit(page, { label: "swagger", onlyTarget: false });

    try {
      await page.goto(SWAGGER_URL, { waitUntil: "domcontentloaded", timeout: 15000 });
      await page.waitForTimeout(6000);
    } catch (err) {
      console.log(`⚠️  Aviso: Não foi possível acessar o Swagger (${err.message})`);
    }

    printSummary(swaggerHits, { title: "Swagger (opcional)" });
  }

  if (AUDIT_ERP) {
    // (B) Login no ERP e captura requests pós-login
    const erpHitsAll = startNetworkAudit(page, { label: "erp-all", onlyTarget: false });

    try {
      await loginERP(page, ERP_USER, ERP_PASS);
    } catch (err) {
      console.error(`\n❌ Erro no ERP (vou seguir mesmo assim): ${err?.message || err}`);
      console.log("💡 Dica: Se não precisar do ERP, defina AUDIT_ERP=false no .env");
      try {
        await page.screenshot({ path: "erp-error.png", fullPage: true });
        console.log("📸 Screenshot salvo em: erp-error.png");
      } catch {}
      // segue sem matar o script
      await browser.close();
      console.log("\n✨ Auditoria concluída (com falha no ERP).\n");
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

    // (C) Filtro só no endpoint alvo (InventoryStockSummary)
    const erpHitsTarget = erpHitsAll.filter((h) => h.method === "POST" && looksLikeTarget(h.url));

    console.log(`\n${"=".repeat(60)}`);
    console.log(`=== 🎯 Somente endpoint alvo (via ERP) ===`);
    console.log(`${"=".repeat(60)}`);
  console.log(`Endpoint (base): ${TARGET_API}`);
    console.log(`Ocorrências: ${erpHitsTarget.length}`);

    if (erpHitsTarget.length === 0) {
      console.log("\n⚠️  Nenhuma requisição para o endpoint alvo foi capturada via ERP!");
    } else {
      console.log("");
      for (const h of erpHitsTarget.slice(-10)) {
        console.log(
          `✅ POST ${h.url}\n` +
          `   🔑 Bearer: ${h.bearerMasked ?? "❌ não"}\n` +
          `   🏢 Tenant: ${h.tenantId ?? "❌ não"}\n`
        );
      }
    }
  } else {
    console.log("\nℹ️  AUDIT_ERP=false: pulando etapa do ERP.");
  }

  await browser.close();
  console.log("\n✨ Auditoria concluída!\n");
}

main().catch((e) => {
  console.error("\n💥 ERRO:", e?.message || e);
  console.error(e);
  process.exit(1);
});
