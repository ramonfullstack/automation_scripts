# 🔍 Web Audit - Auditoria de Requisições Web

Ferramenta de auditoria automatizada que captura e analisa requisições HTTP, tokens Bearer e tenant IDs usando Playwright.

## 🎯 Funcionalidades

- ✅ Captura automática de requisições HTTP/HTTPS
- 🔑 Detecção e mascaramento seguro de tokens Bearer
- 🏢 Identificação de Tenant IDs nos headers
- 💾 Auditoria de LocalStorage, SessionStorage e Cookies
- 📊 Análise de endpoints específicos
- 🔒 Segurança: nunca expõe tokens completos (apenas hash e máscara)

## 📦 Instalação

```bash
# 1. Instalar dependências
npm install

# 2. Instalar browsers do Playwright
npm run install:browsers

# 3. Configurar credenciais
cp .env.example .env
# Edite o arquivo .env com suas credenciais
```

## 🔧 Configuração

Edite o arquivo `.env` com suas configurações:

```env
# Credenciais do ERP
ERP_USER=seu_usuario
ERP_PASS=sua_senha

# URLs
ERP_URL=https://erp.dev.inovepic.dev/#/login
FRONTEND_URL=http://localhost:4200

# (Opcional) Swagger
# SWAGGER_URL=http://localhost:5214/swagger
SWAGGER_URL=

# Endpoint alvo
TARGET_API=http://localhost:5214/api/InventoryStock/GetInventoryStockSummary

# Configurações opcionais
HEADLESS=true                # false para ver o browser aberto
TIMEOUT_LOGIN=4000          # Tempo de espera após login (ms)
TIMEOUT_OBSERVE=12000       # Tempo de observação do tráfego (ms)
```

## 🚀 Como Usar

### Auditoria Básica (Network Requests)

```bash
npm run audit
```

Captura:
- ✅ Requisições do **frontend local** (localhost:4200)
- ✅ Requisições após login no ERP
- ✅ Filtra endpoint específico (TARGET_API)
- ✅ Mostra tokens mascarados e tenant IDs

### Auditoria Completa (Network + LocalStorage + Cookies)

```bash
npm run audit:full
```

Captura tudo da auditoria básica, mais:
- ✅ Conteúdo do LocalStorage
- ✅ Conteúdo do SessionStorage
- ✅ Todos os cookies
- ✅ Detecção automática de valores que parecem tokens/tenants

## 📊 Exemplo de Saída

```
🚀 Iniciando auditoria web...

📝 Configurações:
   Usuário: Ramon
   Headless: true
   Endpoint alvo: http://localhost:5214/api/InventoryStock/GetInventoryStockSummary

🔐 Fazendo login no ERP...
✓ Campo de usuário encontrado: input[name="username"]
✓ Campo de senha encontrado: input[type="password"]
✓ Botão de login encontrado
⏳ Aguardando 4000ms para o login completar...
✓ Login concluído!

============================================================
=== ERP pós-login (todas requests) ===
============================================================
📊 Total capturadas: 45
🔑 Com Bearer:       23
🏢 Com x-tenantid:   23

⏱️  [+ 1234ms] POST http://localhost:5214/api/InventoryStock/GetInventoryStockSummary
   🔑 Bearer: Bearer eyJhbGciOiJI...xMjM0NTY3 (hash:a1b2c3d4e5f6)
   🏢 Tenant: 12345678-1234-1234-1234-123456789abc (hash:f6e5d4c3b2a1)
   🌐 Origin: http://localhost:4200 | Referer: http://localhost:4200/inventory
```

## 🛠️ Ajustes dos Seletores de Login

Se o script não conseguir fazer login automaticamente, você pode ajustar os seletores em `audit.mjs` ou `audit-full.mjs`:

```javascript
// Em loginERP(), ajuste estas listas:
const userCandidates = [
  'input[name="username"]',      // seu seletor aqui
  'input[id="user-input"]',      // adicione mais opções
];

const passCandidates = [
  'input[name="password"]',      // seu seletor aqui
  'input[id="pass-input"]',      // adicione mais opções
];
```

**Dica:** Quando o login falha, um screenshot é salvo em `login-error.png` para você analisar.

## 🔒 Segurança

⚠️ **IMPORTANTE**: Esta ferramenta nunca expõe tokens completos:

- ✅ Tokens são **mascarados** (mostra apenas início e fim)
- ✅ Usa **hash SHA-256** para fingerprinting seguro
- ✅ Arquivo `.env` está no `.gitignore` (não sobe para o Git)
- ✅ Tokens reais nunca aparecem nos logs

### O que você vê no console:

```
Bearer eyJhbGciOiJI...xMjM0NTY3
```

### O que NÃO aparece:

```
❌ NUNCA: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiIxMjM0NTY3...
```

## 📝 Estrutura do Projeto

```
web-audit/
├── audit.mjs              # Script de auditoria básico
├── audit-full.mjs         # Script com LocalStorage/Cookies
├── package.json           # Dependências
├── .env                   # Configurações (NÃO commitar!)
├── .env.example           # Template de configuração
├── .gitignore            # Ignora node_modules, .env, etc
└── README.md             # Este arquivo
```

## 🐛 Troubleshooting

### Erro: "Não achei input de usuário"

1. Execute com `HEADLESS=false` no `.env`
2. Observe o form de login visualmente
3. Abra DevTools no browser e inspecione os inputs
4. Ajuste os seletores em `loginERP()`

### Erro: "Nenhuma requisição capturada"

1. Verifique se as URLs estão corretas no `.env`
2. Aumente o `TIMEOUT_OBSERVE` para dar mais tempo
3. O endpoint pode não ser chamado automaticamente após o login
4. Você pode precisar navegar para uma página específica após o login

### Playwright não instalou os browsers

```bash
npx playwright install
# ou
npx playwright install chromium
```

## 🤝 Contribuindo

Sinta-se à vontade para abrir issues ou pull requests!

## 📄 Licença

ISC

---

**Desenvolvido com ❤️ por Ramon Silva**
