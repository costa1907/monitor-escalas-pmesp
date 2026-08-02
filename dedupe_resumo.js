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
// COMO FUNCIONA: bots não têm como "listar o histórico" de um canal via API
// (limitação do Bot API), mas TODO bot que é membro/admin de um canal recebe
// as mensagens novas postadas dali em diante através de getUpdates — como
// esse bot foi adicionado recentemente, ele já está recebendo as mensagens
// de resumo assim que elas são postadas. Por isso essa limpeza só vale daqui
// pra frente (não apaga resumos duplicados antigos, de antes do bot existir).
// ─────────────────────────────────────────────────────────────────────────

const TOKEN = process.env.TELEGRAM_APAGADOR_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

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

    console.log("📋 " + resumos.length + " mensagem(ns) de resumo encontrada(s) nas atualizações recentes.");

    if (resumos.length >= 2) {
        var anterior = resumos[resumos.length - 2];
        var atual = resumos[resumos.length - 1];
        if (semDataHora(anterior.text) === semDataHora(atual.text)) {
            console.log("🗑️ Resumo repetido (mesmo conteúdo, só mudou a data/hora) — apagando o mais antigo (ID " + anterior.message_id + ")...");
            var del = await chamarApi("deleteMessage", { chat_id: CHAT_ID, message_id: anterior.message_id });
            console.log(del.ok ? "✅ Apagado com sucesso." : "❌ Falha ao apagar: " + JSON.stringify(del));
        } else {
            console.log("ℹ️ O resumo mudou de conteúdo desde o anterior — mantendo os dois.");
        }
    }

    // "Confirma" as atualizações recebidas (avança o offset) pra não ficar
    // reprocessando as mesmas mensagens de novo em cada execução.
    if (data.result.length > 0) {
        var ultimoId = data.result[data.result.length - 1].update_id;
        await chamarApi("getUpdates", { offset: ultimoId + 1 });
    }
})();
