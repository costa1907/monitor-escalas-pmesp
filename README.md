# Monitor de Escalas — Atividade Delegada PMESP

Fica rodando de graça no GitHub (a cada 30 min), sem precisar do seu computador ligado, e te avisa no Telegram assim que aparecer uma escala nova disponível pra marcar.

## Status

O login e a navegação (CPF/senha → popup → menu "Inscrever PM na Escala Ativ Delegada" → tela de pesquisa) já estão implementados, mapeados a partir de uma gravação real do Playwright Codegen no site. **Ainda não foi testado rodando de ponta a ponta** — é bem provável que a primeira execução precise de 1-2 ajustes, porque automação contra um sistema legado (GeneXus) é sensível a detalhes. Se der erro, o workflow salva uma screenshot do momento do erro como anexo ("Artifact") — é só me mandar ela que eu ajusto.

## Passo a passo

### 1. Criar sua conta no GitHub (gratuita)

Acesse [github.com](https://github.com) → "Sign up" → siga os passos (email, senha, usuário).

### 2. Criar o repositório

1. Clique no `+` no canto superior direito → "New repository".
2. Nome: `monitor-escalas-pmesp` (ou o que quiser).
3. Marque **Public** (pra ter minutos ilimitados de graça).
4. Clique em "Create repository".

### 3. Subir os arquivos

1. Na página do repositório recém-criado, clique em "uploading an existing file" (ou "Add file" → "Upload files").
2. Arraste TODOS os arquivos e pastas desta pasta (`package.json`, `monitor.js`, `seen.json`, `README.md`, e a pasta `.github` inteira com o arquivo `monitorar.yml` dentro) — o GitHub aceita arrastar pastas inteiras.
3. Clique em "Commit changes".

### 4. Configurar os Secrets (usuário, senha e Telegram)

1. No repositório, vá em **Settings** → **Secrets and variables** → **Actions**.
2. Aba "Secrets" → "New repository secret", e crie um de cada vez:
   - `PMESP_USUARIO` → seu CPF de login no site (o mesmo que vai no campo da tela de login).
   - `PMESP_SENHA` → sua senha.
   - `TELEGRAM_BOT_TOKEN` → token do bot (crie um com o [@BotFather](https://t.me/BotFather) no Telegram, mandando `/newbot`).
   - `TELEGRAM_CHAT_ID` → seu Chat ID (pegue com o [@userinfobot](https://t.me/userinfobot)).
3. Aba "Variables" (do lado de "Secrets") → "New repository variable" (opcional, só se quiser mudar o padrão):
   - `PMESP_AISP` → o(s) código(s) de AISP que quer monitorar, separados por vírgula (ex: `82914,85254`). Se não criar essa variável, ele usa `82914` (Av. Liberdade) por padrão. Os códigos das áreas já usadas no seu robô Tampermonkey estão dentro dele, na parte `MODOS_ROBO.DELEGADA.areas`.

### 5. Testar

1. Vá na aba **Actions** do repositório → clique no workflow "Monitorar Escalas PMESP" → botão "Run workflow" → "Run workflow" de novo pra confirmar.
2. Acompanhe clicando na execução que aparece. Se der erro:
   - Abre os logs de cada etapa (clicando nela) pra ver a mensagem de erro.
   - Desce até "Guardar screenshot do erro" → baixa o arquivo "erro-screenshot" (fica como anexo da execução, na parte de baixo da página) e me manda — com a imagem eu consigo ver exatamente em que tela ele travou e ajustar o `monitor.js`.
3. Se der tudo certo, a partir daí ele roda sozinho a cada 30 minutos, pra sempre, sem precisar mexer em mais nada.

## Ajustar o intervalo

Abra `.github/workflows/monitorar.yml` e mude a linha do `cron`. Exemplos:
- A cada 15 min: `*/15 * * * *`
- A cada hora: `0 * * * *`

## Ajustar a janela de datas pesquisada

Por padrão pesquisa de hoje até 45 dias à frente. Pra mudar, abra `monitor.js` e altere o número em `const JANELA_DIAS = 45;`.

## Como funciona por dentro

- Login: preenche CPF (`#vUSRNUMCPFAUX`) e senha (`#vSENHA`) dentro dos frames aninhados da tela de login, clica em "Confirmar", espera a popup com o sistema abrir.
- Navegação: clica no menu "Inscrever PM na Escala Ativ Delegada" e tenta passar pela tela de "declaração de apto" se ela aparecer (ignora se não aparecer).
- Pesquisa: preenche AISP e datas usando o mesmo truque de injeção via API interna do GeneXus (`gx.setVar` + `onchange`) já testado e usado há centenas de versões no seu robô Tampermonkey — os campos de data são um widget de calendário, não aceitam digitação direta como texto comum.
- Leitura da grade: reaproveita os mesmos IDs (`Grid1ContainerTbl`, `NEXT`) que já são usados no robô Tampermonkey pra ler as linhas e paginar.
- Guarda num arquivo `seen.json` (dentro do próprio repositório) quais escalas já foram avisadas, pra não te mandar a mesma mensagem toda hora — o workflow atualiza esse arquivo sozinho a cada execução.
- Só lê a grade (não marca nada) — é puramente um avisador. A marcação continua sendo feita por você, manualmente, no site.
