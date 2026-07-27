// ─────────────────────────────────────────────────────────────────────────
// Monitor de Escalas — Atividade Delegada PMESP
// Roda via GitHub Actions (veja .github/workflows/monitorar.yml), sem precisar
// do computador ligado. Faz login, entra na Atividade Delegada, pesquisa cada
// AISP configurada, varre a grade (com paginação) e avisa no Telegram quando
// aparece uma escala que ainda não tinha sido vista antes.
//
// Fluxo mapeado com o Playwright Codegen direto no site real (intranet):
//   1. http://intranet.policiamilitar.sp.gov.br/  → formulário de login fica
//      dentro de frames aninhados: frame[name="meio"] → frame#mainMS →
//      campos #vUSRNUMCPFAUX (CPF) e #vSENHA, botão "Confirmar".
//   2. Ao confirmar, abre uma POPUP (nova janela) com o sistema de verdade.
//   3. Nessa popup, clica na célula de menu "Inscrever PM na Escala Ativ Delegada".
//   4. A tela de pesquisa fica dentro de um iframe[name="Embpage"]. Na primeira
//      vez pode aparecer um checkbox "#vAPTO" + botão "Confirma" (declaração
//      de apto) — o script tenta, mas ignora se não aparecer.
//   5. Preenche AISP (#vIDFAGPGEOSST) e datas (#vDATINI/#vDATFIM) usando o MESMO
//      truque de injeção via API interna do GeneXus (gx.setVar + onchange) já
//      testado e usado há 290 versões no robô Tampermonkey — os campos de data
//      são um widget de calendário, não aceitam preenchimento direto de texto.
//   6. Clica em "Procurar" e lê a grade (#Grid1ContainerTbl), paginando pelo
//      botão #NEXT até acabar.
//
// ⚠️ Isso é a MELHOR aposta com base no que foi gravado manualmente uma vez —
// mas automação contra um sistema legado GeneXus é frágil. Se der erro, o
// workflow salva uma screenshot (erro.png) como artefato pra gente debugar
// junto olhando exatamente onde travou.
// ─────────────────────────────────────────────────────────────────────────

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const PMESP_USUARIO = process.env.PMESP_USUARIO;
const PMESP_SENHA = process.env.PMESP_SENHA;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Código(s) da(s) AISP/área que você quer monitorar, separados por vírgula.
// Os mesmos códigos já usados no seu robô Tampermonkey (MODOS_ROBO.DELEGADA.areas).
const AISPS_MONITORADAS = (process.env.PMESP_AISP || "82914").split(",").map(s => s.trim()).filter(Boolean);

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
    // evita o arquivo crescer pra sempre — mantém só os últimos 2000 registros
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

// ── Injeta um valor num campo GeneXus via API interna (mesmo truque do robô) ──
// Precisa de um objeto "Frame" de verdade (não FrameLocator) porque usa .evaluate().
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

// ── Login + navegação até a tela de pesquisa de escalas. Retorna a página (popup) ──
async function fazerLoginEAbrirDelegada(browserContext) {
    var page = await browserContext.newPage();
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });

    var loginFrame = page.frameLocator('frame[name="meio"]').frameLocator("#mainMS");
    await loginFrame.locator("#vUSRNUMCPFAUX").fill(PMESP_USUARIO);
    await loginFrame.locator("#vUSRNUMCPFAUX").press("Tab").catch(() => {});
    await loginFrame.locator("#vSENHA").fill(PMESP_SENHA);

    var popupPromise = page.waitForEvent("popup", { timeout: 30000 });
    await loginFrame.getByRole("button", { name: "Confirmar" }).click();
    var page1 = await popupPromise;
    await page1.waitForLoadState("domcontentloaded");
    await page1.waitForTimeout(1500);

    await page1.getByRole("cell", { name: "Inscrever PM na Escala Ativ Delegada" }).click({ timeout: 20000 });
    await page1.waitForTimeout(1500);
    await page1.waitForLoadState("networkidle").catch(() => {});

    // Tela de "declaração de apto" — só costuma aparecer às vezes / na primeira vez.
    // Tenta com timeout curto; se não achar, segue sem erro.
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
}

// ── Pesquisa uma AISP e lê todas as páginas da grade de escalas ────────────
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
    try {
        var context = await browser.newContext();
        page1 = await fazerLoginEAbrirDelegada(context);

        for (const aisp of AISPS_MONITORADAS) {
            var linhas = await pesquisarEscalas(page1, aisp);
            console.log("AISP " + aisp + ": " + linhas.length + " linha(s) na grade.");
            for (const l of linhas) {
                var chave = aisp + "_" + l.data + "_" + l.horaIni + "x" + l.horaFim + "_" + l.escalaId;
                if (!vistos.has(chave)) {
                    vistos.add(chave);
                    novos.push({ aisp: aisp, ...l });
                }
            }
        }
    } catch (err) {
        console.error("❌ Erro durante a checagem:", err);
        if (page1) { try { await page1.screenshot({ path: path.join(__dirname, "erro.png"), fullPage: true }); } catch (e) {} }
        if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
            await enviarTelegram("⚠️ O monitor de escalas deu erro: " + String(err).slice(0, 300)).catch(() => {});
        }
        salvarVistos(vistos);
        await browser.close();
        process.exit(1);
    }
    await browser.close();

    if (novos.length > 0) {
        console.log("🎉 " + novos.length + " escala(s) nova(s) encontrada(s)!");
        for (const n of novos) {
            var texto = "👀 <b>Escala disponível pra marcar!</b>\n" +
                "📍 AISP " + n.aisp + "\n" +
                "📅 " + n.data + "\n" +
                "🕐 " + n.horaIni + " x " + n.horaFim + "\n" +
                "🆔 Escala " + n.escalaId + "\n\n" +
                "Entre no site e se inscreva antes que alguém pegue!";
            await enviarTelegram(texto);
        }
    } else {
        console.log("Nada de novo nesta checagem.");
    }
    salvarVistos(vistos);
})();
