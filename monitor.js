// ─────────────────────────────────────────────────────────────────────────
// Monitor de Escalas — Atividade Delegada PMESP
// Roda via GitHub Actions (veja .github/workflows/monitorar.yml), sem precisar
// do computador ligado. Faz login, entra na Atividade Delegada, pesquisa cada
// AISP configurada, varre a grade (com paginação) e avisa no Telegram quando
// aparece uma escala que ainda não tinha sido vista antes — e sempre manda um
// resumo no final, ache ou não escala.
//
// Fluxo mapeado com o Playwright Codegen direto no site real (intranet):
//   1. http://intranet.policiamilitar.sp.gov.br/  → formulário de login fica
//      dentro de frames aninhados: frame[name="meio"] → frame#mainMS →
//      campos #vUSRNUMCPFAUX (CPF) e #vSENHA, botão "Confirmar".
//   2. Ao confirmar, abre uma POPUP (nova janela) com o sistema de verdade.
//   3. Nessa popup, passa o mouse em "SIRH" → "Escala" → clica em
//      "Inscrever PM na Escala Ativ Delegada".
//   4. A tela de pesquisa fica dentro de um iframe[name="Embpage"]. Na primeira
//      vez pode aparecer um checkbox "#vAPTO" + botão "Confirma" (declaração
//      de apto) — o script tenta, mas ignora se não aparecer.
//   5. Preenche AISP (#vIDFAGPGEOSST) e datas (#vDATINI/#vDATFIM) usando o MESMO
//      truque de injeção via API interna do GeneXus (gx.setVar + onchange) já
//      testado e usado há 290 versões no robô Tampermonkey — os campos de data
//      são um widget de calendário, não aceitam preenchimento direto de texto.
//   6. Clica em "Procurar" e lê a grade (#Grid1ContainerTbl), paginando pelo
//      botão #NEXT até acabar. Repete pra cada uma das 17 áreas.
// ─────────────────────────────────────────────────────────────────────────

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const PMESP_USUARIO = process.env.PMESP_USUARIO;
const PMESP_SENHA = process.env.PMESP_SENHA;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Todas as áreas da Atividade Delegada, as mesmas 17 do robô Tampermonkey
// (MODOS_ROBO.DELEGADA.areas). Usadas por padrão — se a variável de repositório
// PMESP_AISP estiver definida, ela sobrescreve essa lista (só os códigos, separados
// por vírgula) e monitora só as áreas escolhidas em vez de todas.
const TODAS_AREAS_DELEGADA = [
    { nome: "Centro Novo", aisp: "82913" },
    { nome: "Cenas Abertas de Uso", aisp: "85254" },
    { nome: "Rua Santa Ifigênia", aisp: "82904" },
    { nome: "Rua 25 de Março", aisp: "82903" },
    { nome: "Rua Florêncio de Abreu", aisp: "82912" },
    { nome: "Av. Liberdade", aisp: "82914" },
    { nome: "Praça da Sé", aisp: "85029" },
    { nome: "Triângulo Histórico", aisp: "82907" },
    { nome: "Av. Paulista", aisp: "82911" },
    { nome: "Praça Agente Cícero", aisp: "82875" },
    { nome: "Rua Ipanema", aisp: "82893" },
    { nome: "Equipe Volante Mooca", aisp: "82894" },
    { nome: "Rua José Paulino", aisp: "82906" },
    { nome: "Rua Monsenhor de Andrade", aisp: "82916" },
    { nome: "Rua Tiers - Vautier", aisp: "82892" },
    { nome: "Largo da Concórdia", aisp: "82905" },
    { nome: "Rua Oriente", aisp: "82910" }
];
function _nomeDaAisp(aisp) {
    var a = TODAS_AREAS_DELEGADA.find(function (x) { return x.aisp === aisp; });
    return a ? a.nome : aisp;
}
const AISPS_MONITORADAS = process.env.PMESP_AISP
    ? process.env.PMESP_AISP.split(",").map(s => s.trim()).filter(Boolean)
    : TODAS_AREAS_DELEGADA.map(a => a.aisp);

