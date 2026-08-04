# Vincula 2.0 — Arquitetura

## 1. Princípios

Quatro decisões definem o sistema. Todo o resto decorre delas.

**1. O XML nunca vira DOM.** Cada aba é varrida uma única vez por um scanner linear que registra
apenas os deslocamentos (`start`/`end`) das linhas e das células das colunas de interesse.
A v1 construía um `DOMDocument` por aba de cada arquivo e ainda mantinha um snapshot
`Map<ref, JSON>` de *todas* as células — só isso inviabilizava 100 LDs.

**2. A gravação é emenda, não reescrita.** Escrever significa recortar o intervalo exato da célula
e emendar o novo conteúdo. Tudo que não foi emendado permanece **byte a byte idêntico**.
A preservação de fórmulas, proteção, filtros, validações, comentários, mesclagens, formatação
condicional e estilos deixa de ser uma lista de cuidados e passa a ser consequência estrutural.

**3. Busca é acesso direto.** Documento → ocorrências em `Map`, montado uma vez. O custo de
localizar um documento não depende de quantas LDs estão carregadas.

**4. A página não calcula.** Descompactação, varredura, indexação, gravação, auditoria e
recompactação acontecem em Web Workers. A interface só reage a eventos.

## 2. Camadas

```
┌──────────────────────────────────────────────────────────────┐
│  src/ui/app.js          única camada com acesso ao DOM        │
├──────────────────────────────────────────────────────────────┤
│  src/core/engine.js     orquestração, métricas, cancelamento  │
├──────────────────────────────────────────────────────────────┤
│  src/workers/pool.js    escalonamento, afinidade, contingência│
├──────────────────────────────────────────────────────────────┤
│  src/core/tasks.js      contrato de tarefas (página ↔ worker) │
├──────────────────────────────────────────────────────────────┤
│  indexer · analyzer · applier · audit · packager              │
├──────────────────────────────────────────────────────────────┤
│  xlsx (offsets)  ·  headers  ·  dates  ·  util                │
└──────────────────────────────────────────────────────────────┘
```

Os módulos de `src/core/` são scripts clássicos que se anexam a `self` e **não tocam no DOM**.
O mesmo arquivo é carregado pela página (`<script>`), pelo worker (`importScripts`) e pelo Node
(testes). Não há bundler, transpilador nem duplicação de código.

## 3. Estrutura de diretórios

```
index.html · styles.css          interface
lib/jszip.min.js                 única dependência de terceiros
src/core/                        núcleo sem DOM
src/workers/                     worker e pool
src/ui/app.js                    camada de apresentação
tests/                           suíte funcional + teste de volume
docs/                            documentação técnica
```

## 4. Modelagem dos índices

### 4.1 Índice da Relação GRCON

```
relationIndex = {
  rows:       [ { document, rawDocument, row, grdt,
                  sourceDateRaw, dateIso, dateText, dateValid } ],
  selected:   Map<documento, linhaVencedora>,
  duplicates: [ { document, count, selectedRow, conflict, candidates[] } ],
  invalidDates: [ ... ]
}
```

`selected` implementa a regra de duplicidade: vence a **última ocorrência física**, inclusive
quando ela tem data vazia. `duplicates[].conflict` sinaliza quando as ocorrências divergem entre
si — informação que vai para a aba *Duplicados* do relatório.

Datas trafegam como `dateIso` (`YYYY-MM-DD`) e `dateText` (`dd/mm/aaaa`), nunca como `Date`.
Isso mantém a estrutura clonável entre worker e página e torna a comparação independente do
sistema de datas (1900/1904) de cada arquivo.

### 4.2 Índice de LD e índice global

Cada LD produz uma lista plana:

```
entry = { fileId, document, rawDocument, row,
          beforeGrdt, beforeDate, beforeDateSerial,
          dateCellIsDate, grdtHasFormula, dateHasFormula }
```

A página une todas em um índice global:

```
globalIndex.byDocument : Map<documento, entry[]>
```

| Operação | v1 | v2 |
|---|---|---|
| Localizar 1 documento | `O(n)` por LD carregada | `O(1)` |
| Localizar N documentos | `O(N × n × arquivos)` | `O(N)` |

Medido em `tests/bench.js`: **0,28 µs por busca** com 20.000 documentos indexados.

`beforeDateSerial` e `dateCellIsDate` alimentam a **escrita inteligente** — a comparação entre
valor atual e novo valor é feita no índice, sem reabrir a planilha.

### 4.3 Chave canônica

`normalizeDocument` produz a chave do índice: espaços colapsados, traços Unicode convertidos,
aspas removidas, extensão (`.pdf`, `.xlsx`, …) descartada, caixa alta. `doc-005.pdf` e `DOC-005`
convergem para a mesma chave.

## 5. Cache

O cache vive **dentro do worker**, junto do ZIP já descompactado.

| Nível | Chave | Invalidação |
|---|---|---|
| Pasta de trabalho aberta | `SHA-256(conteúdo) + nome + perfil` | conteúdo diferente ⇒ hash diferente ⇒ reabertura automática |
| Índice calculado | assinatura do mapeamento (`aba + cabeçalho + 3 colunas`) | mudar qualquer coluna invalida só aquele índice |

Trocar um arquivo por outro de mesmo nome muda o hash e reabre. Recarregar o mesmo arquivo
reaproveita tudo. Reindexação com cache quente medida em **~0 ms contra 882 ms a frio**.

## 6. Estratégia de paralelismo

**Afinidade por arquivo.** Uma LD é aberta em um worker e permanece ligada a ele. Leitura,
indexação e gravação daquele arquivo reaproveitam o mesmo ZIP descompactado — nenhum
`postMessage` carrega planilha entre workers.

