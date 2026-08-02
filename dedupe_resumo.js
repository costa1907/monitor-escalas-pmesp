// ─────────────────────────────────────────────────────────────────────────
// Bot SEPARADO (2º bot, admin no mesmo canal) que verifica se a mensagem de
// resumo "Checagem concluída!" mais recente é EQUIVALENTE à anterior (mesmos
// números, ignorando só a linha de data/hora, que muda sempre) — se for,
// apaga a mensagem de resumo mais ANTIGA, deixando só a mais atual no canal.
//
// Roda como um passo a mais no MESMO workflow do monitor.js/notificar.js,
// logo depois do envio da notificação, usando um bot e token PRÓPRIOS
// (TELEGRAM_APAGADOR_TOKEN) — o mesmo TELEGRAM_CHAT_ID de sempre.
//
// ⚠️ CORREÇÃO 02/08/2026 (bug real, confirmado pelo usuário vendo que nunca
// apagava nada): a 1ª versão comparava as DUAS últimas mensagens vindas do
// getUpdates() na MESMA execução — mas como o próprio script "confirma"
// (consome) as atualizações no final de CADA execução pra não reprocessar,
// na execução seguinte a mensagem anterior já tinha sumido da fila do
// Telegram, sobrando só a mensagem nova pra comparar (e com uma só, não tem
// como comparar nada — por isso nunca apagava). Corrigido guardando o
// último resumo já visto num arquivo próprio (ultimo_resumo.json, commitado
// no repositório, do mesmo jeito que o seen.json já faz) — assim SEMPRE tem
// o resumo anterior disponível pra comparar, não importa quando rodar.
// ─────────────────────────────────────────────────────────────────────────

const fs = require("fs");
const path = require("path");

const TOKEN = process.env.TELEGRAM_APAGADOR_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ESTADO_PATH = path.join(__dirname, "ultimo_resumo.json");

function carregarEstadoAnterior() {
    try { return JSON.parse(fs.readFileSync(ESTADO_PATH, "utf8")); }
    catch (e) { return null; }
}
function salvarEstado(estado) {
    fs.writeFileSync(ESTADO_PATH, JSON.stringify(estado, null, 0));
}

async function chamarApi(metodo, params) {
    var url = "https://api.telegram.org/bot" + TOKEN + "/" + metodo;
    var resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params || {})
    });
    return resp.json();
}

// Remove só a linha de data/hora (a linha que começa com "📅") antes de
// comparar — essa linha muda em TODA mensagem, mesmo quando o resto é idêntico.
function semDataHora(texto) {
    return texto.split("\n").filter(function (linha) {
        return linha.indexOf("📅") !== 0;
    }).join("\n").trim();
}

(async function main() {
    if (!TOKEN || !CHAT_ID) {
        console.log("ℹ️ TELEGRAM_APAGADOR_TOKEN / TELEGRAM_CHAT_ID não configurados — pulando.");
        return;
    }

    var data = await chamarApi("getUpdates", { allowed_updates: ["channel_post"], limit: 100 });
    if (!data.ok) {
        console.error("❌ Falha ao buscar atualizações:", JSON.stringify(data));
        return;
    }

    var resumos = data.result
        .filter(function (u) {
            return u.channel_post &&
                String(u.channel_post.chat.id) === String(CHAT_ID) &&
                u.channel_post.text &&
                u.channel_post.text.indexOf("Checagem concluída!") !== -1;
        })
        .map(function (u) { return u.channel_post; })
        .sort(function (a, b) { return a.message_id - b.message_id; });

    console.log("📋 " + resumos.length + " mensagem(ns) de resumo nova(s) nas atualizações desde a última vez.");

    if (resumos.length > 0) {
        var maisRecente = resumos[resumos.length - 1];
        var estadoAnterior = carregarEstadoAnterior();

        if (estadoAnterior && semDataHora(estadoAnterior.texto) === semDataHora(maisRecente.text)) {
            console.log("🗑️ Resumo repetido (mesmo conteúdo do anterior, só mudou a data/hora) — apagando o mais antigo (ID " + estadoAnterior.message_id + ")...");
            var del = await chamarApi("deleteMessage", { chat_id: CHAT_ID, message_id: estadoAnterior.message_id });
            console.log(del.ok ? "✅ Apagado com sucesso." : "❌ Falha ao apagar: " + JSON.stringify(del));
        } else if (estadoAnterior) {
            console.log("ℹ️ O resumo mudou de conteúdo desde o anterior — mantendo os dois.");
        } else {
            console.log("ℹ️ Primeira vez rodando (ou arquivo de estado ainda não existia) — nada pra comparar ainda.");
        }

        salvarEstado({ message_id: maisRecente.message_id, texto: maisRecente.text });
    }

    // "Confirma" as atualizações recebidas (avança o offset) pra não ficar
    // reprocessando as mesmas mensagens de novo em cada execução. Isso é
    // seguro agora porque o "estado anterior" não depende mais dessa fila —
    // já foi salvo no arquivo acima.
    if (data.result.length > 0) {
        var ultimoId = data.result[data.result.length - 1].update_id;
        await chamarApi("getUpdates", { offset: ultimoId + 1 });
    }
})();
