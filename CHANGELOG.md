# Changelog

## 2.0.0

Reescrita completa do motor. O comportamento visível permanece o mesmo fluxo de quatro etapas,
mas as fundações mudaram para sustentar 100+ LDs e 20.000+ documentos.

### Correções

- **A aplicação estava quebrada em produção**: o `index.html` carregava `lib/jszip.min.js`,
  mas o arquivo estava na raiz do projeto. Nenhuma planilha era lida. O arquivo foi movido para
  `lib/` e o carregamento validado em navegador real.
- Data gravada em célula sem formato de data aparecia como número serial (`46237`) em vez da
  data. Agora o Vincula garante um estilo com formato de data, clonando o estilo original da
  célula para preservar fonte, preenchimento, bordas e alinhamento.
- Célula de destino contendo fórmula era sobrescrita, destruindo o cálculo. Agora é bloqueada e
  registrada como ocorrência.
- Datas armazenadas como texto na LD permaneciam como texto mesmo após a atualização.
  Agora são convertidas em data real do Excel.

### Desempenho

- **Leitura por offsets, sem DOM.** O XML da aba não vira mais `DOMDocument`; um scanner linear
  registra só os deslocamentos das linhas e das células das colunas mapeadas.
- **Índice de acesso direto.** Busca de documento passou de `O(n)` por LD para `O(1)` —
  0,28 µs por busca com 20.000 documentos indexados.
- **Carga sob demanda.** Antes, todas as abas de todos os arquivos eram decodificadas e ainda se
  mantinha um snapshot `Map<ref, JSON>` de cada célula. Agora só a aba mapeada é lida, só as três
  colunas entram no modelo, e o XML é liberado ao fim de cada etapa.
- **Cache por hash de conteúdo** com invalidação automática: reindexação com cache quente ficou
  ~880× mais rápida.
- **Processamento paralelo em Web Workers** com afinidade por arquivo e transferência de bytes
  sem cópia.
- **Escrita inteligente**: célula só é gravada quando o valor realmente muda.
- **Compressão diferenciada** por tipo de conteúdo no pacote final.

Resultado medido (`tests/bench.js`, thread única, sem paralelismo): **20.000 documentos em 7,5 s**
contra a meta de 60 s.

### Integridade

- **Gravação por emenda de intervalos.** Só o intervalo exato da célula autorizada é substituído;
  o restante do arquivo permanece byte a byte idêntico. Fórmulas, proteção, filtros, validações,
  comentários, mesclagens, formatação condicional e estilos sobrevivem por construção.
- **Auditoria de integridade em dois níveis**: comparação do esqueleto da aba (tudo que não é
  célula) e varredura casada célula a célula, com consumo de memória constante.
- **Rollback estrutural**: o ZIP só é tocado no commit, depois da auditoria. Não existe estado
  intermediário para reverter.
- Validação prévia de cada célula-alvo: fórmula, mesclagem, proteção de aba e validação de dados.

### Regras

- Situação e marcadores passaram a ser campos separados. Um documento duplicado *com data
  inválida* agora mostra as duas informações; antes o status único descartava uma delas.
- GRDT vazia na relação preserva a GRDT da LD e é sinalizada.
- Detecção de cabeçalhos reescrita: normalização de caixa, acentos, hífens e espaços, mais um
  segundo estágio por conjunto de tokens e regras de exclusão que impedem confundir
  *data de postagem* com *data efetiva*, ou *tipo de documento* com *código do documento*.
  A linha do cabeçalho é localizada mesmo sob título, logotipo ou linhas em branco.

### Auditoria

- Relatório passou de 4 para 8 abas, cobrindo 100% dos documentos processados — inclusive os que
  não geraram escrita — com GRDT anterior/nova, data anterior/nova, motivo e timestamp.
- Novas abas: *Datas Inválidas*, *Ocorrências* e *Arquivos Gerados* (com SHA-256 por arquivo).
- `MANIFESTO.txt` no pacote, com os hashes e o comando de verificação.

### Interface

- Quatro barras de progresso por etapa (Leitura, Indexação, Atualização, Compactação).
- Indicadores em tempo real: LD processadas, documentos processados, encontrados, alterados,
  células gravadas, velocidade em documentos/s e ETA dinâmica.
- Cancelamento com encerramento seguro.
- Cartões de mapeamento recolhíveis com selo de confiança da detecção — com muitas LDs, só os que
  exigem conferência humana abrem sozinhos.
- Ação *Replicar 1ª LD nas demais* para lotes de layout idêntico.
- Lista de arquivos carregados com tamanho e hash.
- Filtros por situação e marcador; busca por documento, GRDT, arquivo, aba e linha.
- Selo indicando o modo de processamento (workers paralelos ou contingência).

### Arquitetura

- Código reorganizado em `src/core`, `src/workers` e `src/ui`, substituindo os dois arquivos
  monolíticos minificados da v1.
- O núcleo não toca no DOM e roda sem alteração na página, no worker e no Node.
- Suíte de testes automatizada (132 verificações) e teste de volume, sem dependências externas.

---

## 1.0.4

- Nome oficial alterado para Vincula.
- Estrutura preparada para processamento incremental de múltiplas LDs.
- Contador de alterações passa a refletir somente células realmente modificadas.
- Tratamento de documentos ausentes não bloqueante.
- Preservação da data quando a coluna `DATA DA GERAÇÃO / POSTAGEM` estiver inválida.