const LOGIN_URL = process.env.LOGIN_URL || "http://intranet.policiamilitar.sp.gov.br/";

const SEEN_PATH = path.join(__dirname, "seen.json");
const JANELA_DIAS = 45; // quantos dias a partir de hoje ele pesquisa (data início/fim do filtro)

function hoje() {
    return new Date();
}
function formatarDataBR(d) {
    return String(d.getDate()).padStart(2, "0") + "/" + String(d.getMonth() + 1).padStart(2, "0") + "/" + d.getFullYear();
}
function carregarVistos() {
    try { return new Set(JSON.parse(fs.readFileSync(SEEN_PATH, "utf8"))); } catch (e) { return new Set(); }
}
function salvarVistos(set) {
    var lista = Array.from(set);
    if (lista.length > 2000) lista = lista.slice(lista.length - 2000);
    fs.writeFileSync(SEEN_PATH, JSON.stringify(lista, null, 0));
}

async function enviarTelegram(texto) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        console.warn("⚠️ TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID não configurados — pulando envio.");
        return;
    }
    var url = "https://api.telegram.org/bot" + TELEGRAM_BOT_TOKEN + "/sendMessage";
    var resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: texto, parse_mode: "HTML" })
    });
    var data = await resp.json().catch(() => ({}));
    if (!data.ok) console.error("❌ Falha ao enviar Telegram:", JSON.stringify(data));
}

async function preencherCampoGX(frame, nomeCampo, valor) {
    return frame.evaluate(({ nomeCampo, valor }) => {
        if (typeof gx === "undefined" || !gx.O) return false;
        try {
            if (typeof gx.setGxO === "function") gx.setGxO(gx.O.CmpContext || "", gx.O.IsMasterPage || false);
            if (typeof gx.setVar === "function") {
                gx.setVar(nomeCampo, valor);
            } else if (typeof gx.O.setVariable === "function") {
                gx.O.setVariable(nomeCampo, valor);
                gx.O.setVariable("v" + nomeCampo, valor);
            }
            var el = (gx.dom && typeof gx.dom.el === "function") ? gx.dom.el(nomeCampo) : document.getElementById(nomeCampo);
            if (el) {
                el.value = valor;
                el.setAttribute("gxvalid", "1");
                if (typeof gx.evt !== "undefined" && typeof gx.evt.onchange === "function") gx.evt.onchange(el);
            }
            return true;
        } catch (e) { return false; }
    }, { nomeCampo, valor });
}

async function clicarAbaProcedimentosSeExistir(page) {
    for (const frame of page.frames()) {
        try {
            var loc = frame.locator("#sideBarTabGestao");
            if (await loc.count() > 0) {
                await loc.click({ timeout: 5000 });
                console.log("✅ Cliquei na aba 'Procedimentos'.");
                return true;
            }
        } catch (e) { /* tenta o próximo frame */ }
    }
    console.log("ℹ️ Não achei a aba 'Procedimentos' em nenhum frame — talvez já esteja visível.");
    return false;
}

