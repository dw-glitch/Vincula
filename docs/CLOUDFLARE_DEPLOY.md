# Vincula no Cloudflare Workers

## Identidade da aplicação
- Repositório-fonte: `dw-glitch/Vincula`, branch `main`
- Worker: `vincula-cloudflare`
- Conta Cloudflare esperada: a mesma do GRCON, com subdomínio `grcon-qualidade.workers.dev`
- URL de produção **prevista**, a confirmar somente após deploy: `https://vincula-cloudflare.grcon-qualidade.workers.dev/`
- Interface inteiramente estática. PDFs, LDs e Relações são processados localmente no navegador e seus Web Workers; não há API de upload.

## Build isolado
```bash
node tests/run.js
node tests/conference-relation.js
node tests/ld-status.js
npm run build
npm run verify:cloudflare
npx --yes wrangler@4.34.0 deploy --config wrangler.jsonc
```

O build inclui apenas `index.html`, `styles.css`, `assets/`, `lib/` e `src/`, além de `deployment-meta.json`. Arquivos de código-fonte necessários no navegador e o worker `src/workers/ld-worker.js` permanecem acessíveis. `tests/`, documentação, GitHub, configurações de deploy e arquivos confidenciais não são expostos como assets.

## Automação como no GRCON
- A opção principal é conectar o repositório `dw-glitch/Vincula` ao Worker no painel Cloudflare: Workers & Pages → Create → GitHub ou Worker existente → Settings → Builds → Connect.
- **Nome do Worker tem que ser `vincula-cloudflare`**, idêntico ao de `wrangler.jsonc`.
- Branch `main`, build command `npm run build && npm run verify:cloudflare`, deploy command `npx wrangler deploy --config wrangler.jsonc`.
- Alternativamente, o workflow do GitHub Actions `deploy-cloudflare.yml` publica ao atualizar `main` quando os secrets deste repositório `CLOUDFLARE_API_TOKEN` e `CLOUDFLARE_ACCOUNT_ID` estiverem configurados. Não é necessário habilitar as duas automações ao mesmo tempo.
- Os secrets do repositório `GRCON` não são automaticamente compartilhados com `Vincula`. Não coloque credenciais em arquivos rastreados no Git.

## Validação e substituição de links
Após publicar, conferir `/`, `/deployment-meta.json`, `/src/core/analyzer.js`, `/src/workers/ld-worker.js`, e testar uma LD exemplo. Somente após essa validação, substituir o atalho Vincula na caixa Aplicativos do GRCON. O endereço antigo da Vercel é mantido temporariamente para rollback.
