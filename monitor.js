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
// workflow salva screenshots (erro*.png, uma por falha) como artefato pra
// gente debugar junto olhando exatamente onde travou.
//
// ⚠️ CORREÇÃO 02/08/2026 (a descoberta que resolveu de vez o bug antigo):
// durante muito tempo, voltar pra tela de escalas pra checar a 2ª AISP em
// diante falhava 100% das vezes, e a suspeita era que "a sessão do login
// travava" — por isso a versão anterior refazia login do zero pra CADA área
// (funcionava, mas custava ~15-20s a mais por AISP). Analisando o robô
// Tampermonkey do próprio usuário (que troca de AISP há muito tempo SEM
// relogar), descobrimos a causa real: o culpado era o MENU EM CASCATA (que
// fica com estado interno "grudado" depois do primeiro uso), não a sessão.
// A solução é a mesma que o Tampermonkey usa: navegar DIRETO pra URL da tela
// (URL_TELA_ESCALAS), pulando o menu. Agora o login é feito UMA VEZ SÓ por
// run, e cada AISP só renavega pela URL — bem mais rápido e igualmente
// confiável. Ver abrirTelaPesquisaDelegada() e main() pra detalhes.
// ─────────────────────────────────────────────────────────────────────────

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

// ─────────────────────────────────────────────────────────────────────────
// ⚠️ ADICIONADO 01/09/2026, CORRIGIDO 02/09/2026 (a pedido do usuário): envio
// das notificações DIRETO daqui, assim que cada área termina.
//
// ⚠️ CORREÇÃO 02/09/2026 (bug real, investigado a fundo com 5 testes
// diferentes): o fetch() do Node (e também o módulo https nativo — testamos
// os dois) SEMPRE falhava com ETIMEDOUT tentando alcançar o Telegram com a
// VPN ligada, mesmo o Node conseguindo alcançar OUTROS sites sem problema
// (testamos com o GitHub, funcionou liso). Já o comando "curl" sempre
// funcionou perfeitamente no mesmo ambiente, nos mesmos testes.
//
// Não descobrimos o motivo exato dessa diferença (testamos IPv4 forçado, o
// módulo https em vez do fetch — nenhum dos dois resolveu) — mas como o
// curl comprovadamente funciona, a função de envio agora chama ele como um
// processo externo, em vez de usar a rede do próprio Node diretamente.
// ─────────────────────────────────────────────────────────────────────────
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID; // canal do M1 (padrão)
const CANAL_POR_MODULO = {
    M5: process.env.TELEGRAM_CHAT_ID_M5,
    M3: process.env.TELEGRAM_CHAT_ID_M3
};
function canalParaModulo(modulo) {
    if (!modulo || modulo === "M1") return TELEGRAM_CHAT_ID;
    return CANAL_POR_MODULO[modulo];
}
const PAUSA_ENTRE_ENVIOS_MS = 3300;
function dormir(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// Chama o curl como um processo externo — usa execFile (não exec) com os
// argumentos em array, pra NUNCA passar o texto da mensagem por dentro de
// uma string de shell (evita por completo risco de injeção de comando,
// mesmo que o texto da escala viesse com caracteres estranhos).
function curlPost(url, jsonBody, timeoutMs) {
    return new Promise(function (resolve) {
        execFile("curl", [
            "-s", "-m", String(Math.ceil(timeoutMs / 1000)),
            "-w", "\n%{http_code}",
            "-X", "POST", url,
            "-H", "Content-Type: application/json",
            "-d", jsonBody
        ], { timeout: timeoutMs + 2000 }, function (erro, stdout) {
            if (erro) { resolve({ erro: erro.message }); return; }
            var partes = stdout.split("\n");
            var codigoHttp = parseInt(partes.pop(), 10);
            var corpo = partes.join("\n");
            resolve({ codigoHttp: codigoHttp, corpo: corpo });
        });
    });
}

async function enviarTelegram(texto, chatIdDestino) {
    var destino = chatIdDestino || TELEGRAM_CHAT_ID;
    if (!TELEGRAM_BOT_TOKEN || !destino) {
        console.warn("⚠️ TELEGRAM_BOT_TOKEN / chat_id de destino não configurados — pulando envio em tempo real.");
        return false;
    }
    var url = "https://api.telegram.org/bot" + TELEGRAM_BOT_TOKEN + "/sendMessage";
    var corpoJson = JSON.stringify({ chat_id: destino, text: texto, parse_mode: "HTML" });
    var MAX_TENTATIVAS = 5;
    for (var tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
        var resultado = await curlPost(url, corpoJson, 10000);
        if (resultado.erro) {
            console.warn("⚠️ Erro de rede (curl) tentando enviar Telegram em tempo real (tentativa " + tentativa + "/" + MAX_TENTATIVAS + "): " + resultado.erro);
            await dormir(2000);
            continue;
        }
        var data = {};
        try { data = JSON.parse(resultado.corpo); } catch (e) { /* corpo vazio ou inválido — trata abaixo */ }
        if (data.ok) return true;
        if (resultado.codigoHttp === 429 && data.parameters && data.parameters.retry_after) {
            var esperaMs = (data.parameters.retry_after + 1) * 1000;
            console.warn("⏳ Telegram pediu pra esperar " + data.parameters.retry_after + "s (tentativa " + tentativa + "/" + MAX_TENTATIVAS + ")...");
            await dormir(esperaMs);
            continue;
        }
        console.error("❌ Falha ao enviar Telegram em tempo real (via curl):", JSON.stringify(data || resultado));
        return false;
    }
    console.error("❌ Desisti de enviar essa mensagem em tempo real depois de " + MAX_TENTATIVAS + " tentativas.");
    return false;
}

function abreviarAno(data) {
    return String(data).replace(/\/\d{2}(\d{2})$/, "/$1");
}

function formatarLinhaEscala(n) {
    return "📅 " + abreviarAno(n.data) + " 🆔 " + n.escalaId + " 🕐 " + n.horaIni + " x " + n.horaFim + "\n" +
        "👥 Vagas: <b>" + (n.efetivoTotal || "?") + "</b>  |  Inscritos: " + (n.inscritos || "?") + "\n" +
        "⏳ Limite Inscrição: " + (n.dataLimite || "?");
}

var LIMITE_SEGURO_CARACTERES = 3800;
function montarMensagensDoGrupo(grupo) {
    var mensagens = [];
    var rodape = "\n\nMonitoramento em tempo real. Garanta sua inscrição utilizando o nosso robô: " +
        "<a href=\"http://intranet.policiamilitar.sp.gov.br/\">saiba mais</a>.";
    var partesTotal = 1;
    (function calcularPartes() {
        var tamanhoAtual = 0;
        var partes = 1;
        grupo.itens.forEach(function (n) {
            var linha = formatarLinhaEscala(n) + "\n\n";
            if (tamanhoAtual + linha.length > LIMITE_SEGURO_CARACTERES) { partes++; tamanhoAtual = 0; }
            tamanhoAtual += linha.length;
        });
        partesTotal = partes;
    })();

    var parteAtual = 1;
    var linhasAtuais = [];
    var itensNaParte = 0;
    function fecharParte() {
        var cabecalho = "<b>" + itensNaParte + " escala(s) nova(s)</b>\n" +
            "<b>" + grupo.nome + " (AISP " + grupo.aisp + ")" +
            (partesTotal > 1 ? " (parte " + parteAtual + " | " + partesTotal + ")" : "") +
            "</b>\n\n";
        mensagens.push(cabecalho + linhasAtuais.join("\n\n") + rodape);
        parteAtual++;
        linhasAtuais = [];
        itensNaParte = 0;
    }

    var tamanhoAcumulado = 0;
    grupo.itens.forEach(function (n) {
        var linha = formatarLinhaEscala(n);
        if (tamanhoAcumulado + linha.length + 2 > LIMITE_SEGURO_CARACTERES && linhasAtuais.length > 0) {
            fecharParte();
            tamanhoAcumulado = 0;
        }
        linhasAtuais.push(linha);
        itensNaParte++;
        tamanhoAcumulado += linha.length + 2;
    });
    if (linhasAtuais.length > 0) fecharParte();

    return mensagens;
}

// Envia AGORA as escalas novas de UMA área específica (assim que ela termina
// de ser lida), em vez de esperar o resto da checagem. Retorna true se
// mandou tudo com sucesso (ou não tinha nada pra mandar).
var primeiraMensagemEnviada = false;
async function enviarEscalasDaAreaAgora(aisp, nome, modulo, itensDaArea) {
    if (!itensDaArea || itensDaArea.length === 0) return true;
    var destino = canalParaModulo(modulo);
    if (modulo !== "M1" && !destino) {
        console.warn("⚠️ " + itensDaArea.length + " escala(s) nova(s) da AISP " + aisp + " (" + nome + ", módulo " + modulo + ") " +
            "encontradas, mas o canal desse módulo ainda não está configurado — não dá pra mandar em tempo real. " +
            "Vão ficar pro notificar.js tentar no final (via o canal certo, quando configurado).");
        return false;
    }
    var grupo = { nome: nome, aisp: aisp, modulo: modulo, itens: itensDaArea };
    var mensagens = montarMensagensDoGrupo(grupo);
    var tudoOk = true;
    for (const msg of mensagens) {
        if (primeiraMensagemEnviada) await dormir(PAUSA_ENTRE_ENVIOS_MS);
        primeiraMensagemEnviada = true;
        var ok = await enviarTelegram(msg, destino);
        if (!ok) tudoOk = false;
    }
    if (tudoOk) {
        console.log("   📨 " + itensDaArea.length + " escala(s) nova(s) da AISP " + aisp + " (" + nome + ") já avisada(s) em tempo real.");
    }
    return tudoOk;
}

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
    { nome: "25 de Março", aisp: "85760", modulo: "M1" },
    { nome: "Florêncio de Abreu", aisp: "85759", modulo: "M1" },
    { nome: "José Paulino", aisp: "85758", modulo: "M1" },
    { nome: "Triângulo Histórico", aisp: "85757", modulo: "M1" },
    { nome: "Paulista", aisp: "85756", modulo: "M1" },
    { nome: "Centro Novo", aisp: "85755", modulo: "M1" },
    { nome: "Liberdade", aisp: "85754", modulo: "M1" },
    { nome: "Roosevelt", aisp: "85753", modulo: "M1" },
    { nome: "Sé", aisp: "85752", modulo: "M1" },
    { nome: "Marechal Deodoro", aisp: "85751", modulo: "M1" },
    { nome: "Santa Casa", aisp: "85750", modulo: "M1" },
    { nome: "Cambuci", aisp: "85749", modulo: "M1" },
    { nome: "Santa Ifigênia", aisp: "85748", modulo: "M1" },
    { nome: "Volante Cenas Abertas de Uso", aisp: "85745", modulo: "M1" },
    { nome: "Oriente", aisp: "85744", modulo: "M1" },
    { nome: "Concórdia", aisp: "85743", modulo: "M1" },
    { nome: "Brás", aisp: "85742", modulo: "M1" },
    { nome: "Feira da Madrugada", aisp: "85741", modulo: "M1" },
    // ⚠️ ADICIONADO 26/08/2026 (a pedido do usuário): 6 novas áreas do M5.
    // Rodam na MESMA sessão/login que o M1 (economiza tempo, evita logar
    // duas vezes) — só a notificação é que vai pra um canal do Telegram
    // separado, via o campo "modulo" abaixo (ver notificar.js).
    { nome: "Carlos Caldeira Filho", aisp: "85697", modulo: "M5" },
    { nome: "12 de Outubro", aisp: "85859", modulo: "M5" },
    { nome: "Cardeal/Batata/Teodoro Sampaio", aisp: "85860", modulo: "M5" },
    { nome: "Barra Funda", aisp: "85861", modulo: "M5" },
    { nome: "Oscar Freire / Clínicas", aisp: "85862", modulo: "M5" },
    { nome: "Butantã", aisp: "85864", modulo: "M5" },
    // ⚠️ ADICIONADO 27/08/2026 (a pedido do usuário): 9 novas áreas do M3.
    // Mesmo esquema do M5 — roda na mesma sessão/login, notificação vai
    // pra um canal separado (ver notificar.js).
    { nome: "Guapira", aisp: "85717", modulo: "M3" },
    { nome: "Parapuã", aisp: "85718", modulo: "M3" },
    { nome: "Voluntários da Pátria", aisp: "85719", modulo: "M3" },
    { nome: "Tietê / Santana", aisp: "85720", modulo: "M3" },
    { nome: "Tucuruvi", aisp: "85768", modulo: "M3" },
    { nome: "Itaberaba", aisp: "85772", modulo: "M3" },
    { nome: "São Gonçalo", aisp: "85773", modulo: "M3" },
    { nome: "Sezefredo Fagundes", aisp: "85775", modulo: "M3" },
    { nome: "Luiz Stamatis", aisp: "85776", modulo: "M3" }
];
function _nomeDaAisp(aisp) {
    var a = TODAS_AREAS_DELEGADA.find(function (x) { return x.aisp === aisp; });
    return a ? a.nome : aisp;
}
function _moduloDaAisp(aisp) {
    var a = TODAS_AREAS_DELEGADA.find(function (x) { return x.aisp === aisp; });
    return a ? a.modulo : "M1"; // default seguro: se por algum motivo não achar, trata como M1
}
const AISPS_MONITORADAS = process.env.PMESP_AISP
    ? process.env.PMESP_AISP.split(",").map(s => s.trim()).filter(Boolean)
    : TODAS_AREAS_DELEGADA.map(a => a.aisp);