async function fazerLoginEAbrirDelegada(browserContext, onErro) {
    var page = await browserContext.newPage();
    var page1 = null;
    try {
        await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
        await page.waitForLoadState("networkidle").catch(() => {});
        await page.waitForTimeout(3000);

        await clicarAbaProcedimentosSeExistir(page);
        await page.waitForTimeout(2000);
        await page.waitForLoadState("networkidle").catch(() => {});

        var loginFrame = page.frameLocator('frame[name="meio"]').frameLocator("#mainMS");
        await loginFrame.locator("#vUSRNUMCPFAUX").waitFor({ state: "visible", timeout: 45000 });
        await loginFrame.locator("#vUSRNUMCPFAUX").fill(PMESP_USUARIO);
        await loginFrame.locator("#vUSRNUMCPFAUX").press("Tab").catch(() => {});
        await loginFrame.locator("#vSENHA").fill(PMESP_SENHA);

        var popupPromise = page.waitForEvent("popup", { timeout: 30000 });
        await loginFrame.getByRole("button", { name: "Confirmar" }).click();
        page1 = await popupPromise;
        await page1.waitForLoadState("domcontentloaded");
        await page1.waitForTimeout(2000);

        await page1.locator("td.ThemeClassicMainFolderText", { hasText: "SIRH" }).hover({ timeout: 15000 });
        await page1.waitForTimeout(800);
        await page1.getByText("Escala", { exact: true }).first().hover({ timeout: 10000 });
        await page1.waitForTimeout(800);
        await page1.getByRole("cell", { name: "Inscrever PM na Escala Ativ Delegada" }).click({ timeout: 20000 });
        await page1.waitForTimeout(1500);
        await page1.waitForLoadState("networkidle").catch(() => {});

        try {
            var embFrameApto = page1.frameLocator('iframe[name="Embpage"]');
            await embFrameApto.locator("#vAPTO").check({ timeout: 3000 });
            await embFrameApto.getByRole("button", { name: "Confirma" }).click({ timeout: 3000 });
            await page1.waitForTimeout(1000);
            await page1.waitForLoadState("networkidle").catch(() => {});
        } catch (e) {
            console.log("ℹ️ Tela de declaração de apto não apareceu desta vez (ok, segue o fluxo).");
        }

        return page1;
    } catch (err) {
        if (typeof onErro === "function") await onErro(page1 || page, "login");
        throw err;
    }
}

async function pesquisarEscalas(page1, aisp) {
    var embFrame = page1.frameLocator('iframe[name="Embpage"]');
    var embFrameHandle = page1.frame({ name: "Embpage" });
    if (!embFrameHandle) throw new Error("Não achei o iframe Embpage — a estrutura da página pode ter mudado.");

    var dataIni = formatarDataBR(hoje());
    var dataFim = formatarDataBR(new Date(hoje().getTime() + JANELA_DIAS * 24 * 60 * 60 * 1000));

    await embFrame.locator("#vIDFAGPGEOSST").fill(aisp).catch(() => {});
    await preencherCampoGX(embFrameHandle, "vIDFAGPGEOSST", aisp);
    await preencherCampoGX(embFrameHandle, "vDATINI", dataIni);
    await preencherCampoGX(embFrameHandle, "vDATFIM", dataFim);

    await embFrame.getByRole("button", { name: "Procurar" }).click({ timeout: 15000 });
    await page1.waitForTimeout(1500);
    await page1.waitForLoadState("networkidle").catch(() => {});

    var resultados = [];
    var seguraPaginando = true;
    var paginasLidas = 0;
    while (seguraPaginando && paginasLidas < 50) {
        paginasLidas++;
        var linhasDaPagina = await embFrameHandle.evaluate(() => {
            var tabela = document.getElementById("Grid1ContainerTbl") ||
                document.querySelector('[id^="Grid1ContainerTbl"]') || document.querySelector(".GridCardTable");
            if (!tabela) return [];
            var linhas = tabela.querySelectorAll('tr[id^="Grid1ContainerRow"], tr.GridCardRow, tr.GridRow');
            var out = [];
            linhas.forEach(function (linha) {
                var colunas = linha.querySelectorAll("td");
                if (colunas.length < 7) return;
                out.push({
                    escalaId: colunas[2].textContent.trim(),
                    data: colunas[4].textContent.trim(),
                    horaIni: colunas[5].textContent.trim(),
                    horaFim: colunas[6].textContent.trim()
                });
            });
            return out;
        });
        resultados = resultados.concat(linhasDaPagina);

        var temProxima = await embFrameHandle.evaluate(() => {
            var btn = document.getElementById("NEXT");
            return !!(btn && btn.style.display !== "none" && btn.style.visibility !== "hidden");
        });
        if (!temProxima) { seguraPaginando = false; break; }
        await embFrame.locator("#NEXT").click().catch(() => { seguraPaginando = false; });
        await page1.waitForTimeout(1200);
        await page1.waitForLoadState("networkidle").catch(() => {});
    }
    return resultados;
}

