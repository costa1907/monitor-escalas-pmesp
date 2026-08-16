// ─────────────────────────────────────────────────────────────────────────
// Envia as notificações do Telegram com base no que o monitor.js encontrou.
// Roda DEPOIS da VPN da PMESP ser desconectada (veja monitorar.yml) — se
// rodasse com a VPN ainda ligada, o Telegram fica inacessível atrás do túnel
// e o envio trava/falha com ETIMEDOUT.
// Lê o arquivo resultado.json (gravado pelo monitor.js) e manda:
//   - as escalas novas, AGRUPADAS por AISP (uma mensagem por área, não uma
//     por escala — o Telegram limita a ~1 mensagem/segundo pro mesmo chat,
//     então mandar uma por escala em runs com muitas novidades de uma vez
//     estourava esse limite e várias mensagens ficavam pra trás silenciosamente);
//   - um resumo final, sempre (ache ou não escala), com todas as áreas.
// Também tem espera entre envios + nova tentativa automática se o Telegram
// recusar por excesso de mensagens (HTTP 429), pra não perder nada.
// ─────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────
// VERSÃO DEJEM (15/08/2026): clone do notificar.js original, adaptado pro
// módulo DEJEM — usa um BOT e CANAL DO TELEGRAM SEPARADOS (a pedido do
// usuário), e lê o resultado_dejem.json em vez do resultado.json da
// Delegada. Toda a lógica de envio, paginação de mensagens grandes e nova
// tentativa em caso de erro 429 é a mesma, já comprovada.
// ─────────────────────────────────────────────────────────────────────────

const fs = require("fs");
const path = require("path");

// Credenciais PRÓPRIAS do canal do DEJEM — não usa as mesmas variáveis da
// Delegada de propósito, já que são bot/canal diferentes.
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN_DEJEM;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID_DEJEM;
const MODULO_LABEL = process.env.MODULO_LABEL_DEJEM || "DEJEM";
const RESULTADO_PATH = path.join(__dirname, "resultado_dejem.json");

// Pausa mínima entre mensagens pro mesmo chat — o Telegram recomenda não passar
// de ~1 msg/segundo pro mesmo destinatário.
// CORREÇÃO 01/08/2026 (bug real, confirmado): o Telegram permite no máximo
// 20 mensagens por minuto pro MESMO grupo/canal (limite oficial — ver
// https://core.telegram.org/bots/faq). O valor antigo (1200ms = ~50 msg/min)
// nunca dava problema em checagens normais (poucas escalas novas por vez),
// mas quando o seen.json foi resetado, a checagem seguinte tratou TODAS as
// escalas atuais como "novas" de uma vez (~30-40 mensagens), estourando esse
// limite logo no início — o Telegram passou a recusar com erro 429, e mesmo
// com as novas tentativas automáticas, isso pode consumir tempo/tentativas
// demais até nada sair de verdade. 3300ms fica seguro (~18 msg/min, com
// margem) mesmo numa enxurrada grande de mensagens de uma vez só.
const PAUSA_ENTRE_ENVIOS_MS = 3300;
function dormir(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function enviarTelegram(texto) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        console.warn("⚠️ TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID não configurados — pulando envio.");
        return;
    }
    var url = "https://api.telegram.org/bot" + TELEGRAM_BOT_TOKEN + "/sendMessage";
    var MAX_TENTATIVAS = 5;
    for (var tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
        var resp = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: texto, parse_mode: "HTML" })
        });
        var data = await resp.json().catch(() => ({}));
        if (data.ok) return true;

        // 429 = "Too Many Requests" — o Telegram manda quanto tempo esperar em
        // data.parameters.retry_after (segundos). Espera esse tempo e tenta de novo
        // em vez de simplesmente perder a mensagem.
        if (resp.status === 429 && data.parameters && data.parameters.retry_after) {
            var esperaMs = (data.parameters.retry_after + 1) * 1000;
            console.warn("⏳ Telegram pediu pra esperar " + data.parameters.retry_after + "s (tentativa " + tentativa + "/" + MAX_TENTATIVAS + ")...");
            await dormir(esperaMs);
            continue;
        }
        console.error("❌ Falha ao enviar Telegram:", JSON.stringify(data));
        return false;
    }
    console.error("❌ Desisti de enviar essa mensagem depois de " + MAX_TENTATIVAS + " tentativas.");
    return false;
}

