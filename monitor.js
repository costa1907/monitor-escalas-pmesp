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
//      testado e usado há centenas de versões no robô Tampermonkey — os campos de data
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
// ⚠️ Este script roda com a VPN da PMESP ligada, e a VPN vira o único caminho pra
// internet — por isso NÃO manda Telegram daqui (o Telegram fica inacessível atrás
// do túnel e o fetch trava em ETIMEDOUT). Em vez disso, só grava tudo num arquivo
// (resultado.json) que o script separado "notificar.js" lê e envia DEPOIS que a
// VPN já foi desconectada (veja o workflow monitorar.yml).
const RESULTADO_PATH = path.join(__dirname, "resultado.json");

// Todas as áreas da Atividade Delegada, as mesmas 18 do robô Tampermonkey
// (MODOS_ROBO.DELEGADA.areas, atualizado em 28/07/2026 — códigos novos 857xx).
// Usadas por padrão — se a variável de repositório PMESP_AISP estiver definida,
// ela sobrescreve essa lista (só os códigos, separados por vírgula) e monitora
// só as áreas escolhidas em vez de todas.
const TODAS_AREAS_DELEGADA = [
    { nome: "25 de Março", aisp: "85760" },
    { nome: "Florêncio de Abreu", aisp: "85759" },
    { nome: "José Paulino", aisp: "85758" },
    { nome: "Triângulo Histórico", aisp: "85757" },
    { nome: "Paulista", aisp: "85756" },
    { nome: "Centro Novo", aisp: "85755" },
    { nome: "Liberdade", aisp: "85754" },
    { nome: "Roosevelt", aisp: "85753" },
    { nome: "Sé", aisp: "85752" },
    { nome: "Marechal Deodoro", aisp: "85751" },
    { nome: "Santa Casa", aisp: "85750" },
    { nome: "Cambuci", aisp: "85749" },
    { nome: "Santa Ifigênia", aisp: "85748" },
    { nome: "Volante Cenas Abertas de Uso", aisp: "85745" },
    { nome: "Oriente", aisp: "85744" },
    { nome: "Concórdia", aisp: "85743" },
    { nome: "Brás", aisp: "85742" },
    { nome: "Feira da Madrugada", aisp: "85741" }
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
    // evita o arquivo crescer pra sempre — mantém só os últimos 2000 registros
    if (lista.length > 2000) lista = lista.slice(lista.length - 2000);
    fs.writeFileSync(SEEN_PATH, JSON.stringify(lista, null, 0));
}