**Dimensionamento.** `min(hardwareConcurrency, 8)`, mínimo 2.

**Transferência sem cópia.** Os bytes do arquivo vão para o worker por `Transferable`
(`ArrayBuffer` transferido, não clonado); os bytes do XLSX gerado voltam da mesma forma.

**Contingência automática.** Se `new Worker()` falhar ou o handshake não responder em 4 s
(`file://`, CSP restritiva, navegador antigo), o pool cria uma *lane* que executa as mesmas
funções na página, cedendo o controle ao event loop entre tarefas. A API é idêntica: nenhuma
outra parte do sistema sabe em qual modo está rodando. O selo no topo da interface informa o modo.

**Cancelamento seguro.** `cancel()` esvazia a fila e rejeita o que ainda não começou; tarefas em
voo terminam sozinhas. Como nada é escrito no ZIP antes do commit, cancelar nunca deixa arquivo
parcial.

## 7. Estratégia de rollback

O rollback é **estrutural**, não compensatório:

```
1. snapshot   XML original da aba retido em memória, SHA-256 registrado
2. validação  cada célula-alvo inspecionada (fórmula, mesclagem, proteção, validação)
3. escrita    emendas acumuladas em uma lista — o ZIP não é tocado
4. auditoria  XML resultante comparado com o snapshot
5. commit     só então o ZIP recebe a nova versão da aba
```

Entre os passos 2 e 4 o pacote original está intacto. Qualquer falha — integridade reprovada,
emendas sobrepostas, exceção inesperada — descarta a lista de emendas e devolve
`{ ok: false, rolledBack: true }`. Não existe estado intermediário para reverter.

Bloqueios **não** abortam o arquivo: uma célula com fórmula, mesclada ou em linha inexistente é
registrada como ocorrência e pulada; os demais documentos daquela LD são gravados normalmente.

## 8. Estratégia de auditoria

### 8.1 Auditoria de integridade (automática, por arquivo)

Comparação em dois níveis entre o XML antes e depois:

1. **Esqueleto** — o XML sem nenhuma célula precisa ser idêntico. Cobre `sheetProtection`,
   `autoFilter`, `mergeCells`, `dataValidations`, `conditionalFormatting`, `cols`, `sheetPr`.
2. **Célula a célula** — dois iteradores avançam em paralelo comparando por referência. Qualquer
   célula alterada, criada ou removida fora do conjunto autorizado é violação.

Consumo de memória constante: os iteradores nunca materializam a planilha. Violação ⇒ o arquivo
não entra no pacote e a falha aparece no relatório.

### 8.2 Relatório de execução

`RELATORIO_AUDITORIA_VINCULA.xlsx`, oito abas:

| Aba | Conteúdo |
|---|---|
| Resumo | versão, modo, tempos por etapa, contagens, hash SHA-256 do pacote |
| Detalhamento | **todos** os documentos: arquivo, aba, linha, GRDT anterior/nova, data anterior/nova, status, marcadores, timestamp, motivo |
| Alterações | apenas o que mudou |
| Duplicados | ocorrências, linha vencedora, se há conflito, candidatos |
| Não Encontrados | documento, linha na relação, motivo |
| Datas Inválidas | valor de origem e data preservada na LD |
| Ocorrências | fórmulas, mesclagens, proteção e validações encontradas |
| Arquivos Gerados | tamanho, células autorizadas, gravações, integridade, SHA-256 por arquivo |

`LOG_VINCULA.json` traz a mesma informação em formato estruturado, e `MANIFESTO.txt` lista os
hashes com o comando de verificação (`certutil` / `shasum`).

Rastreabilidade é de 100% dos documentos processados — inclusive os que não geraram escrita.

## 9. Gerenciamento de memória

- O XML de uma aba é carregado sob demanda e **liberado ao fim de cada etapa** (`withModel`).
  Entre as etapas permanece só o ZIP comprimido e o índice.
- Só as colunas mapeadas entram no modelo de células.
- A amostra completa de cabeçalhos fica no worker; para a página vai um recorte
  (40 linhas × 80 colunas, teto de 1.500 células por aba).
- A decodificação de abas para em quando uma aba resolve os três campos — arquivos com muitas
  abas auxiliares não pagam por elas.
- `releaseAll` é transmitido a **todas** as lanes, já que cada worker tem seu próprio registro.

## 10. Escalabilidade

Medido em `tests/bench.js` (Node, **thread única, sem paralelismo** — limite superior pessimista;
no navegador o trabalho ainda se divide entre os workers):

| Cenário | Pipeline completo | Vazão |
|---|---|---|
| 100 LDs × 200 documentos | **7,5 s** | 2.651 doc/s |
| 5 LDs × 4.000 documentos | **7,0 s** | 2.849 doc/s |

Meta declarada: 20.000+ documentos em menos de 60 s. Margem de **8×**.
Integridade aprovada em 100/100 arquivos nos dois cenários.

O desempenho é estável nos dois extremos — muitos arquivos pequenos ou poucos arquivos grandes —
porque o custo acompanha o volume total de células, não a quantidade de arquivos.

## 11. Preparação para evolução

- **Novos layouts** — basta acrescentar grafias em `headers.js`; nada mais muda.
- **Novos tipos documentais** — a chave canônica está isolada em `normalizeDocument`.
- **Múltiplas relações** — `buildGlobalIndex` já recebe uma lista; o analisador aceita qualquer
  quantidade de índices de origem.
- **Novos conectores** — `tasks.js` é um contrato de mensagens; uma origem remota entra como
  novo tipo de tarefa sem tocar no núcleo.
- **Processamento distribuído** — a granularidade da unidade de trabalho (um arquivo) e o
  transporte por mensagem já são compatíveis com execução fora do navegador.

Ver [`ROADMAP.md`](ROADMAP.md).