const LOGIN_URL = process.env.LOGIN_URL || "http://intranet.policiamilitar.sp.gov.br/";

// ⚠️ DESCOBERTA 02/08/2026 (a partir do robô Tampermonkey do próprio usuário,
// que usa isso há muito tempo com sucesso): dá pra chegar na tela de escalas
// SEM passar pelo menu em cascata (SIRH → Escala → Inscrever PM), navegando
// direto pra essa URL. O parâmetro codificado carrega os códigos internos de
// Sistema/SubSistema/Rotina que o chama_rotina.aspx usa pra saber qual tela
// abrir. Isso resolve de vez o bug antigo: o problema NUNCA foi a sessão do
// login expirando — era o MENU que travava depois do primeiro uso. Como essa
// URL pula o menu inteiro, dá pra reaproveitar a mesma sessão entre AISPs.
//
// A URL completa foi confirmada pelo usuário direto no navegador (a 1ª
// tentativa usava um domínio suposto errado, e todas as áreas falhavam):
// é o MESMO domínio do login (ms.policiamilitar.sp.gov.br), na raiz.
const URL_TELA_ESCALAS = process.env.URL_TELA_ESCALAS ||
    "http://ms.policiamilitar.sp.gov.br/chama_rotina.aspx?l+til9EMFvFgCT+SnDWWNQ==";

const SEEN_PATH = path.join(__dirname, "seen.json");
const JANELA_DIAS = 45; // quantos dias a partir de hoje ele pesquisa (data início/fim do filtro)

function hoje() {
    return new Date();
}
function formatarDataBR(d) {
    return String(d.getDate()).padStart(2, "0") + "/" + String(d.getMonth() + 1).padStart(2, "0") + "/" + d.getFullYear();
}
// ⚠️ CORREÇÃO 10/08/2026 (bug real, investigado no histórico do seen.json):
// a "identidade" de uma escala incluía o HORÁRIO. Quando a PMESP mudava o
// horário de uma escala já existente, a identidade mudava junto e o robô a
// anunciava como se fosse NOVA. Foi exatamente o que aconteceu com as 7
// escalas de Florêncio de Abreu: elas existiam desde 04/08, a PMESP deslocou
// o horário em 1 hora (18:00-02:00 -> 19:00-03:00), e todas voltaram como
// "novas" — já com 92 a 187 inscritos acumulados ao longo de 6 dias, o que
// deixou o aviso sem sentido.
//
// Agora a identidade é AISP + data + ID da escala. O ID é o que a PMESP usa
// pra identificar a escala de verdade; o horário é um detalhe que pode ser
// ajustado. A data continua na chave porque a limpeza automática (ver
// salvarVistos) usa ela pra descartar escalas que já passaram.
function _identidadeDaEscala(aisp, data, escalaId) {
    return aisp + "_" + data + "_" + escalaId;
}

// Converte chaves no formato ANTIGO (com horário) pro formato novo, pra não
// disparar uma enxurrada de falsos "novos" na primeira execução após a
// mudança. Antigo: aisp_data_horaIniXhoraFim_id  ->  novo: aisp_data_id
function _converterChaveAntiga(chave) {
    var p = String(chave).split("_");
    if (p.length === 4) return p[0] + "_" + p[1] + "_" + p[3];
    return chave;
}