function salvarResultado(obj) {
    fs.writeFileSync(RESULTADO_PATH, JSON.stringify(obj, null, 0));
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

// ── Clica na aba "Procedimentos" (barra azul vertical) que revela o formulário de
// login — procura em todos os frames da página, já que não sabemos de antemão em
// qual frame exatamente ela vive.
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

// ── Login + navegação até a tela de pesquisa de escalas. Retorna a página (popup) ──
// "onErro" é chamado com QUALQUER página aberta no momento da falha, pra sempre
// conseguirmos tirar uma screenshot de debug, mesmo se travar antes da popup abrir.
async function fazerLoginEAbrirDelegada(browserContext, onErro) {
    var page = await browserContext.newPage();
    var page1 = null;
    try {
        await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
        // dá tempo extra pra página terminar de montar os frames antes de mexer neles
        // (timeout curto: o site fica com requisições de fundo o tempo todo, então
        // "networkidle" quase nunca dispara de verdade — sem o timeout curto, isso
        // ficava até 30s parado à toa em cada uma dessas esperas)
        await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(1500);

        // a tela inicial mostra o portal (avisos, calendário) — o formulário de login só
        // aparece depois de clicar na aba "Procedimentos" da barra lateral esquerda
        await clicarAbaProcedimentosSeExistir(page);
        await page.waitForTimeout(1000);
        await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});

        var loginFrame = page.frameLocator('frame[name="meio"]').frameLocator("#mainMS");
        await loginFrame.locator("#vUSRNUMCPFAUX").waitFor({ state: "visible", timeout: 45000 });
        await loginFrame.locator("#vUSRNUMCPFAUX").fill(PMESP_USUARIO);
        await loginFrame.locator("#vUSRNUMCPFAUX").press("Tab").catch(() => {});
        await loginFrame.locator("#vSENHA").fill(PMESP_SENHA);

        var popupPromise = page.waitForEvent("popup", { timeout: 30000 });
        await loginFrame.getByRole("button", { name: "Confirmar" }).click();
        page1 = await popupPromise;
        await page1.waitForLoadState("domcontentloaded");
        await page1.waitForTimeout(1200);

        // Menu em cascata: passa o mouse em "SIRH" → abre submenu "Escala" → passa o
        // mouse nele → abre o submenu final com "Inscrever PM na Escala Ativ Delegada".
        // Precisa do hover em cada nível (não é link direto, é JS de onmouseover).
        await page1.locator("td.ThemeClassicMainFolderText", { hasText: "SIRH" }).hover({ timeout: 15000 });
        await page1.waitForTimeout(500);
        await page1.getByText("Escala", { exact: true }).first().hover({ timeout: 10000 });
        await page1.waitForTimeout(500);
        await page1.getByRole("cell", { name: "Inscrever PM na Escala Ativ Delegada" }).click({ timeout: 20000 });
        // O robô Tampermonkey usa 1500ms aqui de propósito (DELAY_TRAVA_VE_CLIQUE_MS) —
        // o comentário original dele já avisa que esse postback específico demora mais
        // que os outros, então mantém esse valor testado em vez de um menor.
        await page1.waitForTimeout(1500);
        await page1.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});

        // Tela de "declaração de apto" — só costuma aparecer às vezes / na primeira vez.
        // Tenta com timeout curto; se não achar, segue sem erro.
        try {
            var embFrameApto = page1.frameLocator('iframe[name="Embpage"]');
            await embFrameApto.locator("#vAPTO").check({ timeout: 3000 });
            await embFrameApto.getByRole("button", { name: "Confirma" }).click({ timeout: 3000 });
            await page1.waitForTimeout(700);
            await page1.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
        } catch (e) {
            console.log("ℹ️ Tela de declaração de apto não apareceu desta vez (ok, segue o fluxo).");
        }

        return page1;
    } catch (err) {
        if (typeof onErro === "function") await onErro(page1 || page, "login");
        throw err;
    }
}

// ── Lê as linhas da grade atual (dentro do frame Embpage) ──────────────────
function _lerLinhasGrade() {
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
}

// ── Lê o "Total de Registros: N" que a própria grade mostra no rodapé — serve
// pra saber quantas escalas REALMENTE existem pra essa AISP, e comparar com o
// que a paginação conseguiu capturar (detecta se o clique em "Próxima" falhou
// silenciosamente e parou cedo demais).
function _lerTotalRegistros() {
    try {
        var corpo = document.body ? document.body.innerText : "";
        var m = corpo.match(/Total de Registros:\s*([\d.]+)/i);
        if (!m) return null;
        return parseInt(m[1].replace(/\./g, ""), 10);
    } catch (e) { return null; }
}

// ── Clica no botão "Próxima página" via API interna do GeneXus (mesmo truque
// do robô Tampermonkey — clique "visual" simples não dispara o evento certo
// e a grade não muda de página de verdade, mesmo o botão continuando visível).
async function clicarProximaPaginaGX(frame) {
    return frame.evaluate(() => {
        var btn = document.getElementById("NEXT");
        if (!btn) return false;
        try {
            if (typeof btn.focus === "function") btn.focus();
            var ctx = (typeof gx !== "undefined" && gx.O) ? (gx.O.CmpContext || "") : "";
            if (typeof gx !== "undefined" && gx.evt && typeof gx.evt.execEvt === "function") {
                try { gx.evt.execEvt(ctx + "ENEXT.CLICK.", btn); return true; } catch (e) {}
            }
            if (typeof btn.onclick === "function") { btn.onclick(); return true; }
            btn.click();
            return true;
        } catch (e) { return false; }
    });
}

