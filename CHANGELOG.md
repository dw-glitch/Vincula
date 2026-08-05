# Changelog

## 2.0.5

Remove o painel de apresentação (título, texto explicativo e selos de garantia) da tela
inicial — quem usa o Vincula já sabe para que ele serve. O espaço liberado foi usado para
redesenhar a navegação de etapas.

- Painel "Fluxo seguro e auditável" removido por completo: sem título, sem parágrafo
  explicativo, sem os três selos de garantia (essas garantias já ficam explícitas nos
  próprios pontos de confirmação, na Etapa 2 e na Etapa 3).
- Navegação de etapas redesenhada: de botões em pílula para um indicador conectado por
  linhas, com marcador numerado, destaque para a etapa atual e ícone de confirmação nas
  etapas concluídas — mais compacto e com mais definição visual.
- O app agora abre direto na tarefa: topo → navegação de etapas → conteúdo, sem bloco
  intermediário.
- Selo de privacidade no topo passa a aparecer também em telas pequenas (antes só aparecia
  em telas largas), já que virou o único lugar onde essa informação existe.

Testes: 161/161, sem alteração (mudança é só de interface).

## 2.0.4

Limpeza de linguagem na interface: menos jargão técnico, menos informação que só um
desenvolvedor usaria no dia a dia. Nenhuma mudança de comportamento ou de motor.

- Removido o hash SHA-256 da lista de arquivos e da tela de conclusão — continua no
  relatório e no log exportável, para quem precisar dele, mas não polui a tela principal.
- Selo "X workers paralelos" removido do topo. Só existe selo quando algo realmente diferente
  está acontecendo (modo alternativo, mais lento) — no caso normal, nada aparece.
- Texto de apresentação simplificado: sem "índice de acesso direto" nem outros termos de
  implementação; "navegador"/"servidor" viraram "seu computador" em todo o app.
- Painel de diagnóstico reescrito em linguagem direta: "chave normalizada" virou
  "forma comparada"; título mudou para "Por que um documento não foi encontrado?".
- Opção de correspondência flexível reescrita sem exemplos em formato de código.
- Selos de "confiança da detecção" (alta/média/baixa) viraram frases diretas: "Colunas
  identificadas" / "Confira as colunas" / "Revise as colunas".
- Barras de progresso renomeadas: "Indexação" → "Preparação", "Compactação ZIP" → "Finalização".
- Resumo da Etapa 4 e de cada arquivo gerado reescrito com números que importam ao usuário
  (documentos alterados, GRDT e datas atualizadas) no lugar de contagem de células e status de
  integridade que já é implícito por aquele arquivo estar na lista.

## 2.0.3

Correspondência flexível (opcional) e uma correção de integridade de arquivo.

### Novo: correspondência flexível

- A comparação padrão continua exigindo igualdade exata da chave normalizada — essa garantia não
  muda. Mas a causa mais comum de "documento não encontrado" em uso real é zero à esquerda,
  espaço interno ou pontuação diferente entre a Relação e a LD (ex.: `"0091"` vs `"91"`, ou
  Excel removendo silenciosamente zeros à esquerda de uma célula numérica). Agora existe uma
  opção — desligada por padrão, na Etapa 2 — que tenta de novo por uma "chave frouxa" quando a
  exata falha.
- A chave frouxa remove zero à esquerda **por segmento** (respeitando onde estavam os hífens/
  espaços originais antes de juntar tudo), não no texto inteiro colado — isso evita que
  `"007-042"` e `"70-42"` colidam por acidente só porque, juntos, um vira prefixo do outro.
- Quando a chave frouxa aponta para **mais de um** documento diferente na LD, o sistema não
  escolhe: mantém como não encontrado e explica a ambiguidade no motivo, para nunca gravar no
  documento errado silenciosamente.
- Toda correspondência resolvida assim recebe o marcador "Correspondência aproximada — confira",
  filtrável na Etapa 3, com o texto original dos dois lados no motivo para conferência antes de
  gerar.
- `src/core/headers.js`/`tasks.js`: aviso de cabeçalho não reconhecido também revisado.

### Correção de integridade

- `src/core/indexer.js` continha um byte nulo (`\x00`) isolado dentro de um literal de template,
  resquício de uma edição anterior — fazia o Git tratar o arquivo como binário nos diffs. Sem
  efeito funcional (era usado só como separador interno em uma verificação de duplicidade), mas
  corrigido para um espaço, como sempre foi a intenção.