// ── Agrupa as escalas novas por AISP, pra mandar TODAS as escalas de uma
// mesma área numa única mensagem (em vez de 1 mensagem por escala).
//
// ⚠️ CORREÇÃO 31/07/2026 (bug real, confirmado pelo usuário vendo os avisos
// chegarem "de trás pra frente" no Telegram): usar um objeto comum ({}) aqui
// pra agrupar por AISP parecia inofensivo, mas o JavaScript tem uma regra
// própria pra objetos comuns — quando as CHAVES são números (mesmo que como
// string, tipo "85760"), ele reordena essas chaves em ordem NUMÉRICA
// CRESCENTE automaticamente, ignorando totalmente a ordem em que foram
// inseridas. Como as AISPs vão de 85760 (25 de Março, a 1ª da lista) até
// 85741 (Feira da Madrugada, a última), essa reordenação automática INVERTIA
// a sequência de envio: a 1ª área da lista (85760, maior número) virava a
// ÚLTIMA mensagem enviada. Corrigido usando um Map em vez de objeto comum —
// Map SEMPRE preserva a ordem de inserção, não importa o tipo da chave.
function agruparPorArea(novos) {
    var porAisp = new Map();
    novos.forEach(function (n) {
        if (!porAisp.has(n.aisp)) porAisp.set(n.aisp, { nome: n.nome, aisp: n.aisp, itens: [] });
        porAisp.get(n.aisp).itens.push(n);
    });
    return Array.from(porAisp.values());
}

function abreviarAno(data) {
    // dd/mm/aaaa -> dd/mm/aa — corta 2 caracteres da 1ª linha, que é a mais
    // apertada pra caber numa linha só em telas de canal (mais estreitas que
    // conversa direta — confirmado pelo usuário comparando os dois).
    return String(data).replace(/\/\d{2}(\d{2})$/, "/$1");
}

function formatarLinhaEscala(n) {
    // Ordem confirmada pelo usuário direto no site: "Efetivo Tot." é o total de
    // vagas disponíveis pra marcar, e "Inscritos" é quantas já foram preenchidas
    // — antes estava invertido na mensagem.
    //
    // CORREÇÃO 31/07/2026 (parte 4, a pedido do usuário): voltou pro formato
    // com os emojis 🆔 (ID) e 🕐 (horário) — as tentativas anteriores de tirar
    // esses emojis pra economizar espaço não foram o que o usuário queria
    // manter. A única mudança que ficou pra ajudar a caber na 1ª linha foi o
    // ano abreviado (dd/mm/aa em vez de dd/mm/aaaa), que sozinho já corta 2
    // caracteres sem mudar o visual dos emojis.
    return "📅 " + abreviarAno(n.data) + " 🆔 " + n.escalaId + " 🕐 " + n.horaIni + " x " + n.horaFim + "\n" +
        "👥 Vagas: <b>" + (n.efetivoTotal || "?") + "</b>  |  Inscritos: " + (n.inscritos || "?") + "\n" +
        "⏳ Limite Inscrição: " + (n.dataLimite || "?");
}

