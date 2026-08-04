VINCULA — ATUALIZAÇÃO DE LD POR RELAÇÃO GRCON — v1.0.4

Abra index.html no Microsoft Edge ou publique toda a pasta no Vercel.

Fluxo:
1. Carregue uma Relação GRCON.
2. Carregue várias LDs.
3. Confirme aba, cabeçalho e colunas.
4. Analise todos os documentos e revise as pendências.
5. Revise a prévia.
6. Gere as cópias atualizadas e o relatório antes/depois.

Regras:
- Na Relação GRCON, a data é obtida exclusivamente da coluna “DATA DA GERAÇÃO / POSTAGEM”.
- O aplicativo não usa “-” ou valor inválido para substituir a Data Efetiva de Emissão. Quando a data de postagem estiver ausente ou inválida, a data existente na LD é preservada e a pendência é registrada.
- Duplicados na relação: vence a última ocorrência física, inclusive com data vazia.
- Documentos repetidos nas LDs: todas as ocorrências exatas são atualizadas.
- Documentos não encontrados nas LDs carregadas não bloqueiam a geração; ficam registrados como pendência e não são alterados.
- Só GRDT e DATA EFETIVA DE EMISSÃO podem mudar.
- XLSX e XLSM são suportados; originais não são sobrescritos.
- XLS binário e arquivos protegidos por senha não são suportados.
- Não usa servidor, banco, login, IA externa ou chave de API.
