# Vincula — Plano de evolução

O que está entregue na 2.0 e o que vem depois. Cada item traz o ponto de extensão já existente
no código, para que a evolução não exija reescrita.

## Entregue na 2.0

| Área | Estado |
|---|---|
| Índice de acesso direto `O(1)` | ✅ `indexer.js` |
| Cache por hash de conteúdo, com invalidação automática | ✅ `tasks.js` |
| Processamento paralelo em Web Workers com afinidade | ✅ `pool.js` |
| Contingência automática sem workers | ✅ `pool.js` |
| Leitura por offsets, sem DOM | ✅ `xlsx.js` |
| Escrita inteligente (só grava o que mudou) | ✅ `analyzer.js` |
| Snapshot e rollback estruturais | ✅ `applier.js` |
| Auditoria de integridade célula a célula | ✅ `xlsx.js` |
| Data real do Excel, sem hora | ✅ `dates.js` + `xlsx.js` |
| Relatório de 8 abas + log JSON + manifesto de hashes | ✅ `audit.js` |
| Barras por etapa, métricas em tempo real, ETA, cancelamento | ✅ `app.js` |
| Filtros, busca e pré-visualização paginada | ✅ `app.js` |
| Suíte automatizada e teste de volume | ✅ `tests/` |

## 2.1 — Conforto operacional

**Múltiplas Relações GRCON na mesma execução.**
`buildGlobalIndex` já recebe uma lista de índices e `analyze` não pressupõe origem única.
Falta a interface aceitar mais de um arquivo de relação e definir a precedência entre elas
(sugestão: ordem de carregamento, com a última vencendo, coerente com a regra de duplicidade atual).

**Perfis de mapeamento salvos.**
Guardar em `localStorage` o mapeamento por assinatura de cabeçalho, para que layouts recorrentes
venham pré-configurados. A assinatura pode ser o hash dos cabeçalhos normalizados da linha
detectada — `headers.js` já produz essa normalização.

**Exportar/importar configuração de mapeamento** como JSON, para padronizar equipes.

**Pré-visualização com diferença lado a lado** da célula, mostrando o XML antes/depois para
auditoria técnica pontual.

## 2.2 — Volume e resiliência

**Streaming real de leitura.**
Hoje o XML da aba é materializado como string antes da varredura. Para planilhas acima de ~200 MB
vale trocar por leitura em blocos: o scanner de `xlsx.js` já é linear e por offsets, então basta
alimentá-lo por pedaços mantendo uma janela de sobreposição do tamanho da maior célula.

**Persistência da sessão.**
Guardar índices em IndexedDB para retomar uma execução interrompida sem recarregar os arquivos.
O índice já é serializável por construção (datas viajam como ISO, não como `Date`).

**Retentativa automática por arquivo.**
O pool já isola falhas por arquivo; falta a política de retry com backoff antes de marcar erro.

**Relatório incremental.**
Emitir o relatório à medida que as LDs terminam, para execuções muito longas.

## 3.0 — Plataforma

**Plugins de layout.**
Transformar `headers.js` em um registro de perfis carregáveis, permitindo que novas famílias
documentais sejam adicionadas sem alterar o núcleo:

```js
Vincula.headers.registerProfile('ld-obras', {
  document: { exact: [...], required: [...], forbidden: [...] },
  grdt:     { ... },
  dateEffective: { ... },
});
```

**Novos tipos documentais e novos campos atualizáveis.**
A restrição a duas colunas é deliberada e é uma garantia de segurança, não uma limitação técnica.
Ampliá-la exige tornar o conjunto autorizado uma configuração explícita, mantendo a auditoria de
integridade sobre o conjunto declarado — a verificação já opera sobre um `Set` de referências
autorizadas, então o mecanismo não muda.

**Conectores corporativos.**
`tasks.js` é um contrato de mensagens. Uma origem remota (SharePoint, S3, API do sistema emissor
da GRCON) entra como um novo tipo de tarefa que devolve bytes, sem tocar no núcleo.

**Processamento distribuído.**
A unidade de trabalho já é um arquivo e o transporte já é por mensagem. Executar os mesmos
módulos de `src/core/` em Node com uma fila permite distribuir entre máquinas; o `harness.js` dos
testes já demonstra que o núcleo roda fora do navegador sem alteração.

**Assinatura digital do pacote.**
O manifesto com SHA-256 já existe. O passo seguinte é assinar o manifesto, dando não repúdio ao
resultado da execução.

## Dívidas técnicas conhecidas

| Item | Situação |
|---|---|
| `.xls` binário | não suportado — formato distinto, exigiria um leitor próprio |
| Arquivos protegidos por senha | não suportados — o conteúdo é criptografado |
| `styles.xml` ausente | a data é gravada como serial sem formato; ocorrência registrada. Nenhum arquivo gerado pelo Excel cai nesse caso |
| Célula-alvo mesclada | bloqueada por segurança; escrever no não-âncora corromperia a mesclagem |
| Célula-alvo com fórmula | bloqueada por segurança; sobrescrever destruiria o cálculo |

Os dois últimos são decisões de projeto, não limitações: ambos são registrados na aba
*Ocorrências* do relatório para que o usuário decida o que fazer.