// ── Pesquisa uma AISP e lê todas as páginas da grade de escalas ────────────
// "fingerprintAnteriorGlobal" é o retrato da grade de ANTES desta busca (última
// página da AISP anterior, ou null na primeira). Serve pra confirmar que a busca
// nova realmente carregou antes de começar a ler — sem isso, dá pra ler a grade
// antiga por engano bem no instante da troca de AISP.
async function pesquisarEscalas(page1, aisp, fingerprintAnteriorGlobal) {
    console.log("🔎 Pesquisando " + _nomeDaAisp(aisp) + " (AISP " + aisp + ")...");
    var embFrame = page1.frameLocator('iframe[name="Embpage"]');
    var embFrameHandle = page1.frame({ name: "Embpage" });
    if (!embFrameHandle) throw new Error("Não achei o iframe Embpage — a estrutura da página pode ter mudado.");

    var dataIni = formatarDataBR(hoje());
    var dataFim = formatarDataBR(new Date(hoje().getTime() + JANELA_DIAS * 24 * 60 * 60 * 1000));

    await embFrame.locator("#vIDFAGPGEOSST").fill(aisp).catch(() => {});
    await preencherCampoGX(embFrameHandle, "vIDFAGPGEOSST", aisp);
    await preencherCampoGX(embFrameHandle, "vDATINI", dataIni);
    await preencherCampoGX(embFrameHandle, "vDATFIM", dataFim);

    // Mesma pausa curta que o robô Tampermonkey dá antes de clicar em Pesquisar
    // (DELAY_PRE_PESQUISA_MS) — dá tempo do GeneXus assimilar os campos preenchidos
    // via injeção antes do clique, evitando pesquisar com o formulário "pela metade".
    await page1.waitForTimeout(150);
    await embFrame.getByRole("button", { name: "Procurar" }).click({ timeout: 15000 });

    // Espera a busca desta AISP carregar de verdade: fica checando a cada 300ms
    // (até ~12s) se a grade mudou em relação ao estado anterior (outra AISP ou
    // outra página). Se nunca mudar (ex: as duas realmente estão vazias), segue
    // com o que tiver depois do teto de tentativas.
    var linhasAtuais = null;
    var fingerprintAtual = null;
    for (var t = 0; t < 40; t++) {
        await page1.waitForTimeout(300);
        var linhasTeste = await embFrameHandle.evaluate(_lerLinhasGrade);
        var fpTeste = JSON.stringify(linhasTeste);
        if (fpTeste !== fingerprintAnteriorGlobal) {
            linhasAtuais = linhasTeste;
            fingerprintAtual = fpTeste;
            break;
        }
    }
    if (linhasAtuais === null) {
        linhasAtuais = await embFrameHandle.evaluate(_lerLinhasGrade);
        fingerprintAtual = JSON.stringify(linhasAtuais);
    }

    var totalEsperado = await embFrameHandle.evaluate(_lerTotalRegistros).catch(() => null);
    if (totalEsperado !== null) {
        console.log("   (a grade indica " + totalEsperado + " registro(s) no total pra essa AISP)");
    }

    var resultados = [];
    var paginasLidas = 0;
    var MAX_PAGINAS = 30; // teto de segurança — uma AISP real não deveria chegar nem perto disso

    while (paginasLidas < MAX_PAGINAS) {
        paginasLidas++;
        resultados = resultados.concat(linhasAtuais);
        console.log("   página " + paginasLidas + ": " + linhasAtuais.length + " escala(s)" +
            (linhasAtuais.length > 0 ? " — ex: escala " + linhasAtuais[0].escalaId + " em " + linhasAtuais[0].data : "") +
            (totalEsperado !== null ? " (capturado até agora: " + resultados.length + "/" + totalEsperado + ")" : ""));

        // Se já capturamos tudo que a própria grade disse que existe, não precisa
        // nem tentar clicar em "Próxima" de novo.
        if (totalEsperado !== null && resultados.length >= totalEsperado) break;

        var temProxima = await embFrameHandle.evaluate(() => {
            var btn = document.getElementById("NEXT");
            return !!(btn && btn.style.display !== "none" && btn.style.visibility !== "hidden" && !btn.disabled);
        });
        if (!temProxima) break;

        // O clique em "Próxima" às vezes não "pega" na primeira (flakiness do
        // postback do GeneXus) — em vez de desistir da AISP inteira no primeiro
        // clique sem efeito, tenta de novo até 3 vezes antes de encerrar.
        var mudou = false;
        for (var tentativaClique = 0; tentativaClique < 3 && !mudou; tentativaClique++) {
            await clicarProximaPaginaGX(embFrameHandle);

            // O postback do GeneXus pode demorar mais que um tempo fixo — em vez de
            // esperar um valor fixo e arriscar ler a grade antes dela atualizar,
            // fica checando a cada 300ms (até ~8s) se a grade realmente mudou.
            for (var tentativa = 0; tentativa < 27; tentativa++) {
                await page1.waitForTimeout(300);
                var novasLinhas = await embFrameHandle.evaluate(_lerLinhasGrade);
                var novoFingerprint = JSON.stringify(novasLinhas);
                if (novoFingerprint !== fingerprintAtual) {
                    linhasAtuais = novasLinhas;
                    fingerprintAtual = novoFingerprint;
                    mudou = true;
                    break;
                }
            }
            if (!mudou && tentativaClique < 2) {
                console.log("   ⚠️ Clique em 'Próxima' não teve efeito — tentando de novo (tentativa " + (tentativaClique + 2) + "/3)...");
            }
        }
        if (!mudou) {
            console.log("⚠️ Página não mudou mesmo após 3 tentativas de clique — encerrando paginação da AISP " + aisp + ".");
            break;
        }
    }
    return { linhas: resultados, ultimoFingerprint: fingerprintAtual };
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

        var resultadoPorArea = []; // { aisp, nome, total } — TODAS as áreas verificadas, mesmo com 0
        var fingerprintAnteriorGlobal = null;
        for (const aisp of AISPS_MONITORADAS) {
            var resultadoBusca = await pesquisarEscalas(page1, aisp, fingerprintAnteriorGlobal);
            var linhas = resultadoBusca.linhas;
            fingerprintAnteriorGlobal = resultadoBusca.ultimoFingerprint;
            console.log("AISP " + aisp + " (" + _nomeDaAisp(aisp) + "): " + linhas.length + " linha(s) na grade.");
            resultadoPorArea.push({ aisp: aisp, nome: _nomeDaAisp(aisp), total: linhas.length });
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
        // se a screenshot já não foi tirada dentro do login, tenta tirar de page1 aqui
        if (page1 && !fs.existsSync(path.join(__dirname, "erro.png"))) await tirarScreenshotErro(page1);
        salvarResultado({ erro: String(err).slice(0, 300), novos: [], resultadoPorArea: [] });
        salvarVistos(vistos);
        await browser.close();
        process.exit(1);
    }
    await browser.close();

    if (novos.length > 0) {
        console.log("🎉 " + novos.length + " escala(s) nova(s) encontrada(s)!");
    } else {
        console.log("Nada de novo nesta checagem.");
    }

    var agora = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
    salvarResultado({ agora: agora, novos: novos, resultadoPorArea: resultadoPorArea });

    salvarVistos(vistos);
})();
