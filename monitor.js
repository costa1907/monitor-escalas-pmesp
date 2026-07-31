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
        // aparece depois de clicar na aba "Procedimentos" da barra lateral esquerda.
        // Em vez de clicar uma vez só e esperar 45s no vazio (se o clique não tiver
        // "pegado" por algum motivo, isso só desperdiça tempo até estourar o timeout),
        // fica tentando de novo — reclicando a aba a cada tentativa — até o campo de
        // login realmente aparecer visível, com um teto total generoso.
        // O campo de login fica dentro de um iframe próprio (#mainMS, que carrega
        // http://ms.policiamilitar.sp.gov.br/login.aspx — uma navegação de rede
        // separada da página principal). Só clicar na aba não garante que essa
        // navegação já terminou; por isso espera o próprio iframe carregar antes
        // de checar se o campo está visível.
        var loginFrame = page.frameLocator('frame[name="meio"]').frameLocator("#mainMS");
        var campoLoginVisivel = false;
        for (var tentativaAba = 1; tentativaAba <= 4 && !campoLoginVisivel; tentativaAba++) {
            await clicarAbaProcedimentosSeExistir(page);
            await page.waitForTimeout(500);
            var msFrame = page.frames().find(function (f) { return f.url().indexOf("login.aspx") !== -1; });
            if (msFrame) {
                await msFrame.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {});
            }
            await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
            try {
                await loginFrame.locator("#vUSRNUMCPFAUX").waitFor({ state: "visible", timeout: 12000 });
                campoLoginVisivel = true;
            } catch (e) {
                if (tentativaAba < 4) {
                    console.log("ℹ️ Campo de login ainda não apareceu — tentando clicar em 'Procedimentos' de novo (tentativa " + (tentativaAba + 1) + "/4)...");
                }
            }
        }
        if (!campoLoginVisivel) {
            // última tentativa, com o timeout mais generoso de todos, antes de desistir de vez
            await loginFrame.locator("#vUSRNUMCPFAUX").waitFor({ state: "visible", timeout: 20000 });
        }
        await loginFrame.locator("#vUSRNUMCPFAUX").fill(PMESP_USUARIO);
        await loginFrame.locator("#vUSRNUMCPFAUX").press("Tab").catch(() => {});
        await loginFrame.locator("#vSENHA").fill(PMESP_SENHA);

        var popupPromise = page.waitForEvent("popup", { timeout: 30000 });
        await loginFrame.getByRole("button", { name: "Confirmar" }).click();
        page1 = await popupPromise;
        await page1.waitForLoadState("domcontentloaded");
        await page1.waitForTimeout(1200);

        // Não abre a tela de pesquisa aqui — cada chamada de pesquisarEscalas() já
        // abre (de novo) do zero pra cada AISP, então abrir aqui só duplicaria a
        // navegação à toa na primeira AISP do run.

        return page1;
    } catch (err) {
        if (typeof onErro === "function") await onErro(page1 || page, "login");
        throw err;
    }
}

