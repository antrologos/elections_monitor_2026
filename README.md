# Monitor eleitoral 2026

Coletor público e independente de navegador para o segundo turno presidencial de 2026. Consulta a cada aproximadamente 60 segundos os dados oficiais do TSE para Brasil, 26 estados, Distrito Federal e Exterior, além do documento público integral do PET Apura. São 30 fontes principais. Os índices oficiais EA15 das 28 abrangências estaduais e Exterior identificam municípios atualizados; o coletor baixa incrementalmente seus resultados EA20, conservando uma fila entre ciclos. Municípios ainda não baixados aparecem como pendentes, sem cobertura fictícia.

O coletor funciona no GitHub Actions mesmo sem visitantes no painel. Não executa o modelo Rodrigo nem o Modelo Histórico e Espacial: preserva os resultados oficiais e a projeção que o próprio PET publica, com seus créditos e histórico integral.

## Operação

O branch `main` contém código e testes. O branch `data` contém somente os snapshots; cada ciclo é um commit, mantendo versões anteriores no histórico Git. A publicação é atômica no nível de commit: todos os documentos e o heartbeat chegam juntos. O painel pode ler os arquivos públicos desse branch.

O workflow começa em alterações de código, execução manual ou cron de cinco minutos. Um job permanece ativo por até 330 minutos, fazendo consultas a cada minuto. A concorrência serial impede dois coletores simultâneos; uma execução pendente assume após o término. O GitHub pode atrasar ou descartar agendamentos; não existe garantia de latência de um minuto. Timeout e falhas de origem podem alongar um ciclo.

A fase intensiva passa para monitoramento a cada cinco minutos quando o Brasil apresenta número positivo de seções, todas totalizadas, o resultado nacional fica inalterado por 30 minutos e as 30 fontes são consultadas com sucesso em todos os ciclos desse intervalo. Mudanças, falhas ou lacunas maiores que três minutos reiniciam a contagem durante essa fase. O estado é persistido; cada execução agendada posterior faz uma nova coleta. Se o resultado nacional mudar ou voltar a apresentar seções pendentes, a frequência de um minuto é retomada. A transição também exige que a fila municipal esteja atualizada. O monitoramento continua até desativação manual do workflow, acompanhando possíveis correções oficiais. Esse critério operacional não certifica que o PET terminou sua coleta.

## Arquivos publicados

- `data/tse/br.json`, `data/tse/ac.json`, ... `data/tse/zz.json`: documentos oficiais íntegros dentro de um envelope.
- `data/pet.json`: documento integral de `https://petapura.eleicoes-pet.workers.dev/data/latest.json`, incluindo todo o campo `history`, sem truncamento.
- `data/heartbeat.json`: eleição, horário do ciclo, número de fontes principais bem-sucedidas, falhas, link para o job, resumo municipal e estado de conclusão.
- `data/tse/{uf}{codigoTSE}.json`: documentos municipais no mesmo formato de envelope.
- `data/municipal-state.json`: fila incremental e horários de atualização municipal, para continuar entre jobs.

Cada envelope contém `body`, `checkedAt`, `lastAttemptAt`, `error`, `source` e `sourceUrl`. `checkedAt` avança somente depois de uma consulta e validação bem-sucedidas. Em falha, `body` e `checkedAt` anteriores são preservados e `lastAttemptAt` registra a nova tentativa. Esses horários descrevem a consulta: não substituem o horário de geração informado pelo TSE ou PET, que permanece dentro de `body`.

O heartbeat tem `schemaVersion: 1`, `collectionMode: "github-actions"`, `successfulSources`, `expectedSources: 30`, `errors` e `completion`. Se nenhuma fonte responder, `checkedAt` anterior é preservado; `lastAttemptAt` e os erros documentam a tentativa. Um heartbeat só se torna público depois do push bem-sucedido do commit que contém todos os snapshots.

## Validação e limites

Antes de aceitar o TSE, verificam-se eleição 6258, turno 2, caráter oficial, abrangência, cargo presidencial, contagens inteiras não negativas e seções totalizadas não superiores ao total. Antes de aceitar o PET, verificam-se eleição, turno, cargo, modo ao vivo, previsão percentual e horário. Isso não certifica o mérito estatístico do modelo do PET nem elimina atrasos na origem.

Cada consulta tem timeout de oito segundos e no máximo duas tentativas, com até oito consultas simultâneas. Respostas HTTP 403 ou 429 do TSE suspendem novas consultas ao TSE por dez minutos, com esse estado preservado entre jobs, para não prolongar eventual bloqueio; PET continua sendo consultado. A publicação no branch `data` usa o `GITHUB_TOKEN` temporário nativo do GitHub Actions; não requer credenciais extras. Nenhum token aparece no código, snapshots ou URL pública. O workflow tem permissão `contents: write`, não usa eventos de pull request e fixa a ação de checkout em SHA oficial.

A etapa municipal limita a oito consultas simultâneas, vinte inícios de consulta por segundo, até 600 municípios por ciclo e 25 segundos para iniciar novas consultas. Requisições já em curso podem usar até oito segundos adicionais. Documentos municipais só substituem a versão anterior quando eleição, abrangência, seções e horário coincidem com a atualização indicada pelo índice. O limite de 30 fontes do heartbeat refere-se às fontes principais; a cobertura municipal é informada separadamente.

Testes offline: `node --test collector.test.mjs municipal.test.mjs`. Consulta local única sem publicação: `node collector.mjs --data-dir ./local-snapshots --once`.

## Fontes e créditos

- TSE: `https://resultados.tse.jus.br/oficial/ele2026/6258/dados/`.
- PET Apura, Manoel Galdino e colaboradores: https://petapura.eleicoes-pet.workers.dev/ e https://github.com/mgaldino/petapura.
- Limites GitHub Actions: https://docs.github.com/en/actions/reference/limits.
- Agendamento: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule.

Este repositório registra e disponibiliza fontes públicas. Não é serviço oficial do TSE e não demonstra execução independente dos três modelos comparados no painel.
