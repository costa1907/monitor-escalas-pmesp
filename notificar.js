// ─────────────────────────────────────────────────────────────────────────
// Envia as notificações do Telegram com base no que o monitor.js encontrou.
// Roda DEPOIS da VPN da PMESP ser desconectada (veja monitorar.yml) — se
// rodasse com a VPN ainda ligada, o Telegram fica inacessível atrás do túnel
// e o envio trava/falha com ETIMEDOUT.
// Lê o arquivo resultado.json (gravado pelo monitor.js) e manda:
//   - uma mensagem por escala nova encontrada;
//   - um resumo final, sempre (ache ou não escala), com todas as áreas.
// ─────────────────────────────────────────────────────────────────────────

const fs = require("fs");
const path = require("path");

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const RESULTADO_PATH = path.join(__dirname, "resultado.json");

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
        await enviarTelegram("⚠️ O monitor de escalas deu erro: " + resultado.erro);
        return;
    }

    var novos = resultado.novos || [];
    var resultadoPorArea = resultado.resultadoPorArea || [];
    var agora = resultado.agora || new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });

    for (const n of novos) {
        var texto = "👀 <b>Escala disponível pra marcar!</b>\n" +
            "📍 " + n.nome + " (AISP " + n.aisp + ")\n" +
            "📅 " + n.data + "\n" +
            "🕐 " + n.horaIni + " x " + n.horaFim + "\n" +
            "🆔 Escala " + n.escalaId + "\n\n" +
            "Entre no site e se inscreva antes que alguém pegue!";
        await enviarTelegram(texto);
    }

    // ── Resumo, sempre enviado (ache ou não escala), com TODAS as áreas listadas ──
    var totalGeral = resultadoPorArea.reduce(function (soma, a) { return soma + a.total; }, 0);
    var resumo = "🔎 <b>Checagem concluída</b> — " + agora + "\n" +
        "Total: " + totalGeral + " escala(s) em " + resultadoPorArea.length + " área(s)\n\n" +
        resultadoPorArea
            .map(function (a) { return (a.total > 0 ? "🟢 " : "⚪ ") + a.nome + " (" + a.aisp + "): " + a.total; })
            .join("\n") +
        "\n\n" +
        (novos.length > 0
            ? ("🎉 " + novos.length + " são NOVAS desde a última checagem (aviso já mandado acima).")
            : "Nenhuma novidade desde a última checagem.");
    await enviarTelegram(resumo);
})();
