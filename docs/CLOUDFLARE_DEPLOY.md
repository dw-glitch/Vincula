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

## Automação da publicação
Duas automações convivem, ambas apontando para o mesmo Worker `vincula-cloudflare`:

1. **Workers Builds conectado ao GitHub** (Workers & Pages → vincula-cloudflare → Settings → Builds),
   branch `main`, build `npm run build`, deploy `npx wrangler deploy`. Dispara sozinho em pushes
   feitos por pessoas, mas **não dispara para pushes feitos por apps/bots do GitHub** (por exemplo,
   merges feitos por integrações). Foi o que deixou a versão 2.3.0 sem publicação automática.
2. **GitHub Actions `deploy-cloudflare.yml`**, que roda em todo push no `main`, independentemente de
   quem fez o push: roda `npm test`, gera e valida o pacote e então chama o **deploy hook** do
   Workers Builds (secret `CLOUDFLARE_DEPLOY_HOOK`). Em seguida, espera `/deployment-meta.json`
   mostrar o commit publicado (até ~20 min, por causa da fila da Cloudflare).
   - Sem o hook, mas com `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`, publica direto com Wrangler.
   - Sem nenhum secret, apenas avisa que não publicou.

Configuração do secret: GitHub → `dw-glitch/Vincula` → Settings → Secrets and variables → Actions →
New repository secret → nome `CLOUDFLARE_DEPLOY_HOOK`, valor = URL do deploy hook
(Workers & Pages → vincula-cloudflare → Settings → Builds → Deploy hooks, hook
"GitHub Actions - main (apos testes)"). A URL do hook é uma credencial: não a coloque em arquivos do
repositório. Para revogar, apague o hook no painel e crie outro.

O `deployment-meta.json` registra o hash do commit publicado. Em builds disparados por hook, a
Cloudflare informa o nome do branch em `WORKERS_CI_COMMIT_SHA`, então o script usa `git rev-parse HEAD`.

Os secrets do repositório `GRCON` não são compartilhados com o `Vincula`.

## Validação e substituição de links
Após publicar, conferir `/`, `/deployment-meta.json`, `/src/core/analyzer.js`, `/src/workers/ld-worker.js`, e testar uma LD exemplo. Somente após essa validação, substituir o atalho Vincula na caixa Aplicativos do GRCON. O endereço antigo da Vercel é mantido temporariamente para rollback, congelado no último deploy: `vercel.json` desliga os deploys automáticos da Vercel (`git.deploymentEnabled: false`), então ela não recebe mais as correções publicadas na Cloudflare.