// ── Navega (de novo) até a tela de pesquisa "Inscrever PM na Escala Ativ
// Delegada", recarregando o iframe Embpage do zero. IMPORTANTE (bug real
// corrigido): reaproveitar o MESMO iframe entre buscas de AISPs diferentes
// deixava a paginação "grudada" na posição da busca anterior — a 1ª AISP
// terminava na página 9 (a última), e ao pesquisar a 2ª AISP no mesmo iframe
// a grade tentava mostrar essa mesma "página 9", que não existe no resultado
// novo (menor), voltando vazia — e por isso "Próxima" também não tinha efeito
// (já não tinha pra onde avançar a partir de uma página inválida). Reabrir a
// tela do zero pra CADA AISP garante que a grade e a paginação sempre começam
// limpas, do jeito que aconteceu certinho na primeiríssima busca do run.
// "verificarApto": só precisa ser true na 1ª vez que a tela abre depois do
// login — essa declaração some depois disso. Nas outras 17 reaberturas (uma
// por AISP), pedir pra checar mesmo assim custava 3s inteiros de timeout
// procurando um checkbox que não existe mais, à toa, em TODA busca — um dos
// maiores desperdícios de tempo do run inteiro (~50s no total num run de 18 AISPs).
async function abrirTelaPesquisaDelegada(page1, verificarApto) {
    // Menu em cascata: passa o mouse em "SIRH" → abre submenu "Escala" → passa o
    // mouse nele → abre o submenu final com "Inscrever PM na Escala Ativ Delegada".
    // Precisa do hover em cada nível (não é link direto, é JS de onmouseover).
    // REVERTIDO: tentei reduzir essas pausas (500→300ms, networkidle 3000→1200ms)
    // numa passada de performance, e isso reabriu a mesma classe de bug — a busca
    // passou a ler um iframe que ainda não tinha carregado de verdade (grade sempre
    // vazia, "Total de Registros" nem aparecia mais no log). Essa janela de tempo
    // entre clicar no menu e a tela nova estar pronta de fato é sensível demais pra
    // cortar; voltando aos valores testados e comprovadamente estáveis.
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

    if (!verificarApto) return;

    // Tela de "declaração de apto" — só costuma aparecer às vezes / na primeira vez.
    // Tenta com timeout curto; se não achar, segue sem erro.
    try {
        var embFrameApto = page1.frameLocator('iframe[name="Embpage"]');
        await embFrameApto.locator("#vAPTO").check({ timeout: 3000 });
        await embFrameApto.getByRole("button", { name: "Confirma" }).click({ timeout: 3000 });
        await page1.waitForTimeout(700);
        await page1.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
    } catch (e) {
        // ok, não aparece de novo depois da primeira vez — segue o fluxo
    }
}

