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

const fs = require("fs");
const path = require("path");

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const RESULTADO_PATH = path.join(__dirname, "resultado.json");

// Pausa mínima entre mensagens pro mesmo chat — o Telegram recomenda não passar
// de ~1 msg/segundo pro mesmo destinatário.
const PAUSA_ENTRE_ENVIOS_MS = 1200;
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
function agruparPorArea(novos) {
    var porAisp = {};
    novos.forEach(function (n) {
        if (!porAisp[n.aisp]) porAisp[n.aisp] = { nome: n.nome, aisp: n.aisp, itens: [] };
        porAisp[n.aisp].itens.push(n);
    });
    return Object.keys(porAisp).map(function (k) { return porAisp[k]; });
}

function formatarLinhaEscala(n) {
    // Ordem confirmada pelo usuário direto no site: "Efetivo Tot." é o total de
    // vagas disponíveis pra marcar, e "Inscritos" é quantas já foram preenchidas
    // — antes estava invertido na mensagem.
    return "📅 " + n.data + "   🆔 " + n.escalaId + "   🕐 " + n.horaIni + " x " + n.horaFim + "\n" +
        "👥 Total de Vagas: " + (n.efetivoTotal || "?") + " | Inscritos: " + (n.inscritos || "?") + "\n" +
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
    var rodape = "\n\nEntre no site e se inscreva antes que alguém pegue!";
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
        var cabecalho = "👀 <b>" + itensNaParte + " escala(s) nova(s) — " + grupo.nome + " (AISP " + grupo.aisp + ")" +
            (partesTotal > 1 ? " — parte " + parteAtual + "/" + partesTotal : "") + "</b>\n\n";
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
        console.log("Notificando erro da checagem...");
        // Escapa <, > e & — mensagens de erro costumam trazer stack trace de JS
        // (ex: "<anonymous>"), e isso quebra o parser de HTML do Telegram se
        // mandado cru, fazendo a notificação de erro falhar silenciosamente.
        var erroEscapado = String(resultado.erro)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        await enviarTelegram("⚠️ O monitor de escalas deu erro: " + erroEscapado);
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

    // ── Resumo, sempre enviado (ache ou não escala), com TODAS as áreas listadas ──
    if (!primeiraMensagem) await dormir(PAUSA_ENTRE_ENVIOS_MS);
    var totalGeral = resultadoPorArea.reduce(function (soma, a) { return soma + a.total; }, 0);
    var resumo = "🔎 <b>Checagem concluída</b> — " + agora + "\n" +
        "Total: " + totalGeral + " escala(s) em " + resultadoPorArea.length + " área(s)\n\n" +
        resultadoPorArea
            .map(function (a) {
                // "erro: true" = essa área falhou repetidamente e foi pulada nessa
                // checagem (não é um "0" de verdade) — sinaliza diferente pra não
                // confundir com uma área que realmente não tem escala disponível.
                var icone = a.erro ? "🔴" : (a.total > 0 ? "🟢" : "⚪");
                var sufixo = a.erro ? " (falhou nessa checagem, tentaremos de novo na próxima)" : "";
                return icone + " " + a.nome + " (" + a.aisp + "): " + a.total + sufixo;
            })
            .join("\n") +
        "\n\n" +
        (novos.length > 0
            ? ("🎉 " + novos.length + " são NOVAS desde a última checagem (avisos já mandados acima).")
            : "Nenhuma novidade desde a última checagem.");
    await enviarTelegram(resumo);
})();
