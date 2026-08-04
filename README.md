<p align="center"><img src="assets/logo-full.svg" alt="Vincula — atualizador inteligente de LD por Relação GRCON" width="420"></p>

# Vincula 2.0

**Atualizador inteligente de LD por Relação GRCON.**

O Vincula recebe uma Relação GRCON e várias LDs (Excel) simultaneamente e atualiza
automaticamente **GRDT** e **Data Efetiva de Emissão** nos documentos correspondentes,
preservando integralmente a estrutura das planilhas e gerando auditoria completa.

Aplicação 100% cliente: não há servidor, banco de dados, login, IA externa ou chave de API.
Nenhum arquivo sai da máquina do usuário.

---

## Como executar

**Publicado (recomendado):** publique a pasta inteira em qualquer hospedagem estática
(Vercel, IIS, Nginx, S3). O `vercel.json` já está incluído.

**Local:** sirva a pasta por HTTP — `npx http-server -p 8080` — e abra `http://localhost:8080`.

> Abrir o `index.html` direto do disco (`file://`) funciona, mas o navegador bloqueia Web Workers
> nesse contexto. O Vincula detecta isso e cai automaticamente para o **modo de contingência**,
> processando na própria página e cedendo o controle entre etapas para não travar a interface.
> O selo no topo indica qual modo está ativo. Para ter o paralelismo, sirva por HTTP.

## Fluxo

1. **Arquivos** — carregue a Relação GRCON e as LDs (arraste ou selecione várias).
2. **Colunas** — confira a detecção automática de aba, linha de cabeçalho e colunas.
3. **Conferência** — pré-visualize documento a documento o que mudaria, com filtros e busca.
4. **Downloads** — baixe as LDs atualizadas, o relatório de auditoria, o log e o pacote ZIP.

## Regras funcionais

### GRDT
- Atualizada apenas quando a relação traz um valor válido; GRDT vazia na relação **preserva** a da LD.
- A formatação, o estilo e o tipo original da célula são preservados.

### Data Efetiva de Emissão
- Origem: coluna `DATA DA GERAÇÃO / POSTAGEM` da Relação GRCON.
- `04/08/2026 08:31:45` é gravada como `04/08/2026` — **data real do Excel**, nunca texto.
- Hora, minuto, segundo e milissegundo são removidos.
- Uma data já existente na LD gravada como *texto* é reescrita como data real do Excel.

### Data inválida
`-`, vazio, `null`, `undefined`, `N/A`, `#N/D` e afins são tratados como ausência de data:
a Data Efetiva de Emissão da LD **é preservada**, a pendência é registrada como
*"Data da postagem inválida"* e o processamento **continua normalmente**.

### Documento não encontrado
Registrado como `NÃO ENCONTRADO` com o motivo *"Documento pertence a outra LD"*.
Não gera erro nem interrompe o processamento.

### Duplicidade
- Duplicado na **relação**: vence a última ocorrência física, inclusive com data vazia.
- Duplicado nas **LDs**: todas as ocorrências exatas do documento são atualizadas.

### Restrição absoluta
Somente as colunas **GRDT** e **Data Efetiva de Emissão** podem ser modificadas.
Toda LD gerada é conferida célula a célula contra o original antes de ser empacotada;
qualquer divergência fora do escopo aborta a gravação daquele arquivo e dispara rollback.

## Detecção inteligente de cabeçalhos

O reconhecimento não depende de grafia exata. Caixa, acentuação, hífens, espaços extras e
palavras de ligação são normalizados, e há um segundo estágio por conjunto de tokens.

| Campo | Grafias aceitas (entre outras) |
|---|---|
| Documento | `DOCUMENTO`, `Código Documento`, `Código do Documento`, `Nº do Documento` |
| GRDT | `GRDT`, `eGRDT`, `E GRDT`, `Número da GRDT` |
| Data Efetiva de Emissão | `DATA EFETIVA DE EMISSÃO`, `Data Efetiva de Emissão`, `data efetiva de emissão`, `DATA EFETIVA EMISSAO`, `Data Efetiva Emissao` |
| Data da geração/postagem | `DATA DA GERAÇÃO / POSTAGEM`, `DATA DA POSTAGEM`, `Data da Geração` |

A detecção também localiza sozinha a linha do cabeçalho em planilhas com título, logotipo ou
linhas em branco no topo, e distingue *data de postagem* de *data efetiva* — nunca confunde as duas.

## Formatos suportados

`.xlsx` e `.xlsm`. Os originais nunca são sobrescritos.
Não há suporte a `.xls` binário nem a arquivos protegidos por senha (criptografados).

## Documentação técnica

| Documento | Conteúdo |
|---|---|
| [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md) | Arquitetura, índices, cache, paralelismo, rollback, auditoria, escalabilidade |
| [`docs/FLUXO.md`](docs/FLUXO.md) | Fluxograma do processamento e máquina de estados |
| [`docs/TESTES.md`](docs/TESTES.md) | Plano de testes e como executá-los |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Plano de evolução para as próximas versões |
| [`CHANGELOG.md`](CHANGELOG.md) | Histórico de versões |

## Testes

```bash
node tests/run.js          # suíte funcional e de integridade (132 verificações)
node tests/bench.js        # teste de volume: 100 LDs × 200 documentos
node tests/bench.js 5 4000 # variação: poucos arquivos, muitas linhas
```

## Estrutura

```
.
├── index.html                 interface
├── styles.css
├── lib/jszip.min.js           única dependência de terceiros
├── assets/                    identidade visual (logo-mark.svg, logo-full.svg)
├── src/
│   ├── core/                  núcleo sem DOM (roda na página e no worker)
│   │   ├── util.js            normalização, referências, hash, formatação
│   │   ├── dates.js           conversão e validação de datas
│   │   ├── headers.js         detecção inteligente de cabeçalhos
│   │   ├── xlsx.js            leitor/gravador XLSX por offsets
│   │   ├── indexer.js         índices da relação e das LDs
│   │   ├── analyzer.js        cruzamento e plano de escrita
│   │   ├── applier.js         gravação, snapshot, rollback, integridade
│   │   ├── audit.js           relatório XLSX + log JSON
│   │   ├── packager.js        pacote ZIP final
│   │   ├── tasks.js           contrato página ↔ worker
│   │   └── engine.js          orquestração e métricas
│   ├── workers/
│   │   ├── ld-worker.js       worker de processamento
│   │   └── pool.js            pool com afinidade e contingência
│   └── ui/app.js              única camada que toca no DOM
├── tests/
└── docs/
```