(async function main() {
    if (!PMESP_USUARIO || !PMESP_SENHA) {
        console.error("❌ Defina PMESP_USUARIO e PMESP_SENHA nos Secrets do repositório.");
        process.exit(1);
    }
    var vistos = carregarVistos();
    var novos = [];
    var browser = await chromium.launch({ headless: true });
    var page1 = null;
    async function tirarScreenshotErro(pagina) {
        if (!pagina) return;
        try { await pagina.screenshot({ path: path.join(__dirname, "erro.png"), fullPage: true }); }
        catch (e) { console.error("⚠️ Não consegui tirar a screenshot de erro:", e.message); }
    }
    try {
        var context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
        page1 = await fazerLoginEAbrirDelegada(context, tirarScreenshotErro);

        var totalEncontradasPorArea = [];
        for (const aisp of AISPS_MONITORADAS) {
            var linhas = await pesquisarEscalas(page1, aisp);
            console.log("AISP " + aisp + " (" + _nomeDaAisp(aisp) + "): " + linhas.length + " linha(s) na grade.");
            if (linhas.length > 0) totalEncontradasPorArea.push({ aisp: aisp, nome: _nomeDaAisp(aisp), total: linhas.length });
            for (const l of linhas) {
                var chave = aisp + "_" + l.data + "_" + l.horaIni + "x" + l.horaFim + "_" + l.escalaId;
                if (!vistos.has(chave)) {
                    vistos.add(chave);
                    novos.push({ aisp: aisp, nome: _nomeDaAisp(aisp), ...l });
                }
            }
        }
    } catch (err) {
        console.error("❌ Erro durante a checagem:", err);
        if (page1 && !fs.existsSync(path.join(__dirname, "erro.png"))) await tirarScreenshotErro(page1);
        if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
            await enviarTelegram("⚠️ O monitor de escalas deu erro: " + String(err).slice(0, 300)).catch(() => {});
        }
        salvarVistos(vistos);
        await browser.close();
        process.exit(1);
    }
    await browser.close();

    var agora = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });

    if (novos.length > 0) {
        console.log("🎉 " + novos.length + " escala(s) nova(s) encontrada(s)!");
        for (const n of novos) {
            var texto = "👀 <b>Escala disponível pra marcar!</b>\n" +
                "📍 " + n.nome + " (AISP " + n.aisp + ")\n" +
                "📅 " + n.data + "\n" +
                "🕐 " + n.horaIni + " x " + n.horaFim + "\n" +
                "🆔 Escala " + n.escalaId + "\n\n" +
                "Entre no site e se inscreva antes que alguém pegue!";
            await enviarTelegram(texto);
        }
    } else {
        console.log("Nada de novo nesta checagem.");
    }

    var resumo = "🔎 <b>Checagem concluída</b> — " + agora + "\n" +
        AISPS_MONITORADAS.length + " área(s) verificada(s).\n\n";
    if (totalEncontradasPorArea.length > 0) {
        resumo += "Escalas disponíveis agora:\n" + totalEncontradasPorArea
            .map(function (a) { return "• " + a.nome + " (AISP " + a.aisp + "): " + a.total; })
            .join("\n") + "\n\n";
    } else {
        resumo += "Nenhuma escala disponível em nenhuma área agora.\n\n";
    }
    resumo += novos.length > 0
        ? ("🎉 " + novos.length + " são NOVAS desde a última checagem (aviso já mandado acima).")
        : "Nenhuma novidade desde a última checagem.";
    await enviarTelegram(resumo);

    salvarVistos(vistos);
})();
