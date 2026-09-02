# Vincula 2.0 — Plano de testes

## Como executar

```bash
node tests/run.js            # suíte funcional e de integridade — 262 verificações
node tests/bench.js          # volume: 100 LDs × (200 documentos + aba de CV) = 21.000
node tests/bench.js 5 4000   # volume: 5 LDs × (4.000 documentos + aba de CV)
```

Sem dependências externas e sem instalação: `tests/harness.js` carrega os módulos de
`src/core/` em um contexto `vm` do Node com `self` apontando para o sandbox — exatamente o
mesmo formato consumido pelo Web Worker. O código testado é o código de produção, não uma cópia.

## Fixtures

As fixtures da suíte incluem uma LD com três abas — documentos, CV (currículos) e um resumo que
não pode ser tocado — além dos arquivos de aba única usados nos demais cenários.

`tests/fixtures.js` gera planilhas XLSX reais contendo tudo que o Vincula precisa preservar:
`sharedStrings`, fórmulas com resultado em cache, células mescladas, proteção de aba, validação
de dados em lista, formatação condicional, autofiltro, larguras de coluna customizadas, formato
numérico personalizado, `docProps` e uma segunda aba. Se qualquer um desses recursos for perdido
na gravação, a suíte acusa.

## Cobertura

### Detecção inteligente de cabeçalhos — 17 verificações
- As cinco grafias exigidas de *Data Efetiva de Emissão*, incluindo variação com espaçamento e hífens.
- `GRDT`, `eGRDT`, `E GRDT`.
- `DOCUMENTO`, `Código Documento`, `Código do Documento`.
- `DATA DA GERAÇÃO / POSTAGEM`, `DATA DA POSTAGEM`, `Data da Geração`.
- **Não confusão:** `DATA DA POSTAGEM` nunca casa com *Data Efetiva*; `Tipo de Documento` nunca
  casa com *Documento*.
- Cabeçalho localizado sozinho na **linha 3**, sob título e linha em branco.

### Datas — 30 verificações
- `04/08/2026 08:31:45` → `04/08/2026`, sem resíduo de hora/minuto/segundo/milissegundo.
- Serial fracionário truncado no domínio numérico.
- Ida e volta serial ↔ data preserva o dia.
- Inválidos rejeitados: `-`, vazio, só espaços, `null`, `undefined`, `data inválida`,
  traço Unicode, `N/A`, `#N/D`.
- Data impossível (`31/02/2026`) rejeitada em vez de rolar para março.

### Abertura, mapeamento e cache — 12 verificações
- Aba, linha de cabeçalho e as três colunas detectadas na relação e na LD.
- Aba de dados escolhida entre múltiplas abas.
- Mesmo hash + mesmo nome reaproveita a indexação; hash diferente invalida o cache.

### Índices e duplicidade — 13 verificações
- Contagem de linhas úteis e documentos únicos.
- Duplicado na relação: **vence a última ocorrência física**, com a GRDT correta.
- Sufixo `.pdf` e caixa baixa normalizados para a mesma chave.
- Data de célula real com fração truncada corretamente.
- Índice global: documento presente em duas LDs devolve duas ocorrências.

### Análise — 19 verificações
- Documento ausente → `NÃO ENCONTRADO`, motivo *"Documento pertence a outra LD"*.
- Data inválida → data **não** alterada, GRDT **sim**, marcador `DATA_INVALIDA`.
- GRDT vazia na relação → GRDT preservada, data atualizada, marcador `GRDT_AUSENTE`.
- Data como texto → convertida em data real, marcador `DATA_TEXTO`.
- Documento fora da relação não gera registro.
- Documento em duas LDs gera um registro por LD.

### Gravação, integridade e preservação — 36 verificações
- Auditoria de integridade aprovada, com a planilha inteira comparada.
- GRDT e data gravadas corretamente; data é **numérica com estilo de data**, nunca texto.
- Coluna formatada com data+hora (`dd/mm/yyyy hh:mm:ss` ou o embutido 22) recebe formato de
  **data pura** na gravação — o Excel não exibe mais o `00:00:00` pendurado. Uma coluna que já
  estava em formato de data pura mantém o estilo original.