// ── Lê as linhas da grade atual (dentro do frame Embpage) ──────────────────
// TODOS os campos agora são lidos por ID FIXO do GeneXus (confirmado direto no
// HTML real da página, uma linha completa que o usuário copiou do DevTools) —
// nada mais depende de posição de coluna, que já causou vários bugs (célula
// virando input em vez de texto puro, índice errado, etc). Os IDs de cada
// linha terminam em "_NNNN" (0001, 0002, ...), então busca por prefixo.
//   span_vESCOPRIDFAUX_   → ID da escala
//   span_vGRIDDATESC_     → Data
//   span_vGRIDHORINI_     → Hora Início
//   span_vGRIDHORTER_     → Hora Término
//   span_vESCOPRDATFIMISC_→ Data Limite de Inscrição
//   span_vESCOPRQTDTOT_   → Efetivo Total (vagas)
//   span_vGRIDINSTOT_     → Inscritos
// IMPORTANTE: como essa função é passada pro navegador via frame.evaluate(), o
// Playwright manda só o código DELA (não de funções "vizinhas" no arquivo) — por
// isso qualquer helper precisa estar declarado AQUI DENTRO, não fora.
function _lerLinhasGrade() {
    function porPrefixo(linha, prefixo) {
        var el = linha.querySelector('[id^="' + prefixo + '"]');
        return el ? (el.textContent || "").trim() : "";
    }
    var linhas = document.querySelectorAll('tr[id^="Grid1ContainerRow"]');
    var out = [];
    linhas.forEach(function (linha) {
        var escalaId = porPrefixo(linha, "span_vESCOPRIDFAUX_");
        if (!escalaId) return; // linha "fantasma"/sem dados válidos — ignora
        out.push({
            escalaId: escalaId,
            data: porPrefixo(linha, "span_vGRIDDATESC_"),
            horaIni: porPrefixo(linha, "span_vGRIDHORINI_"),
            horaFim: porPrefixo(linha, "span_vGRIDHORTER_"),
            dataLimite: porPrefixo(linha, "span_vESCOPRDATFIMISC_"),
            efetivoTotal: porPrefixo(linha, "span_vESCOPRQTDTOT_"),
            inscritos: porPrefixo(linha, "span_vGRIDINSTOT_")
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
            // Reproduz EXATAMENTE o onclick real do botão (confirmado no HTML da
            // página: onclick="if( gx.evt.jsEvent(this)) {gx.evt.execEvt('ENEXT.CLICK.',this);
            // return false;} else return false;") — sem nenhum prefixo de contexto
            // colado no nome do evento, que era uma suposição errada da versão anterior
            // e podia fazer o clique "não fazer nada" silenciosamente.
            if (typeof gx !== "undefined" && gx.evt && typeof gx.evt.jsEvent === "function" && typeof gx.evt.execEvt === "function") {
                if (gx.evt.jsEvent(btn)) {
                    gx.evt.execEvt("ENEXT.CLICK.", btn);
                    return true;
                }
                return false;
            }
            if (typeof btn.onclick === "function") { btn.onclick(); return true; }
            btn.click();
            return true;
        } catch (e) { return false; }
    });
}

// ── Clica no botão "Procurar" via API interna do GeneXus — mesma ideia do botão
// "Próxima": reproduz EXATAMENTE o onclick real (confirmado no HTML da página:
// id="IMAGE1", onclick="if( gx.evt.jsEvent(this)) {gx.evt.execEvt('E\'PROCURAR\'.',this);
// return false;} else return false;"), em vez de depender de um clique "simulado"
// via seletor de texto/role, que é mais frágil.
async function clicarProcurarGX(frame) {
    return frame.evaluate(() => {
        var btn = document.getElementById("IMAGE1");
        if (!btn) return false;
        try {
            if (typeof btn.focus === "function") btn.focus();
            if (typeof gx !== "undefined" && gx.evt && typeof gx.evt.jsEvent === "function" && typeof gx.evt.execEvt === "function") {
                if (gx.evt.jsEvent(btn)) {
                    gx.evt.execEvt("E'PROCURAR'.", btn);
                    return true;
                }
                return false;
            }
            if (typeof btn.onclick === "function") { btn.onclick(); return true; }
            btn.click();
            return true;
        } catch (e) { return false; }
    });
}

// ── Pesquisa uma AISP e lê todas as páginas da grade de escalas ────────────
// IMPORTANTE: a confirmação de que a busca carregou compara com o estado da
// PRÓPRIA grade capturado bem antes de clicar em "Procurar" (não com o resultado
// da AISP anterior). Isso corrige um bug real: na primeira AISP da lista não
// existe "resultado anterior" (era null), e a grade nesse momento pode estar
// num estado transitório (ex: "[]" ainda carregando) que já diferia de null —
// fazendo o código aceitar uma leitura vazia/incompleta como se already fosse o
// resultado final, mesmo a busca ainda não tendo terminado de verdade.
async function pesquisarEscalas(page1, aisp) {
    console.log("🔎 Pesquisando " + _nomeDaAisp(aisp) + " (AISP " + aisp + ")...");

    // Reabre a tela de pesquisa do zero pra CADA AISP (não só na primeira vez do
    // run) — corrige o bug em que a paginação ficava "grudada" na posição da AISP
    // anterior, fazendo a grade vir vazia mesmo com resultado de verdade disponível.
    // Só verifica a declaração de "apto" na 1ª AISP do run (ela não aparece de novo
    // depois disso, então checar nas outras 17 só desperdiçava ~3s cada à toa).
    await abrirTelaPesquisaDelegada(page1, aisp === AISPS_MONITORADAS[0]);

    var embFrame = page1.frameLocator('iframe[name="Embpage"]');

    var dataIni = formatarDataBR(hoje());
    var dataFim = formatarDataBR(new Date(hoje().getTime() + JANELA_DIAS * 24 * 60 * 60 * 1000));

    // IMPORTANTE (bug real corrigido): pegar a referência bruta do frame (via
    // page1.frame({name:...})) ANTES do iframe recarregado terminar de assentar é
    // arriscado — se o postback ainda estiver trocando o conteúdo do iframe nesse
    // instante, essa referência pode ficar presa numa versão velha/prestes a ser
    // destruída, e toda leitura feita nela depois fica "morta" pra sempre (grade
    // sempre vazia, sem nenhum erro visível). Por isso a ordem agora é: primeiro
    // espera o campo aparecer usando o FRAME LOCATOR (que sempre resolve pro iframe
    // ATUAL, robusto a troca/reload) — só DEPOIS disso confirmado é que pegamos a
    // referência bruta do frame pra usar com .evaluate() no resto da função.
    await embFrame.locator("#vIDFAGPGEOSST").waitFor({ state: "visible", timeout: 20000 });

    var embFrameHandle = page1.frame({ name: "Embpage" });
    if (!embFrameHandle) throw new Error("Não achei o iframe Embpage — a estrutura da página pode ter mudado.");

    // Mesmo com o campo já visível, a API interna do GeneXus (window.gx / gx.O)
    // pode levar um instante a mais pra ficar pronta — espera de verdade em vez de
    // confiar em tempo fixo, já que preencherCampoGX depende dela.
    await embFrameHandle.waitForFunction(
        () => typeof gx !== "undefined" && !!gx.O && typeof gx.O.setVariable === "function" || (typeof gx !== "undefined" && typeof gx.setVar === "function"),
        { timeout: 10000 }
    ).catch(() => {
        console.log("   ⚠️ API interna do GeneXus (gx.O) não respondeu dentro do prazo — seguindo mesmo assim.");
    });

    // Retrato da grade ANTES de mexer em qualquer coisa — essa é a base de
    // comparação usada logo abaixo, pra garantir que detectamos uma mudança real.
    var fingerprintAntes = JSON.stringify(await embFrameHandle.evaluate(_lerLinhasGrade));

    await embFrame.locator("#vIDFAGPGEOSST").fill(aisp).catch(() => {});
    await preencherCampoGX(embFrameHandle, "vIDFAGPGEOSST", aisp);
    await preencherCampoGX(embFrameHandle, "vDATINI", dataIni);
    await preencherCampoGX(embFrameHandle, "vDATFIM", dataFim);

    // Mesma pausa curta que o robô Tampermonkey dá antes de clicar em Pesquisar
    // (DELAY_PRE_PESQUISA_MS) — dá tempo do GeneXus assimilar os campos preenchidos
    // via injeção antes do clique, evitando pesquisar com o formulário "pela metade".
    await page1.waitForTimeout(150);
    var clicouProcurar = await clicarProcurarGX(embFrameHandle);
    if (!clicouProcurar) {
        // fallback de segurança: clique "real" via Playwright, caso o botão IMAGE1
        // não exista por algum motivo (ex: id mudou numa atualização do site)
        await embFrame.getByRole("button", { name: "Procurar" }).click({ timeout: 15000 }).catch(() => {});
    }

    // Espera a busca desta AISP carregar de verdade: fica checando a cada 300ms
    // (até ~12s) se a grade mudou em relação ao estado de ANTES de clicar em
    // Procurar. Se nunca mudar (ex: realmente não tem nenhuma escala), segue
    // com o que tiver depois do teto de tentativas.
    // IMPORTANTE (bug real corrigido): ao trocar de AISP, a grade passa por um
    // instante em que fica "limpa" (vazia) enquanto o postback processa a nova
    // busca, ANTES dos dados novos aparecerem. Esse instante vazio já é diferente
    // do "fingerprintAntes" (que tinha os dados da AISP anterior) — então aceitar
    // a PRIMEIRA leitura diferente como resultado final fazia o código travar
    // nesse instante vazio e reportar "0 escalas" mesmo quando a AISP tinha
    // resultado de verdade. Corrigido exigindo que a MESMA leitura apareça duas
    // vezes seguidas (2 ciclos de 300ms) antes de aceitar como estável — um
    // estado passageiro de "limpando" não se repete, só o resultado real fica.
    var linhasAtuais = null;
    var fingerprintAtual = null;
    var candidatoFingerprint = null;
    var candidatoLinhas = null;
    for (var t = 0; t < 40; t++) {
        await page1.waitForTimeout(300);
        var linhasTeste = await embFrameHandle.evaluate(_lerLinhasGrade);
        var fpTeste = JSON.stringify(linhasTeste);
        if (fpTeste === fingerprintAntes) {
            candidatoFingerprint = null; // ainda não mudou nada — reseta candidato
            continue;
        }
        if (fpTeste === candidatoFingerprint) {
            // mesma leitura confirmada 2x seguidas — considera estável de verdade
            linhasAtuais = linhasTeste;
            fingerprintAtual = fpTeste;
            break;
        }
        candidatoFingerprint = fpTeste;
        candidatoLinhas = linhasTeste;
    }
    if (linhasAtuais === null) {
        // não deu tempo de confirmar 2x dentro do prazo — usa a última leitura
        // candidata que já tinha (melhor que nada), ou lê de novo como último recurso
        if (candidatoLinhas !== null) {
            linhasAtuais = candidatoLinhas;
            fingerprintAtual = candidatoFingerprint;
        } else {
            linhasAtuais = await embFrameHandle.evaluate(_lerLinhasGrade);
            fingerprintAtual = JSON.stringify(linhasAtuais);
        }
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

            // Mesma proteção contra "estado passageiro" usada na busca inicial:
            // só aceita a página nova como estável depois de ler a MESMA coisa
            // 2 vezes seguidas — evita travar num instante de transição vazio.
            var candFp = null;
            var candLinhas = null;
            for (var tentativa = 0; tentativa < 27; tentativa++) {
                await page1.waitForTimeout(300);
                var novasLinhas = await embFrameHandle.evaluate(_lerLinhasGrade);
                var novoFingerprint = JSON.stringify(novasLinhas);
                if (novoFingerprint === fingerprintAtual) continue;
                if (novoFingerprint === candFp) {
                    linhasAtuais = novasLinhas;
                    fingerprintAtual = novoFingerprint;
                    mudou = true;
                    break;
                }
                candFp = novoFingerprint;
                candLinhas = novasLinhas;
            }
            if (!mudou && candLinhas !== null) {
                // não deu tempo de confirmar 2x, mas teve pelo menos uma leitura
                // diferente — melhor aproveitar do que nada
                linhasAtuais = candLinhas;
                fingerprintAtual = candFp;
                mudou = true;
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
    // Proteção extra contra página duplicada (visto num run real: 90 linhas capturadas
    // pra uma AISP que a própria grade dizia ter só 82 — uma página repetiu conteúdo
    // de outra). Deduplica por ID da escala antes de devolver o resultado final.
    var vistosNestaAisp = new Set();
    var resultadosSemDuplicata = resultados.filter(function (l) {
        if (vistosNestaAisp.has(l.escalaId)) return false;
        vistosNestaAisp.add(l.escalaId);
        return true;
    });
    if (resultadosSemDuplicata.length !== resultados.length) {
        console.log("   ⚠️ Removidas " + (resultados.length - resultadosSemDuplicata.length) + " escala(s) duplicada(s) (provável página repetida) da AISP " + aisp + ".");
    }

    return { linhas: resultadosSemDuplicata, totalEsperado: totalEsperado };
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
        var MAX_TENTATIVAS_AISP = 3; // se a paginação ficar devendo escalas (comparado ao Total de
        // Registros da própria grade), refaz a busca dessa AISP do zero em vez de aceitar parcial
        for (const aisp of AISPS_MONITORADAS) {
            var ehPrimeiraAispDoRun = (aisp === AISPS_MONITORADAS[0]);
            var resultadoBusca;
            for (var tentativaAisp = 1; tentativaAisp <= MAX_TENTATIVAS_AISP; tentativaAisp++) {
                resultadoBusca = await pesquisarEscalas(page1, aisp);
                var completo = resultadoBusca.totalEsperado === null || resultadoBusca.linhas.length >= resultadoBusca.totalEsperado;
                // Segurança extra só pra 1ª AISP do run: é a única que roda logo depois
                // do login (às vezes mais lento/instável), janela em que já vimos um bug
                // real de preenchimento de campo falhar silenciosamente e voltar "0 registros"
                // mesmo tendo escalas de verdade. Não aceita um "0" de primeira aqui — confirma
                // com pelo menos mais uma tentativa antes de aceitar como resultado real.
                if (completo && ehPrimeiraAispDoRun && resultadoBusca.totalEsperado === 0 && tentativaAisp === 1) {
                    console.log("   ℹ️ 1ª AISP do run veio com 0 registros — confirmando com mais uma tentativa antes de aceitar (pode ser efeito do login ainda assentando)...");
                    continue;
                }
                if (completo) break;
                if (tentativaAisp < MAX_TENTATIVAS_AISP) {
                    console.log("⚠️ Só capturei " + resultadoBusca.linhas.length + "/" + resultadoBusca.totalEsperado +
                        " escalas da AISP " + aisp + " — refazendo a busca dessa AISP do zero (tentativa " + (tentativaAisp + 1) + "/" + MAX_TENTATIVAS_AISP + ")...");
                } else {
                    console.log("⚠️ Mesmo depois de " + MAX_TENTATIVAS_AISP + " tentativas, só consegui " + resultadoBusca.linhas.length + "/" + resultadoBusca.totalEsperado +
                        " escalas da AISP " + aisp + " — seguindo com o que tem pra não travar o resto da checagem.");
                }
            }
            var linhas = resultadoBusca.linhas;
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