function carregarVistos() {
    try {
        var lista = JSON.parse(fs.readFileSync(SEEN_PATH, "utf8"));
        return new Set(lista.map(_converterChaveAntiga));
    } catch (e) { return new Set(); }
}
function salvarVistos(set) {
    var lista = Array.from(set);

    // CORREÇÃO 01/08/2026 (a pedido do usuário, preocupado com o arquivo
    // crescer pra sempre): antes, a única proteção era manter só os "últimos
    // 2000 registros inseridos" — um corte arbitrário que podia descartar
    // escalas FUTURAS ainda válidas (só porque foram inseridas mais cedo que
    // outras) e gerar um aviso de "nova" duplicado quando elas reaparecessem.
    // Agora, antes de qualquer coisa, remove as entradas cuja DATA já passou —
    // essas nunca mais vão aparecer numa busca de novo (a pesquisa é sempre
    // "de hoje pra frente"), então guardá-las não serve pra nada, só ocupa
    // espaço à toa. Isso mantém o arquivo naturalmente do tamanho da janela de
    // busca (hoje JANELA_DIAS=45 dias, ~500-600 registros no total das 18
    // áreas), bem longe do limite de 2000.
    var hojeSemHora = new Date();
    hojeSemHora.setHours(0, 0, 0, 0);
    lista = lista.filter(function (chave) {
        var partes = chave.split("_");
        var dataStr = partes[1]; // formato dd/mm/aaaa (veja onde "chave" é montada)
        if (!dataStr) return true; // formato inesperado — mantém por segurança
        var pedacos = dataStr.split("/");
        if (pedacos.length !== 3) return true;
        var dataEscala = new Date(Number(pedacos[2]), Number(pedacos[1]) - 1, Number(pedacos[0]));
        if (isNaN(dataEscala.getTime())) return true;
        return dataEscala >= hojeSemHora;
    });

    // Segurança extra (não deveria disparar na prática, já que a limpeza por
    // data acima mantém o arquivo pequeno sozinha): se mesmo assim passar de
    // 2000, corta os inseridos há mais tempo.
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

        // A popup (page1) já é totalmente independente da página do portal a
        // partir daqui — fecha a página do portal pra não acumular abas à toa
        // (essa função agora roda uma vez POR AISP, não uma vez só por run).
        await page.close().catch(() => {});

        return page1;
    } catch (err) {
        if (typeof onErro === "function") await onErro(page1 || page, "login");
        throw err;
    }
}