- Data inválida preserva a data original enquanto a GRDT é atualizada.
- Linha de documento fora da relação permanece intocada.
- Célula de GRDT com fórmula é **bloqueada**, a fórmula e seu cache sobrevivem, e a data da mesma
  linha é atualizada normalmente.
- Preservados no arquivo gerado: proteção de aba, autofiltro, mesclagem, validação de dados,
  formatação condicional, larguras de coluna, as 7 fórmulas da planilha.
- Segunda aba **idêntica byte a byte**.
- `sharedStrings.xml` e `docProps/core.xml` intactos.
- `styles.xml` apenas **acrescido**: o formato numérico personalizado original continua lá e o
  formato de data foi adicionado.

### Meta de integridade — 2 verificações
Varredura completa de **todas** as células do arquivo gerado contra o original, sem filtro de
coluna: nenhuma diferença fora do conjunto autorizado, contagem total de células preservada.

### Escrita inteligente — 3 verificações
Só as células necessárias são autorizadas; plano vazio não autoriza nenhuma.

### Rollback — 3 verificações
Linha inexistente é bloqueada e registrada como ocorrência sem erro fatal, e o arquivo
resultante permanece consistente.

### Auditoria — 9 verificações
Relatório cobre 100% dos registros com GRDT anterior/nova e timestamp; XLSX de 8 abas é
relegível pelo próprio leitor do Vincula; log JSON lista não encontrados e datas inválidas.

### Aba de CV (currículos) — 61 verificações
- Classificação de aba pelo nome: `CV`, `CVs`, `CV - Currículos`, `Currículos`, `CURRICULO`,
  `Curriculum Vitae` → papel `cv`; `Documentos` e `LD` → `documentos`; `Resumo` → indefinido.
- `CV` **não** é coluna de documento no perfil da aba de documentos e **é** no perfil da aba de
  CV — a separação que impede uma coluna auxiliar de concorrer com "DOCUMENTO".
- LD com aba `Documentos` + aba `CV` + aba `Resumo`: as duas primeiras viram alvos, a terceira
  não; a aba principal continua sendo a de documentos.
- Indexação por aba: cada ocorrência sabe de qual aba veio e quais campos aquela aba tem.
- Prévia: documento comum na aba de documentos, currículos na aba de CV; data inválida preserva
  a data do CV enquanto a GRDT é atualizada; a aba sem coluna de Revisão não promete Revisão;
  aba sem coluna de GRDT não altera GRDT e o motivo diz qual coluna falta.
- Gravação: **um único arquivo** com as duas abas atualizadas, integridade aprovada nas duas,
  data do CV gravada como data real do Excel, currículo fora da relação intocado e a aba
  `Resumo` **byte a byte idêntica**.
- Aba desmarcada: o arquivo ainda é gerado, só a aba de documentos é gravada, os itens da aba
  desmarcada ficam registrados como bloqueados e a aba de CV mantém os valores originais.

### Variações de export da Relação GRCON — 11 verificações
Relação que rotula a própria coluna de data como *Data Efetiva de Emissão* (em vez de
*geração/postagem*) é aceita sem aviso indevido, e a coluna de documento é encontrada mesmo na
primeira coluna da planilha.

### Correspondência flexível — 21 verificações
Chave frouxa (`looseDocumentKey`) ignora zero à esquerda, espaço e pontuação; resolve sozinha
quando há exatamente um candidato e mantém o documento como *não encontrado* quando a chave
aproximada aponta para mais de um — sem palpite silencioso.

### Revisão (coluna opcional) — 19 verificações
Detecção na relação e na LD, regra de duplicidade, preservação quando a relação vem vazia,
gravação e integridade com a terceira coluna autorizada.

### Pacote e memória — 6 verificações
Pacote contém LDs, relatório, log e manifesto; o hash da LD dentro do ZIP bate com o hash
gerado; os arquivos abertos são liberados.

## Teste de volume

