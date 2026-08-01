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
// Rótulo do módulo/turno mostrado no resumo (ex: "[M1]"). Configurável via
// variável do GitHub Actions (vars.MODULO_LABEL no monitorar.yml) — assim,
// se um dia esse mesmo código for reaproveitado pra outro módulo (M2, M3...),
// basta trocar a variável, sem precisar editar o código.
const MODULO_LABEL = process.env.MODULO_LABEL || "M1";
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
//
// ⚠️ CORREÇÃO 31/07/2026 (bug real, confirmado pelo usuário vendo os avisos
// chegarem "de trás pra frente" no Telegram): usar um objeto comum ({}) aqui
// pra agrupar por AISP parecia inofensivo, mas o JavaScript tem uma regra
// própria pra objetos comuns — quando as CHAVES são números (mesmo que como
// string, tipo "85760"), ele reordena essas chaves em ordem NUMÉRICA
// CRESCENTE automaticamente, ignorando tot
