# PlanoAula (PWA) – teste de 7 dias + assinatura mensal/anual

## O que é
Aplicativo instalável (PWA) que gera planos de aula a partir dos Guias Priorizados (guardados no Supabase) e do modelo de plano de cada professor.
- Cadastro → 7 dias grátis (sem cartão). Depois, acesso bloqueado até assinar (mensal ou anual, Mercado Pago).
- O bloqueio é feito no servidor (banco + funções), não só na tela.

## Estrutura
- `public/` – o aplicativo (HTML/JS/CSS, manifest, service worker). Publicar em qualquer hospedagem estática (Vercel).
- `supabase/migrations/001_init.sql` – tabelas, regras de segurança (RLS), gatilho do teste de 7 dias, função de acesso.
- `supabase/functions/generate-plan` – confere o acesso, lê os guias, chama a IA e salva o plano.
- `supabase/functions/mp-checkout` – cria a assinatura recorrente no Mercado Pago.
- `supabase/functions/mp-webhook` – recebe o aviso do Mercado Pago, confirma na API deles e libera/bloqueia o acesso.

## Passo a passo
1. Supabase: crie (ou escolha) um projeto e rode `001_init.sql` (SQL Editor).
2. Publique as 3 funções. `mp-webhook` deve ficar com "Verify JWT" DESLIGADO; as outras duas, LIGADO.
3. Em Edge Functions > Secrets, cadastre (você mesmo, nunca em chat):
   - `ANTHROPIC_API_KEY` – chave da IA
   - `MP_ACCESS_TOKEN` – token de produção do Mercado Pago
   - `PRICE_MONTHLY` (ex.: 19.90), `PRICE_ANNUAL` (ex.: 199.00), `APP_URL` (endereço do app)
4. Mercado Pago > Webhooks: aponte para `https://SEU-PROJETO.supabase.co/functions/v1/mp-webhook` (evento "Planos e assinaturas").
5. `public/config.js`: preencha a URL do Supabase e a chave PUBLICÁVEL (anon). Ajuste os preços exibidos.
6. Publique a pasta `public/` (Vercel). No Supabase > Auth > URL Configuration, informe o endereço do app.
7. Crie sua conta no app e, no SQL Editor, torne-se administrador:
   `update pa_profiles set is_admin = true where id = (select id from auth.users where email = 'SEU_EMAIL');`
   Na aba "Guias (admin)", envie os PDFs dos Guias Priorizados (componente, série, bimestre).

## Pontos de atenção
- Os valores (R$ 19,90 / R$ 199,00) são exemplos: defina os seus.
- Cobrança de assinatura tem obrigações legais (CNPJ/MEI, termos de uso, política de privacidade, cancelamento fácil).
- Os Guias Priorizados são material da SEDUC-SP: confirme se podem ser distribuídos em produto pago.
- Custo da IA é seu: há limite diário por usuário (`DAILY_LIMIT`, padrão 40 planos/24h).