`tests/bench.js` mede o caminho crítico completo e falha se ultrapassar 60 s.

Cada LD do cenário tem duas abas (documentos + CV), então o número medido já é o do caminho de
múltiplas abas.

| Cenário | Documentos | Abas gravadas | Pipeline | Vazão | Integridade |
|---|---|---|---|---|---|
| 100 LDs × (200 docs + 10 CVs) | 21.000 | 200 | 11,9 s | 1.768 doc/s | 100/100 |
| 5 LDs × (4.000 docs + 200 CVs) | 21.000 | 10 | 10,0 s | 2.095 doc/s | 5/5 |

Também reportados: tempo médio por busca no índice (0,40 µs), ganho do cache (>1.000×) e heap ao
final (~249 MB para 21.000 documentos, thread única com todos os arquivos abertos ao mesmo
tempo). Os tempos variam com a máquina; o script falha sozinho acima de 60 s.

## Teste de navegador

Validado com Chromium via Playwright, servindo a pasta por HTTP:

| Verificação | Resultado |
|---|---|
| Modo de processamento | 4 workers paralelos |
| Carga de 12 LDs + relação (1.801 documentos) | detecção *alta* em todos os 13 arquivos |
| Análise | 1.800 encontrados, 1 não encontrado, 72 datas inválidas |
| Filtros e busca | retornam a linha esperada |
| Geração | 12 LDs, 3.528 células gravadas, integridade aprovada |
| Pacote baixado | 785 KB, 15 arquivos, hashes conferem |
| Erros de console | nenhum |

O **modo de contingência** foi validado no mesmo cenário removendo `window.Worker` antes do
carregamento da página: o fluxo completa, a interface permanece responsiva e o selo do topo
indica o modo — sem erros de console.

Validação específica da aba de CV (2.1.0), com uma LD de três abas (documentos, CV, resumo):

| Verificação | Resultado |
|---|---|
| Lista de arquivos | `LD_001.xlsx · abas: Documentos, CV` |
| Etapa 2 | dois cartões, o segundo com o selo *CV (currículos)* e a coluna `A · CV` detectada |
| Prévia | documentos na aba *Documentos*, currículos na aba *CV*, com a linha de cada um |
| Geração | um arquivo, 4 GRDT + 3 datas + 1 revisão, integridade aprovada |
| Desmarcar a aba de CV | contagem cai para 1 aba e os currículos passam a *não encontrados* |
| *+ Adicionar aba desta LD* | inclui a aba `Resumo`; sem colunas, a análise é recusada com o motivo |
| Modo de contingência | mesmo resultado, sem erros de console |

## Roteiro de aceitação manual

Antes de liberar uma versão, com arquivos reais:

1. Carregar uma relação com preâmbulo acima do cabeçalho e conferir a detecção automática.
2. Trocar a aba no seletor e confirmar que a detecção é refeita para a nova aba.
3. Em uma LD com aba de CV (currículos), conferir que ela aparece como cartão adicional já
   marcado, desmarcá-la e confirmar que a prévia deixa de listar os currículos; marcá-la de novo
   e conferir que voltam.
4. Usar *+ Adicionar aba desta LD* em uma aba não proposta e conferir a detecção das colunas.
5. Usar *Replicar 1ª LD nas demais* com LDs de layout idêntico e conferir os cartões.
6. Filtrar por *Não encontrados* e por *Data inválida* e conferir contra a relação de origem.
7. Buscar por número de linha, por nome de arquivo e por nome de aba.
8. Cancelar durante a atualização e confirmar que nenhum arquivo parcial é oferecido.
9. Abrir uma LD gerada no Excel e verificar:
   - a Data Efetiva de Emissão aceita `=A1+1` e filtros de data (é data real, não texto);
   - fórmulas, filtros, validações e formatação condicional continuam funcionando;
   - nas abas marcadas, nenhuma coluna além de GRDT, Data e (quando mapeada) Revisão mudou;
   - as abas não marcadas continuam exatamente como estavam.
10. Conferir o SHA-256 do pacote com `certutil -hashfile ... SHA256`.