// O Telegram tem um limite físico de ~4096 caracteres por mensagem. Em vez de
// cortar num número fixo de escalas, junta o MÁXIMO que couber de verdade
// dentro desse limite, e só abre uma mensagem nova quando realmente não cabe
// mais nada — assim, áreas com poucas escalas saem tudo numa mensagem só, e
// só áreas com MUITAS escalas (que não cabem de jeito nenhum) viram 2+ mensagens.
var LIMITE_SEGURO_CARACTERES = 3800; // margem abaixo do limite real de 4096
function montarMensagensDoGrupo(grupo) {
    var mensagens = [];
    // CORREÇÃO 31/07/2026 (rodapé mais profissional, a pedido do usuário):
    // trocado o texto casual/apressado por um tom institucional, com um link
    // clicável de verdade ("saiba mais") que abre o sistema da PMESP direto —
    // mesmo endereço que o robô já usa pra fazer login sozinho (LOGIN_URL).
    // Escapado como HTML porque a mensagem inteira usa parse_mode "HTML".
    var rodape = "\n\nMonitoramento em tempo real. Garanta sua inscrição utilizando o nosso robô: " +
        "<a href=\"http://intranet.policiamilitar.sp.gov.br/\">saiba mais</a>.";
    var partesTotal = 1;
    // primeiro calcula quantas mensagens vão ser precisas, pra já numerar "parte X/Y"
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
        // CORREÇÃO 31/07/2026 (cabeçalho mais "profissional", a pedido do
        // usuário): tirado o emoji 👀. 1ª linha só com a contagem (em negrito),
        // 2ª linha com nome + AISP (sem negrito, sem emoji) — simulado e
        // aprovado pelo usuário antes de aplicar de vez. A área com o nome
        // mais longo cadastrado ("Volante Cenas Abertas de Uso") fica numa
        // zona de risco de quebrar essa 2ª linha (~41 caracteres), mas as
        // outras 17 áreas são bem mais curtas e devem caber numa linha só.
        // CORREÇÃO 31/07/2026 (cabeçalho, ajuste fino a pedido do usuário):
        // 2ª linha (nome + AISP) agora também em negrito, e o indicador de
        // parte trocou de "— parte 2/3" (travessão + barra deitada) pra
        // "(parte 2 | 3)" (parênteses + barra em pé com espaço) — visual mais
        // limpo, testado e aprovado pelo usuário antes de aplicar.
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

(async function main() {
    var resultado;
    try {
        resultado = JSON.parse(fs.readFileSync(RESULTADO_PATH, "utf8"));
    } catch (e) {
        console.log("ℹ️ Nenhum resultado.json encontrado — nada pra notificar (provavelmente a checagem nem rodou).");
        return;
    }

    if (resultado.erro) {
        // ⚠️ CORREÇÃO 15/08/2026 (a pedido do usuário): erros técnicos da
        // checagem (ex: falha de VPN, timeout) NÃO são mais enviados pro
        // canal do Telegram — o público do canal não deve ver esse tipo de
        // mensagem, que não tem utilidade pra quem só quer saber de escala
        // nova. O erro continua aparecendo no log do GitHub Actions
        // normalmente, que é onde a investigação de problemas acontece.
        console.log("⚠️ A checagem deu erro (não notificado no Telegram, só aqui no log): " + resultado.erro);
        return;
    }

    var novos = resultado.novos || [];
    var resultadoPorArea = resultado.resultadoPorArea || [];
    var agora = resultado.agora || new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });

    var grupos = agruparPorArea(novos);
    var totalMensagens = grupos.reduce(function (soma, g) { return soma + montarMensagensDoGrupo(g).length; }, 0);
    console.log("📨 " + novos.length + " escala(s) nova(s) em " + grupos.length + " área(s) — vão sair em " + totalMensagens + " mensagem(ns) de novidades + 1 resumo.");

    var primeiraMensagem = true;
    for (const grupo of grupos) {
        var mensagensDoGrupo = montarMensagensDoGrupo(grupo);
        for (const msg of mensagensDoGrupo) {
            if (!primeiraMensagem) await dormir(PAUSA_ENTRE_ENVIOS_MS);
            primeiraMensagem = false;
            await enviarTelegram(msg);
        }
    }

    // ⚠️ CORREÇÃO 10/08/2026 (a pedido do usuário): o resumo de fim de
    // checagem ("🔎 Checagem concluída!", com a lista de todas as AISPs e os
    // totais) foi REMOVIDO. Agora o canal recebe apenas os avisos de escalas
    // novas, sem a mensagem de fechamento a cada ciclo.
    //
    // Consequência a ter em mente: as informações de diagnóstico que só
    // apareciam ali (🔴 área que falhou, 🟡 área que veio incompleta,
    // ⏭️ área que não deu tempo) deixam de ser visíveis no Telegram. Elas
    // continuam registradas no log do GitHub Actions, que é onde dá pra
    // investigar quando algo parecer estranho.
    if (novos.length === 0) {
        console.log("ℹ️ Nenhuma escala nova nessa checagem — nada a enviar.");
    } else {
        console.log("✅ " + novos.length + " escala(s) nova(s) avisada(s). Resumo final desativado a pedido do usuário.");
    }
})();