Testes: 161/161 (18 novos, cobrindo a chave frouxa isoladamente e a correspondência flexível de
ponta a ponta — incluindo o caso ambíguo, verificado também via geração real do arquivo final).

## 2.0.2

Correção de correspondência de documentos e blindagem do modo sem Web Worker.

### Correção

- **A Relação GRCON nem sempre usa "DATA DA GERAÇÃO / POSTAGEM".** Alguns exports já rotulam
  essa coluna como "Data Efetiva de Emissão" — mesma coluna, nome diferente. O detector da
  relação reconhecia apenas a primeira grafia; a segunda era explicitamente rejeitada (regra de
  exclusão que existe para não confundir as duas colunas *dentro da LD*, mas que não deveria
  valer para a relação, cuja fonte de data pode ter qualquer um dos dois nomes). Corrigido em
  `src/core/headers.js` com um perfil de data específico para a relação, que aceita as duas
  grafias — testado inclusive com a data na primeira coluna da planilha, como no caso reportado.
- Isso pode ter sido a causa (ou parte dela) de relatos de "nenhum documento encontrado": quando
  a coluna de data da relação não era reconhecida, a etapa de mapeamento ficava incompleta e o
  restante da conferência não refletia o que o usuário esperava.

### Novo: diagnóstico de correspondência

- Quando a análise encontra poucos ou nenhum documento, a Etapa 3 agora abre automaticamente um
  painel comparando, lado a lado, uma amostra real de documentos da Relação e das LDs — o texto
  exatamente como está no arquivo e a chave normalizada usada para casar os dois lados. A causa
  mais comum de "não encontrado" (prefixo, sufixo, zero à esquerda, espaço, extensão diferente)
  fica visível em segundos, sem precisar investigar o arquivo inteiro. O painel também fica
  disponível sob demanda (recolhido) quando a maioria dos documentos é encontrada normalmente.

### Validado: ambiente sem Web Workers

- Muitas redes corporativas bloqueiam o script do worker no proxy/firewall — cenário diferente de
  "o navegador não suporta Worker". Testado especificamente esse caso (requisição do arquivo do
  worker abortada, API `Worker` presente): o sistema detecta a falha e cai para o modo de
  contingência em menos de 1 segundo, e o fluxo completo (leitura, mapeamento, análise, geração)
  funciona normalmente, sem erros de console.

## 2.0.1

Identidade visual e refinamento de UX/UI, sem mudanças no motor de processamento.

### Identidade visual

- Nova marca (`assets/logo-mark.svg`): duas hastes que se ligam em um pino, representando o
  próprio conceito de "vincular" dois registros (GRCON e LD) em um ponto exato — substitui o
  antigo "V" genérico em caixa branca.
- Lockup horizontal (`assets/logo-full.svg`) para uso em documentação, com variante clara e escura.
- Favicon e marca da topbar atualizados para a nova marca.

### UX/UI

- **Faixa de confiança do topo reformulada.** Os contadores "0 alterações fora do escopo" e
  "0 arquivos enviados" liam-se como algo já quebrado antes de qualquer ação do usuário. Viraram
  três afirmações sempre verdadeiras com ícone (restrição de campos, auditoria célula a célula,
  processamento local) — nunca mais parecem um estado vazio ou uma falha.
- **Coluna "Motivo" da conferência, redesenhada para escala.** Em milhares de linhas, o texto
  repetia "Relação: ocorrência única, linha X. LD: arquivo · aba · linha Y." em toda correspondência
  direta, sem valor de leitura. Agora só aparece texto quando há algo que exige atenção (duplicidade,
  data inválida, GRDT ausente, bloqueio); o caso comum mostra um traço neutro. O texto completo
  permanece disponível em qualquer linha ao passar o mouse.
- **Navegação de etapas agora reflete o que é alcançável.** Os botões "Colunas", "Conferência" e
  "Downloads" ficam visivelmente desabilitados até que o pré-requisito de cada um exista, em vez de
  parecerem igualmente clicáveis desde o carregamento da página.
- Ícones nas zonas de arquivo (documento único para a Relação, pilha de documentos para as LDs),
  no lugar dos glifos genéricos "1" e "+".
- Selo de conclusão da etapa 4 ganhou um ícone de verificação (ou de alerta, quando há pendências),
  reforçando o resultado antes mesmo da leitura do texto.
- Indicação sutil de rolagem na navegação de etapas em telas estreitas.

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