// ── Abre a tela de pesquisa "Inscrever PM na Escala Ativ Delegada".
//
// ⚠️ CORREÇÃO 02/08/2026 (a partir do robô Tampermonkey do próprio usuário):
// agora navega DIRETO pra URL da tela (URL_TELA_ESCALAS), em vez de percorrer
// o menu em cascata (SIRH → Escala → Inscrever PM).
//
// HISTÓRICO DO BUG (pra não repetir o erro): a versão anterior usava o menu, e
// isso funcionava perfeitamente na 1ª AISP mas falhava 100% das vezes da 2ª em
// diante — o campo #vIDFAGPGEOSST simplesmente nunca mais reaparecia. Por muito
// tempo a suspeita foi "a sessão do login trava" (por isso a solução anterior
// era refazer login do zero pra CADA AISP, o que funcionava mas custava
// ~15-20s a mais por área). Analisando o robô Tampermonkey do usuário, que faz
// isso há muito tempo SEM relogar, descobrimos a verdade: o problema nunca foi
// a sessão — era o MENU EM CASCATA que fica com estado interno "grudado"
// depois do primeiro uso (comportamento comum em menus legados baseados em
// onmouseover). Navegando direto pela URL, o menu nem entra na história, e a
// mesma sessão pode ser reaproveitada à vontade entre AISPs.
async function abrirTelaPesquisaDelegada(page1) {
    await page1.goto(URL_TELA_ESCALAS, { waitUntil: "domcontentloaded", timeout: 30000 });

    // ⚠️ CORREÇÃO 06/08/2026 (a partir de um print real da tela de erro): quando
    // o sistema da PMESP está sobrecarregado, ele NÃO fica mudo — ele responde
    // rapidinho com uma página de erro do ASP.NET ("Server Error in '/ESCALA'
    // Application" / "Unable to connect to SQL Server session database" /
    // "Timeout expired... max pool size was reached"). Isso quer dizer que o
    // banco onde ele guarda as SESSÕES esgotou as conexões — ou seja, o site
    // inteiro está fora, não só essa tela.
    //
    // Antes o robô não reconhecia essa página: seguia em frente e ficava 20s
    // esperando um campo que nunca ia aparecer, multiplicado por 2 aberturas x
    // 3 tentativas x 18 áreas. Agora ele identifica a tela de erro e desiste na
    // hora (menos de 1s), o que também aciona o "disjuntor" bem mais rápido e
    // para de pressionar um servidor que já avisou que está sobrecarregado.
    var textoDaPagina = await page1.evaluate(() => document.body ? document.body.innerText.slice(0, 2000) : "").catch(() => "");
    if (/Server Error|Unable to connect to SQL Server|max pool size was reached|Timeout expired/i.test(textoDaPagina)) {
        throw new Error("O sistema da PMESP respondeu com página de erro (sobrecarga no banco de sessão dele) — não adianta insistir agora.");
    }

    // O robô Tampermonkey usa 1500ms de propósito depois de chegar nessa tela
    // (DELAY_TRAVA_VE_CLIQUE_MS) — o comentário original dele já avisa que esse
    // carregamento demora mais que os outros, então mantém esse valor testado.
    await page1.waitForTimeout(1500);
    await page1.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});

    // Tela de "declaração de apto" — só costuma aparecer às vezes / na primeira
    // vez da sessão. Tenta com timeout curto; se não achar, segue sem erro
    // (custa no máximo 3s à toa quando não aparece, o que é aceitável).
    try {
        var embFrameApto = page1.frameLocator('iframe[name="Embpage"]');
        await embFrameApto.locator("#vAPTO").check({ timeout: 3000 });
        await embFrameApto.getByRole("button", { name: "Confirma" }).click({ timeout: 3000 });
        await page1.waitForTimeout(700);
        await page1.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
    } catch (e) {
        // ok, não apareceu dessa vez — segue o fluxo
    }

    return page1;
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
// ⚠️ CORREÇÃO 07/08/2026 (bug real, grave, visto em log): o Playwright NÃO
// tem limite de tempo em frame.evaluate(). Se o iframe travar, for descartado
// ou a página ficar sem responder no meio de uma leitura, a chamada fica
// pendurada PARA SEMPRE — e nada resgata. Num run real isso congelou o robô
// por 30 MINUTOS sem imprimir uma única linha de log, até o job estourar.
// (O "orçamento de tempo" de main() não salva nesse caso, porque ele só é
// checado ENTRE as áreas, não no meio da paginação de uma delas.)
//
// Esta função embrulha qualquer operação com um prazo máximo: o que vier
// primeiro, o resultado ou o prazo. Assim uma leitura travada vira um erro
// normal, que o código já sabe tratar, em vez de um congelamento eterno.
function comLimiteDeTempo(promessa, ms, descricao) {
    var timer;
    var prazo = new Promise(function (_, rejeitar) {
        timer = setTimeout(function () {
            rejeitar(new Error("Tempo esgotado (" + ms + "ms) em: " + descricao));
        }, ms);
    });
    return Promise.race([promessa, prazo]).finally(function () { clearTimeout(timer); });
}

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
async function pesquisarEscalas(page1, aisp, onErro, precisaTelaCompleta) {
    console.log("🔎 Pesquisando " + _nomeDaAisp(aisp) + " (AISP " + aisp + ")...");

    var dataIni = formatarDataBR(hoje());
    var dataFim = formatarDataBR(new Date(hoje().getTime() + JANELA_DIAS * 24 * 60 * 60 * 1000));

    var embFrame = null;
    var embFrameHandle = null;
    var ultimoErroAbertura = null;
    var MAX_TENTATIVAS_ABERTURA = 2;

    // ⚠️ REVERTIDO 28/08/2026 (a pedido do usuário, confirmado por log real):
    // a otimização de "caminho rápido" (pular o reload de página entre
    // áreas) foi testada e FALHOU de forma consistente — a busca nunca
    // atualizava de verdade sem o reload completo, mesmo esperando o tempo
    // certo. Isso é bem parecido com o bug antigo do menu em cascata (que só
    // funcionava uma vez por página) — o botão "Procurar" parece ter a mesma
    // limitação. Voltado a recarregar a página em TODA área, do jeito
    // comprovado. O parâmetro "precisaTelaCompleta" continua existindo na
    // assinatura (não usado aqui dentro) só pra não precisar mexer no
    // main(), que ainda passa esse argumento — é inofensivo mantê-lo.
    for (var tentativaAbertura = 1; tentativaAbertura <= MAX_TENTATIVAS_ABERTURA; tentativaAbertura++) {
        try {
                await abrirTelaPesquisaDelegada(page1);
                embFrame = page1.frameLocator('iframe[name="Embpage"]');
                // IMPORTANTE (bug real corrigido): pegar a referência bruta do frame (via
                // page1.frame({name:...})) ANTES do iframe terminar de assentar é
                // arriscado — se o postback ainda estiver trocando o conteúdo do iframe
                // nesse instante, essa referência pode ficar presa numa versão velha/
                // prestes a ser destruída, e toda leitura feita nela depois fica "morta"
                // pra sempre (grade sempre vazia, sem nenhum erro visível). Por isso a
                // ordem é: primeiro espera o campo aparecer usando o FRAME LOCATOR (que
                // sempre resolve pro iframe ATUAL) — só DEPOIS disso confirmado é que
                // pegamos a referência bruta do frame pra usar com .evaluate().
                await embFrame.locator("#vIDFAGPGEOSST").waitFor({ state: "visible", timeout: 20000 });
                embFrameHandle = page1.frame({ name: "Embpage" });
                if (!embFrameHandle) throw new Error("Não achei o iframe Embpage — a estrutura da página pode ter mudado.");
                ultimoErroAbertura = null;
                break;
            } catch (e) {
                ultimoErroAbertura = e;
                console.log("   ⚠️ Não consegui abrir a tela de pesquisa pra AISP " + aisp + " (tentativa " + tentativaAbertura + "/" + MAX_TENTATIVAS_ABERTURA + "): " + e.message);
                if (typeof onErro === "function") await onErro(page1, "aisp_" + aisp + "_t" + tentativaAbertura);
                // ⚠️ CORREÇÃO 06/08/2026 (bug real, visto em log): antes não havia
                // NENHUMA pausa entre as tentativas. Quando o erro é instantâneo
                // (ex: ERR_CONNECTION_REFUSED, quando o servidor recusa a conexão em
                // vez de demorar), o robô disparava 6 tentativas em menos de 1
                // segundo — martelando um servidor que já estava com problema.
                // Agora espera antes de tentar de novo, dando tempo pro site se
                // recuperar de uma instabilidade passageira.
                if (tentativaAbertura < MAX_TENTATIVAS_ABERTURA) {
                    await page1.waitForTimeout(3000);
                }
            }
        }
    if (!embFrameHandle) {
        throw ultimoErroAbertura || new Error("Não consegui abrir a tela de pesquisa pra AISP " + aisp + " depois de " + MAX_TENTATIVAS_ABERTURA + " tentativas.");
    }

  {
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
    var fingerprintAntes = JSON.stringify(await comLimiteDeTempo(
        embFrameHandle.evaluate(_lerLinhasGrade), 10000, "leitura da grade (fingerprint inicial)"
    ).catch(() => null));

    await embFrame.locator("#vIDFAGPGEOSST").fill(aisp).catch(() => {});
    await comLimiteDeTempo(preencherCampoGX(embFrameHandle, "vIDFAGPGEOSST", aisp), 10000, "preencher AISP").catch(() => {});
    await comLimiteDeTempo(preencherCampoGX(embFrameHandle, "vDATINI", dataIni), 10000, "preencher data início").catch(() => {});
    await comLimiteDeTempo(preencherCampoGX(embFrameHandle, "vDATFIM", dataFim), 10000, "preencher data fim").catch(() => {});

    // Mesma pausa curta que o robô Tampermonkey dá antes de clicar em Pesquisar
    // (DELAY_PRE_PESQUISA_MS) — dá tempo do GeneXus assimilar os campos preenchidos
    // via injeção antes do clique, evitando pesquisar com o formulário "pela metade".
    await page1.waitForTimeout(150);
    var clicouProcurar = await comLimiteDeTempo(clicarProcurarGX(embFrameHandle), 10000, "clique em Procurar").catch(() => false);
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
        var linhasTeste;
        try {
            linhasTeste = await comLimiteDeTempo(
                embFrameHandle.evaluate(_lerLinhasGrade), 10000, "leitura da grade (estabilização)"
            );
        } catch (e) {
            continue; // travou/demorou — trata como "ainda não mudou" e tenta de novo no próximo ciclo
        }
        var fpTeste = JSON.stringify(linhasTeste);
        // ⚠️ CORREÇÃO 28/08/2026 (bug real, causado pela própria otimização do
        // "caminho rápido" — log real analisado): essa checagem originalmente só
        // comparava com "fingerprintAntes" pra ignorar o instante 'limpo' da
        // troca de área. Isso funcionava perfeitamente quando cada área
        // recarregava a página do zero, porque nesse caso o "fingerprintAntes"
        // já COMEÇAVA vazio — e o instante limpo da troca batia com ele.
        //
        // Só que com o caminho rápido (sem reload), "fingerprintAntes" passou a
        // ser a grade CHEIA da ÁREA ANTERIOR (não mais vazia!). O instante
        // limpo da troca de área não batia mais com esse fingerprint cheio, e
        // por isso deixava de ser filtrado — sendo aceito de vez como se fosse
        // o resultado final (0 escalas), mesmo quando a área tinha dado de
        // verdade. Consequência real: 3 áreas seguidas vieram "vazias" por
        // engano, disparando o disjuntor à toa.
        //
        // Correção: além de comparar com "fingerprintAntes", trata QUALQUER
        // leitura vazia como transitória por padrão — nunca aceita "0 escalas"
        // como resultado estável dentro desse loop de espera. Uma área
        // genuinamente vazia (0 escalas de verdade) ainda é capturada
        // corretamente depois, pelo caminho de "último recurso" já existente
        // logo abaixo, só que sem risco de confundir transição com resultado.
        if (fpTeste === fingerprintAntes || linhasTeste.length === 0) {
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
            linhasAtuais = await comLimiteDeTempo(
                embFrameHandle.evaluate(_lerLinhasGrade), 10000, "leitura da grade (último recurso)"
            ).catch(() => []);
            fingerprintAtual = JSON.stringify(linhasAtuais);
        }
    }

    var totalEsperado = await comLimiteDeTempo(
        embFrameHandle.evaluate(_lerTotalRegistros), 10000, "leitura do total (início)"
    ).catch(() => null);
    if (totalEsperado !== null) {
        console.log("   (a grade indica " + totalEsperado + " registro(s) no total pra essa AISP)");
    }

    var resultados = [];
    var paginasLidas = 0;
    var MAX_PAGINAS = 30; // teto de segurança — uma AISP real não deveria chegar nem perto disso

    // ⚠️ CORREÇÃO 05/08/2026 (bug real, diagnosticado em log de execução): o
    // robô decidia "a página virou" comparando se a leitura ficou DIFERENTE da
    // anterior (fingerprint). O problema é que havia um caminho que aceitava
    // uma leitura diferente SEM confirmar que ela era estável — e aí engolia
    // qualquer coisa: a mesma página re-renderizada (virava página duplicada) ou
    // a grade momentaneamente vazia (virava "página com 0 escalas"). No log:
    // "25 de Março" e "Liberdade" pegaram a página 1 duas vezes (10 duplicatas
    // removidas em cada, terminando 40/42 e 20/22), e "Sé" aceitou uma página
    // vazia e parou em 20/33.
    //
    // Agora a decisão é por um sinal direto e sem ambiguidade: só é página nova
    // se trouxer pelo menos UMA escala com ID que ainda não foi visto nesta
    // AISP. Página repetida (só IDs conhecidos) e grade vazia (nenhum ID) são
    // simplesmente ignoradas — o robô continua esperando a página de verdade.
    var idsVistosNestaAisp = new Set();

    while (paginasLidas < MAX_PAGINAS) {
        paginasLidas++;
        resultados = resultados.concat(linhasAtuais);
        linhasAtuais.forEach(function (l) { idsVistosNestaAisp.add(l.escalaId); });
        console.log("   página " + paginasLidas + ": " + linhasAtuais.length + " escala(s)" +
            (linhasAtuais.length > 0 ? " — ex: escala " + linhasAtuais[0].escalaId + " em " + linhasAtuais[0].data : "") +
            (totalEsperado !== null ? " (capturado até agora: " + resultados.length + "/" + totalEsperado + ")" : ""));

        // Se já capturamos tudo que a própria grade disse que existe, não precisa
        // nem tentar clicar em "Próxima" de novo.
        if (totalEsperado !== null && resultados.length >= totalEsperado) break;

        var temProxima = await comLimiteDeTempo(embFrameHandle.evaluate(() => {
            var btn = document.getElementById("NEXT");
            return !!(btn && btn.style.display !== "none" && btn.style.visibility !== "hidden" && !btn.disabled);
        }), 10000, "checagem do botão Próxima").catch(() => false);
        if (!temProxima) break;

        // Procura por uma leitura que traga pelo menos um ID inédito. Se em ~9s
        // nada novo aparecer, tenta clicar de novo (até 3 vezes no total).
        //
        // ⚠️ Toda leitura vai com limite de tempo (comLimiteDeTempo): sem isso,
        // um evaluate() travado congelava o robô pra sempre (ver comentário na
        // definição da função). Se a leitura estourar o prazo, ela é tratada
        // como "ainda não chegou" e o ciclo continua normalmente.
        async function _lerPaginaNovaSeChegou() {
            var linhas;
            try {
                linhas = await comLimiteDeTempo(
                    embFrameHandle.evaluate(_lerLinhasGrade), 10000, "leitura da grade"
                );
            } catch (e) {
                return null; // travou ou demorou demais — trata como "nada novo ainda"
            }
            if (!linhas || linhas.length === 0) return null; // grade vazia/em transição
            var temIdNovo = linhas.some(function (l) { return !idsVistosNestaAisp.has(l.escalaId); });
            return temIdNovo ? linhas : null; // só IDs conhecidos = página repetida
        }

        // Teto de tempo pra paginação desta AISP inteira. Rede de segurança
        // extra: mesmo que alguma coisa inesperada demore demais aqui, o robô
        // encerra a paginação desta área e segue, em vez de prender o run todo.
        var inicioPaginacaoMs = Date.now();
        var LIMITE_PAGINACAO_MS = 3 * 60 * 1000; // 3 minutos

        var mudou = false;
        for (var tentativaClique = 0; tentativaClique < 3 && !mudou; tentativaClique++) {
            if (Date.now() - inicioPaginacaoMs > LIMITE_PAGINACAO_MS) {
                console.log("   ⏱️ Paginação da AISP " + aisp + " passou de 3 min — encerrando aqui pra não travar o run.");
                break;
            }

            // Antes de RE-clicar, confere se a página não chegou "atrasada" — sem
            // isso, um clique extra em cima de uma virada que já estava a caminho
            // podia PULAR uma página inteira (e a AISP voltava incompleta).
            if (tentativaClique > 0) {
                var leituraAtrasada = await _lerPaginaNovaSeChegou();
                if (leituraAtrasada) { linhasAtuais = leituraAtrasada; mudou = true; break; }
            }

            try {
                await comLimiteDeTempo(clicarProximaPaginaGX(embFrameHandle), 10000, "clique em Próxima");
            } catch (e) {
                console.log("   ⚠️ O clique em 'Próxima' travou (" + e.message + ") — seguindo pra próxima tentativa.");
            }

            for (var tentativa = 0; tentativa < 30; tentativa++) {
                if (Date.now() - inicioPaginacaoMs > LIMITE_PAGINACAO_MS) break;
                await page1.waitForTimeout(300);
                var leitura = await _lerPaginaNovaSeChegou();
                if (leitura) { linhasAtuais = leitura; mudou = true; break; }
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

    // ⚠️ CORREÇÃO 18/08/2026 (a pedido do usuário, bug real confirmado no
    // histórico do seen.json): a PMESP lança lotes de escalas em sequência
    // rápida (por horário — manhã/tarde/noite). Se o robô estava passando
    // pelas páginas EXATAMENTE durante um lançamento desses, algumas escalas
    // do meio do lote podem não existir ainda na grade no instante em que
    // aquela página foi lida — mas o "Total de Registros" inicial também não
    // as contava, então a checagem de "captura incompleta" (que compara com
    // esse total) não detectava nada de errado. Foi exatamente o que
    // aconteceu: 2 escalas de um lote de 20 nunca foram capturadas, mesmo a
    // contagem batendo direitinho no começo.
    //
    // Correção: relê o "Total de Registros" mais uma vez, agora que a
    // paginação inteira já terminou. É uma checagem barata (só reaproveita a
    // mesma função de leitura, sem precisar recarregar página nem esperar
    // animação) — custa no máximo uma fração de segundo. Se o total MUDOU
    // pra mais durante a leitura, é sinal de que passou algo novo por baixo
    // dos nossos pés: melhor tratar como incompleta (o código que chama essa
    // função já sabe refazer a busca do zero quando isso acontece) do que
    // aceitar um lote que ficou pela metade.
    var totalNoFinal = await comLimiteDeTempo(
        embFrameHandle.evaluate(_lerTotalRegistros), 10000, "leitura do total (fim)"
    ).catch(() => null);
    var cresceuDuranteLeitura = false;
    if (totalNoFinal !== null && totalEsperado !== null && totalNoFinal > totalEsperado) {
        console.log("   ⚠️ O total de registros da AISP " + aisp + " MUDOU durante a leitura (era " +
            totalEsperado + ", agora é " + totalNoFinal + ") — provável lançamento de escalas em andamento. " +
            "Tratando como captura incompleta pra ser refeita.");
        totalEsperado = totalNoFinal;
        cresceuDuranteLeitura = true;
    }

    return { linhas: resultadosSemDuplicata, totalEsperado: totalEsperado, cresceuDuranteLeitura: cresceuDuranteLeitura };
  }
}

(async function main() {
    if (!PMESP_USUARIO || !PMESP_SENHA) {
        console.error("❌ Defina PMESP_USUARIO e PMESP_SENHA nos Secrets do repositório.");
        process.exit(1);
    }
    var vistos = carregarVistos();
    var novos = [];
    // Só as que FALHARAM no envio em tempo real ficam aqui — são as únicas
    // que o notificar.js (rede de segurança do final do run) precisa tentar
    // de novo. As que já foram enviadas com sucesso não entram aqui, pra não
    // duplicar mensagem.
    var novosPendentesDeEnvio = [];
    var browser = await chromium.launch({ headless: true });
    // Cada screenshot leva um rótulo único no nome do arquivo (ex: erro_login.png,
    // erro_aisp_85759_t1.png) — antes só existia um "erro.png" fixo, que a 2ª
    // falha do mesmo run já sobrescrevia, perdendo a evidência da 1ª.
    // ⚠️ CORREÇÃO 20/08/2026 (a pedido do usuário): a funcionalidade de
    // screenshot de erro foi REMOVIDA por completo. Ela chegou a ser
    // limitada (prazo de 5s, teto de 3 por execução — ver histórico), mas
    // mesmo assim a etapa de UPLOAD do artefato (no workflow, não no nosso
    // código) travou "Em execução..." por mais de 20 minutos num run real,
    // fazendo o job inteiro ser cancelado depois de 45 minutos. Como não
    // era mais necessária, a função virou um "no-op" — mantida só pra não
    // precisar caçar e remover cada chamada espalhada pelo código; ela
    // simplesmente não faz mais nada quando chamada.
    async function tirarScreenshotErro() {
        // intencionalmente vazia
    }

    // ⚠️ Orçamento de tempo (CORREÇÃO 31/07/2026): o job do GitHub Actions tem um
    // timeout (veja monitorar.yml). Antes, se a checagem de uma AISP travasse
    // repetidamente, o run inteiro corria o risco de ser CANCELADO no meio pelo
    // GitHub — o que pula até os passos "if: always()" (notificar Telegram,
    // salvar seen.json), perdendo TODO o progresso do run sem avisar ninguém.
    // Agora o próprio script para sozinho, de forma limpa, bem antes desse
    // limite, e ainda notifica/salva o que já deu tempo de checar — as áreas
    // que sobrarem são pegas na próxima execução (30 min depois).
    var INICIO_MS = Date.now();
    var ORCAMENTO_MAX_MINUTOS = 22;
    function minutosDecorridos() { return (Date.now() - INICIO_MS) / 60000; }

    var context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });

    // ⚠️ CORREÇÃO 02/08/2026: login feito UMA VEZ SÓ pro run inteiro. Antes era
    // um login por AISP (18 logins!), porque acreditávamos que a sessão travava
    // entre áreas — descobrimos pelo robô Tampermonkey do usuário que o culpado
    // era o menu em cascata, não a sessão (ver abrirTelaPesquisaDelegada). Isso
    // economiza ~15-20s por área (~5 min no run completo de 18 áreas).
    var paginaSessao = null;
    // ⚠️ OTIMIZAÇÃO 28/08/2026: rastreia se a PRÓXIMA busca precisa recarregar
    // a tela inteira (só verdade logo depois de logar/relogar) ou pode
    // reaproveitar a página já aberta (ver pesquisarEscalas). Fica true de
    // novo sempre que um login novo acontece.
    var precisaTelaCompleta = true;
    var resultadoPorArea = []; // { aisp, nome, total } — TODAS as áreas verificadas, mesmo com 0

    // ⚠️ CORREÇÃO 06/08/2026 ("disjuntor", bug real visto em log): quando o site
    // da PMESP cai no meio do run, TODAS as áreas seguintes falham — e cada uma
    // gastava ~3 min tentando (3 tentativas x 2 aberturas x ~29s de timeout).
    // Num run real isso queimou 16 minutos falhando em sequência antes do
    // usuário cancelar na mão. Agora, depois de algumas áreas seguidas falhando,
    // o robô entende que o problema é do site (não daquela área específica),
    // para de vez e deixa o resto pra próxima checagem, 30 min depois.
    var falhasSeguidas = 0;
    var MAX_FALHAS_SEGUIDAS = 3;
    try {
        // ⚠️ AJUSTE 05/08/2026: era 2, subiu pra 3. Motivo (visto em log real,
        // AISP Paulista): quando uma área vem com "0 registros", a reconfirmação
        // CONSOME a tentativa 1 — sobrava só a tentativa 2 pra lidar com uma
        // lentidão passageira do site na hora de reabrir a tela, e se ela
        // falhasse a área era pulada. Com 3, sempre sobra uma de folga. Só custa
        // tempo quando algo realmente falha; no caminho normal nada muda.
        var MAX_TENTATIVAS_AISP = 3; // se a paginação ficar devendo escalas (comparado ao Total de
        // Registros da própria grade), refaz a busca dessa AISP do zero em vez de aceitar parcial

        // ⚠️ DISJUNTOR (06/08/2026, a partir de incidente real): se o sistema da
        // PMESP cai no meio do run, TODAS as áreas seguintes falham — e cada uma
        // gastava até ~2min em timeouts de 20s antes de desistir. Num incidente
        // real (06/08 12:02, o servidor começou a recusar conexão com
        // ERR_CONNECTION_REFUSED — banco deles esgotado, horário de pico), isso
        // queimou ~16 minutos moendo um site morto até o usuário cancelar na mão.
        // Agora, se várias áreas falharem SEGUIDAS, o run para sozinho: não
        // adianta insistir num sistema fora do ar, e ainda evita martelar um
        // servidor que já está sofrendo. A próxima checagem (30 min) tenta de novo.
        var falhasSeguidas = 0;
        var LIMITE_FALHAS_SEGUIDAS = 3;

        // ⚠️ CORREÇÃO 28/08/2026 (a pedido do usuário, log real analisado): o
        // disjuntor acima conta FALHAS DE ÁREA (busca lenta, timeout pontual) —
        // faz sentido esperar 3 delas, porque uma área lenta não significa que
        // as outras vão falhar também. Mas se o LOGIN em si está quebrado (nem
        // consegue abrir a tela de pesquisa), NADA vai funcionar naquele
        // momento — não faz sentido gastar 3 áreas x 3 tentativas cada (9
        // ciclos de login fracassado) só pra descobrir isso. Num log real,
        // isso queimou uns 30 MINUTOS até o disjuntor normal finalmente
        // disparar. Agora, 2 falhas de LOGIN seguidas (não de busca) já
        // param o run na hora — é um sinal bem mais forte e rápido de "hoje
        // não vai dar" do que esperar a métrica de falha por área.
        var falhasDeLoginSeguidas = 0;
        var LIMITE_FALHAS_LOGIN = 2;

        for (var i = 0; i < AISPS_MONITORADAS.length; i++) {
            var aisp = AISPS_MONITORADAS[i];

            if (falhasDeLoginSeguidas >= LIMITE_FALHAS_LOGIN) {
                console.log("🛑 " + falhasDeLoginSeguidas + " tentativas de LOGIN seguidas falharam (não é a busca, é o " +
                    "login em si que não completa) — sinal forte de que o sistema da PMESP está fora do ar agora. " +
                    "Parando o run bem mais cedo do que o disjuntor normal, pra não gastar 20-30min tentando logar " +
                    "à toa. A próxima checagem (30 min) tenta de novo.");
                break;
            }

            if (falhasSeguidas >= LIMITE_FALHAS_SEGUIDAS) {
                console.log("🛑 " + falhasSeguidas + " áreas falharam SEGUIDAS — o sistema da PMESP parece estar fora do ar " +
                    "ou instável demais nesse momento. Parando o run aqui em vez de insistir (e de martelar um servidor " +
                    "que já está sofrendo). As áreas restantes serão checadas na próxima execução (30 min).");
                for (var k = i; k < AISPS_MONITORADAS.length; k++) {
                    resultadoPorArea.push({ aisp: AISPS_MONITORADAS[k], nome: _nomeDaAisp(AISPS_MONITORADAS[k]), total: 0, indisponivel: true });
                }
                break;
            }

            if (minutosDecorridos() > ORCAMENTO_MAX_MINUTOS) {
                console.log("⏰ Orçamento de tempo (" + ORCAMENTO_MAX_MINUTOS + " min) esgotado depois de checar " +
                    i + "/" + AISPS_MONITORADAS.length + " área(s) — parando aqui pra não correr o risco do job " +
                    "inteiro ser cancelado. As áreas restantes serão checadas na próxima execução (30 min).");
                for (var j = i; j < AISPS_MONITORADAS.length; j++) {
                    resultadoPorArea.push({ aisp: AISPS_MONITORADAS[j], nome: _nomeDaAisp(AISPS_MONITORADAS[j]), total: 0, semTempo: true });
                }
                break;
            }

            var resultadoBusca = null;
            var ultimoErroAisp = null;
            // ⚠️ CORREÇÃO 05/08/2026 (bug real, visto em log): guarda o MELHOR
            // resultado válido já obtido nesta AISP. Antes, se uma tentativa
            // POSTERIOR falhasse (ex: a reconfirmação de "0 registros" pegando
            // o site lento), o resultado bom da tentativa anterior era jogado
            // fora e a área inteira virava "🔴 falhou" — mesmo tendo lido os
            // dados direitinho antes. Foi exatamente o que aconteceu com a
            // Paulista: leu 0 registros com sucesso, a reconfirmação deu
            // timeout, e o resultado válido foi perdido à toa.
            var melhorResultado = null;

            // ⚠️ CORREÇÃO 18/08/2026 (a pedido do usuário): separa dois
            // motivos bem diferentes de "captura incompleta". Erro de
            // execução (site travou, navegação falhou) continua com o
            // limite de sempre (MAX_TENTATIVAS_AISP = 3) — insistir demais
            // nisso só pressiona um sistema que já está com problema. Mas
            // quando o motivo é a PMESP lançando um lote de escalas NA HORA
            // (número de registros crescendo entre uma tentativa e outra),
            // desistir cedo só significa perder escala de verdade — nesse
            // caso o robô persegue até o número parar de crescer, sem contar
            // isso contra o limite normal, só com um teto de tempo (5min)
            // pra não travar o resto da checagem se um lote demorar demais.
            var tentativaAisp = 0;
            var tentativaCrescimento = 0;
            var inicioPerseguicaoAisp = Date.now();
            var LIMITE_PERSEGUICAO_CRESCIMENTO_MS = 5 * 60 * 1000; // 5 minutos

            while (tentativaAisp < MAX_TENTATIVAS_AISP) {
                tentativaAisp++;
                // IMPORTANTE (bug real corrigido): pesquisarEscalas pode lançar exceção
                // (ex: timeout esperando o campo de AISP aparecer, por lentidão pontual
                // do site) — antes isso derrubava a checagem INTEIRA e perdia o progresso
                // de todas as outras AISPs. Agora captura aqui: se falhar, tenta de novo
                // e, se mesmo assim continuar falhando, pula só essa AISP e segue o run.
                try {
                    // Garante que existe uma sessão viva: loga na 1ª vez, e refaz o
                    // login se a página tiver morrido (ex: a sessão realmente expirou
                    // depois de muito tempo, ou o site derrubou a conexão). Como isso
                    // só acontece em caso de problema, o normal é logar uma vez só.
                    if (!paginaSessao || paginaSessao.isClosed()) {
                        console.log("🔑 Fazendo login" + (paginaSessao ? " de novo (a sessão anterior caiu)" : "") + "...");
                        try {
                            paginaSessao = await fazerLoginEAbrirDelegada(context, tirarScreenshotErro);
                            falhasDeLoginSeguidas = 0; // login deu certo — reseta o contador específico
                            precisaTelaCompleta = true; // login novo/relogin: a próxima busca precisa da tela cheia
                        } catch (erroLogin) {
                            falhasDeLoginSeguidas++;
                            throw erroLogin; // deixa cair no catch de fora, que já sabe tratar (log + continue)
                        }
                    }
                    resultadoBusca = await pesquisarEscalas(paginaSessao, aisp, tirarScreenshotErro, precisaTelaCompleta);
                    precisaTelaCompleta = false; // a partir daqui, a página já está aberta — próximas áreas usam o caminho rápido
                    if (!melhorResultado || resultadoBusca.linhas.length > melhorResultado.linhas.length) {
                        melhorResultado = resultadoBusca;
                    }
                } catch (e) {
                    ultimoErroAisp = e;
                    console.log("   ❌ Falha ao pesquisar AISP " + aisp + " (tentativa " + tentativaAisp + "/" + MAX_TENTATIVAS_AISP + "): " + e.message);
                    resultadoBusca = null;
                    // ⚠️ CORREÇÃO 05/08/2026 (bug real, confirmado em log): aqui antes
                    // havia um "descarta a sessão e loga de novo" como rede de
                    // segurança pro caso da sessão ter expirado. Na prática isso virou
                    // o PROBLEMA: qualquer falha isolada (ex: uma renavegação lenta)
                    // disparava um login novo, e login atrás de login degradava o
                    // site, causando ainda mais falhas — bola de neve que derrubou um
                    // run inteiro (10/18 áreas em 22min, quase tudo falhando, um login
                    // por área). Agora a sessão é MANTIDA mesmo quando uma área falha:
                    // a área seguinte tenta com a mesma sessão, que quase sempre ainda
                    // está viva. Só quando a página realmente morre (isClosed) é que um
                    // novo login acontece — ver a verificação logo acima.
                    continue;
                }
                var completo = resultadoBusca.totalEsperado === null || resultadoBusca.linhas.length >= resultadoBusca.totalEsperado;
                // ⚠️ CORREÇÃO 21/08/2026 (a pedido do usuário, log real do DEJEM): a
                // reconfirmação de "0 registros" foi criada na época em que CADA
                // AISP fazia login do zero — fazia sentido desconfiar de um "0" logo
                // após um login recém-feito. Hoje o login é ÚNICO pra checagem
                // inteira, então esse risco só existe de verdade na 1ª área do run;
                // da 2ª em diante, a sessão já provou que funciona (já leu dado real
                // antes). Continuar reconfirmando em TODAS as áreas só pagava um
                // preço à toa — no DEJEM (a maioria das 14 áreas costuma estar
                // vazia mesmo) isso quase dobrava o tempo do run inteiro (13 áreas
                // "0" pagando reconfirmação = ~3min30 desperdiçados num run de
                // 7min21). Restrito a "i === 0" (só a 1ª área do índice do run).
                if (completo && resultadoBusca.totalEsperado === 0 && tentativaAisp === 1 && i === 0) {
                    console.log("   ℹ️ Veio com 0 registros na 1ª tentativa — confirmando com mais uma antes de aceitar (pode ser efeito do login ainda assentando)...");
                    continue;
                }
                if (completo) break;

                if (resultadoBusca.cresceuDuranteLeitura) {
                    // O motivo de estar incompleto é lançamento em andamento, não erro —
                    // devolve essa tentativa pro "orçamento" de erro (não deveria contar).
                    tentativaAisp--;
                    tentativaCrescimento++;
                    if (Date.now() - inicioPerseguicaoAisp > LIMITE_PERSEGUICAO_CRESCIMENTO_MS) {
                        console.log("⏱️ Mais de 5min perseguindo um lançamento em andamento na AISP " + aisp +
                            " (" + resultadoBusca.linhas.length + "/" + resultadoBusca.totalEsperado + ") — " +
                            "desistindo por agora e ENVIANDO o que já foi capturado (as que ainda faltarem entram " +
                            "no radar como novas no próximo ciclo, sem duplicar as que já foram avisadas agora).");
                        // ⚠️ A PEDIDO DO USUÁRIO: diferente de uma captura incompleta comum
                        // (que é descartada por inteiro — ver mais abaixo), aqui o motivo de
                        // não ter fechado 100% não é falha nenhuma, é a PMESP ainda estar no
                        // meio de um lançamento que demorou mais que 5min pra terminar. Nesse
                        // caso específico, é melhor aceitar e avisar o que já foi confirmado
                        // como real (linhas que apareceram consistentemente) do que fazer o
                        // usuário esperar mais 30min sem nenhum aviso.
                        resultadoBusca.aceitarComoParcial = true;
                        break;
                    }
                    console.log("🆕 A AISP " + aisp + " ainda está recebendo escalas novas (lançamento em andamento — " +
                        "perseguição " + tentativaCrescimento + ") — tentando de novo sem contar como erro...");
                    continue;
                }

                if (tentativaAisp < MAX_TENTATIVAS_AISP) {
                    console.log("⚠️ Só capturei " + resultadoBusca.linhas.length + "/" + resultadoBusca.totalEsperado +
                        " escalas da AISP " + aisp + " — refazendo a busca dessa AISP do zero (tentativa " + (tentativaAisp + 1) + "/" + MAX_TENTATIVAS_AISP + ")...");
                } else {
                    console.log("⚠️ Mesmo depois de " + MAX_TENTATIVAS_AISP + " tentativas, só consegui " + resultadoBusca.linhas.length + "/" + resultadoBusca.totalEsperado +
                        " escalas da AISP " + aisp + " — seguindo com o que tem pra não travar o resto da checagem.");
                }
            }

            if (!resultadoBusca && melhorResultado) {
                console.log("   ℹ️ A última tentativa falhou, mas aproveitando o resultado válido já obtido antes nesta AISP (" +
                    melhorResultado.linhas.length + " escala(s)) em vez de descartar tudo.");
                resultadoBusca = melhorResultado;
            }

            if (!resultadoBusca) {
                console.log("⚠️ Pulando AISP " + aisp + " (" + _nomeDaAisp(aisp) + ") nessa checagem — falhou repetidamente" +
                    (ultimoErroAisp ? (": " + ultimoErroAisp.message) : "") + ". Seguindo pras próximas AISPs.");
                resultadoPorArea.push({ aisp: aisp, nome: _nomeDaAisp(aisp), total: 0, erro: true });

                // "Disjuntor": se várias áreas seguidas falharem, o problema não é
                // de uma área específica — é o site que caiu ou a VPN que oscilou.
                // Continuar só queima o resto do tempo do run falhando (num caso
                // real, 16 minutos jogados fora). Melhor parar e deixar tudo pra
                // próxima checagem, daqui 30 min.
                falhasSeguidas++;
                if (falhasSeguidas >= MAX_FALHAS_SEGUIDAS) {
                    console.log("🛑 " + falhasSeguidas + " áreas seguidas falharam — provavelmente o site da PMESP está " +
                        "fora do ar ou a VPN oscilou. Parando esta checagem pra não queimar o resto do tempo à toa. " +
                        "As áreas restantes serão checadas na próxima execução (30 min).");
                    for (var k = i + 1; k < AISPS_MONITORADAS.length; k++) {
                        resultadoPorArea.push({ aisp: AISPS_MONITORADAS[k], nome: _nomeDaAisp(AISPS_MONITORADAS[k]), total: 0, semTempo: true });
                    }
                    break;
                }
                continue;
            }

            // ⚠️ CORREÇÃO 10/08/2026 (bug real, medido em log): aqui o contador
            // do disjuntor era zerado assim que a área "respondia" — INCLUSIVE
            // quando a resposta era ruim (captura incompleta ou zero suspeito).
            // Num run real, a Paulista veio com 10 de 45 escalas e ainda falhou
            // ao reabrir a tela, mas esse reset a tratou como sucesso: o
            // contador voltou de 2 pra 0, o disjuntor nunca chegou em 3 e o run
            // arrastou até estourar o orçamento de 22 min.
            //
            // Agora o contador só zera mais abaixo, DEPOIS de confirmar que a
            // captura veio completa de verdade. Área incompleta ou com zero
            // suspeito CONTA como sinal de problema (o site não está saudável),
            // então o disjuntor consegue agir bem mais cedo.

            var linhas = resultadoBusca.linhas;

            // ⚠️ CORREÇÃO 05/08/2026 (a pedido do usuário, queixa real): se a
            // captura desta AISP veio INCOMPLETA (ex: 40 de 42 escalas), a
            // leitura parcial é DESCARTADA por inteiro, em vez de registrada.
            //
            // POR QUE: antes, as 40 capturadas eram marcadas como "já vistas" e
            // avisadas no Telegram. No ciclo seguinte, as 2 que faltaram eram
            // finalmente capturadas — e, como nunca tinham sido vistas, saíam
            // como se fossem escalas NOVAS. Resultado: escalas antigas chegando
            // "picado", em avisos separados, dando a impressão de novidade que
            // não existia. Descartando a leitura parcial, a área inteira é
            // tentada de novo na próxima checagem (30 min depois) e só entra no
            // radar quando vier completa — aí você recebe tudo de uma vez só.
            //
            // Custo: uma área incompleta atrasa 1 ciclo. Com a correção de
            // paginação por ID (ver pesquisarEscalas), capturas incompletas
            // ficaram raras, então esse custo quase nunca aparece na prática.
            var capturaIncompleta = resultadoBusca.totalEsperado !== null &&
                linhas.length < resultadoBusca.totalEsperado &&
                !resultadoBusca.aceitarComoParcial;

            // ⚠️ CORREÇÃO 07/08/2026 (bug real, visto em log): "zero falso".
            // Quando a grade responde direito, ela informa "Total de Registros: N"
            // — inclusive quando a área está mesmo vazia (aí vem N=0). Se NÃO
            // conseguimos ler esse total (totalEsperado === null) E ainda por
            // cima a leitura veio com 0 linhas, é sinal de que a tela não
            // carregou de verdade — não de que a área está vazia. No log real,
            // isso fez Centro Novo (que tem 48 escalas) ser registrada como 0.
            // Agora esse caso é tratado como leitura suspeita e descartado,
            // pra área ser checada de novo na próxima passagem.
            var zeroSuspeito = resultadoBusca.totalEsperado === null && linhas.length === 0;
            if (zeroSuspeito) {
                console.log("⚠️ AISP " + aisp + " (" + _nomeDaAisp(aisp) + ") veio com 0 escalas mas SEM o " +
                    "'Total de Registros' da grade — provável tela que não carregou, não área vazia. " +
                    "Descartando essa leitura e deixando pra próxima checagem.");
                resultadoPorArea.push({
                    aisp: aisp, nome: _nomeDaAisp(aisp), total: 0,
                    incompleta: true, capturado: 0, esperado: "?"
                });
                // Leitura ruim conta como sinal de problema pro disjuntor.
                falhasSeguidas++;
                continue;
            }
            if (capturaIncompleta) {
                console.log("⚠️ AISP " + aisp + " (" + _nomeDaAisp(aisp) + ") veio INCOMPLETA (" +
                    linhas.length + "/" + resultadoBusca.totalEsperado + ") — descartando essa leitura parcial " +
                    "e deixando pra próxima checagem, pra não avisar as escalas picado.");
                resultadoPorArea.push({
                    aisp: aisp, nome: _nomeDaAisp(aisp), total: linhas.length,
                    incompleta: true, capturado: linhas.length, esperado: resultadoBusca.totalEsperado
                });
                // Leitura ruim conta como sinal de problema pro disjuntor.
                falhasSeguidas++;
                continue;
            }
            // Captura completa e confiável: agora sim o site provou que está
            // saudável, então zera o contador do disjuntor.
            falhasSeguidas = 0;

            if (resultadoBusca.aceitarComoParcial) {
                console.log("AISP " + aisp + " (" + _nomeDaAisp(aisp) + "): " + linhas.length + "/" +
                    resultadoBusca.totalEsperado + " linha(s) — aceita como parcial (lançamento em andamento " +
                    "há mais de 5min), enviando o que foi capturado. Pode faltar 1-2 escalas dessa AISP pro " +
                    "próximo ciclo, se a PMESP ainda não tiver terminado de lançar tudo.");
                resultadoPorArea.push({
                    aisp: aisp, nome: _nomeDaAisp(aisp), total: linhas.length,
                    parcialAceita: true, capturado: linhas.length, esperado: resultadoBusca.totalEsperado
                });
            } else {
                console.log("AISP " + aisp + " (" + _nomeDaAisp(aisp) + "): " + linhas.length + " linha(s) na grade.");
                resultadoPorArea.push({ aisp: aisp, nome: _nomeDaAisp(aisp), total: linhas.length });
            }
            var novosDestaArea = [];
            for (const l of linhas) {
                var chave = _identidadeDaEscala(aisp, l.data, l.escalaId);
                if (!vistos.has(chave)) {
                    vistos.add(chave);
                    var item = { aisp: aisp, nome: _nomeDaAisp(aisp), modulo: _moduloDaAisp(aisp), ...l };
                    novos.push(item);
                    novosDestaArea.push(item);
                }
            }
            // ⚠️ ADICIONADO 01/09/2026 (a pedido do usuário): manda AGORA as
            // escalas novas dessa área, em vez de esperar a checagem inteira
            // terminar. Uma falha aqui (rede, Telegram fora do ar, etc.) NÃO
            // interrompe a checagem — a escala já foi marcada em "vistos" e
            // continua em "novos", então o notificar.js do final do run ainda
            // vai tentar mandar como rede de segurança.
            if (novosDestaArea.length > 0) {
                var enviouTudoOk = await enviarEscalasDaAreaAgora(aisp, _nomeDaAisp(aisp), _moduloDaAisp(aisp), novosDestaArea);
                if (!enviouTudoOk) {
                    novosPendentesDeEnvio.push(...novosDestaArea);
                }
            }
        }
    } catch (err) {
        console.error("❌ Erro durante a checagem:", err);
        salvarResultado({ erro: String(err).slice(0, 300), novos: novosPendentesDeEnvio, resultadoPorArea: resultadoPorArea });
        salvarVistos(vistos);
        await browser.close();
        process.exit(1);
    }
    await browser.close();

    if (novos.length > 0) {
        console.log("🏆 " + novos.length + " escala(s) nova(s) encontrada(s)!");
        // Agrupa por AISP só pra deixar o log mais fácil de ler — os dados já
        // existem em "novos" (mesmo agrupamento que o notificar.js usa pra
        // montar as mensagens do Telegram), então isso não custa nada a mais
        // de tempo nem de requisição, é só reorganizar o que já foi calculado.
        var porAispNoLog = new Map();
        novos.forEach(function (n) {
            if (!porAispNoLog.has(n.aisp)) porAispNoLog.set(n.aisp, { nome: n.nome, qtd: 0 });
            porAispNoLog.get(n.aisp).qtd++;
        });
        porAispNoLog.forEach(function (info, aispChave) {
            console.log("   🎉 " + info.qtd + " escala(s) nova(s): AISP " + aispChave + " (" + info.nome + ")");
        });
    } else {
        console.log("Nada de novo nesta checagem.");
    }

    var agora = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
    salvarResultado({ agora: agora, novos: novosPendentesDeEnvio, resultadoPorArea: resultadoPorArea });

    salvarVistos(vistos);
})();
