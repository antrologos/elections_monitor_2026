# Monitor eleitoral 2026

Coletor público e independente de navegador para o segundo turno presidencial de 2026. Consulta a cada aproximadamente 60 segundos os dados oficiais do TSE para Brasil, 26 estados, Distrito Federal e Exterior, além do documento público integral do PET Apura. São 30 fontes principais. Os índices oficiais EA15 das 28 abrangências estaduais e Exterior identificam municípios atualizados; o coletor baixa incrementalmente seus resultados EA20, conservando uma fila entre ciclos. Municípios ainda não baixados aparecem como pendentes, sem cobertura fictícia.

**Estado operacional: coleta desligada desde 27/10/2026.** Não existe agendamento cron ativo. Alterações no código executam somente testes. Os snapshots públicos são históricos; sua presença não indica uma execução ativa. O coletor não executa os modelos Rodrigo ou Histórico e Espacial: preserva dados oficiais e a projeção publicada pelo PET.

## Operação e limites

O branch `main` contém código e testes; `data`, snapshots versionados. Cada publicação envia um commit completo, sem sobrescrever o histórico. A coleta continua explicitamente desabilitada no workflow.

A execução manual do programa faz **um ciclo**, com limite total padrão de 90 segundos. Cada consulta é cancelada em até oito segundos; cada operação Git, em até 15 segundos. O ciclo tem limite de 75 segundos e a etapa municipal, 25 segundos. Falhas de publicação preservam mensagem original e código de saída; há no máximo três tentativas, compartilhando o prazo total. Cancelamento ou timeout interrompem o grupo de processos Git. O workflow também dispõe de limites externos de 100 segundos para o programa e cinco minutos para todo o job.

```sh
node --test collector.test.mjs municipal.test.mjs process.test.mjs
node collector.mjs --data-dir /caminho/worktree-data --once --wall-timeout-seconds 90
```

O segundo comando coleta dados quando executado por um operador, mas não publica. `--publish` autoriza o push. Para experimentos curtos, `--duration-minutes` aceita no máximo cinco minutos e exige ajustar explicitamente `--wall-timeout-seconds` (máximo 360). Não há loop indefinido nem execução de 330 minutos.

`.runtime/status.json` é atualizado atomicamente; `.runtime/events.jsonl` preserva eventos. São registrados início, fase, heartbeat a cada cinco segundos, tentativas Git, erro e estado terminal (`succeeded`, `failed`, `timed_out` ou `stopped`). A falha retém `failedPhase`. Esses arquivos são locais e não contêm os tokens Git; os eventos também aparecem no log do job. Um heartbeat local não prova publicação bem-sucedida. O resumo do GitHub Actions registra o estado terminal mesmo em falha; cancelamentos externos abruptos podem deixar o último evento como `running`, devendo ser confrontado com o estado do job.

O critério de apuração concluída continua exigindo seções nacionais totalmente totalizadas, estabilidade por 30 minutos, consultas principais bem-sucedidas e fila municipal atualizada. A execução finita não certifica esse critério por si só e não reativa o monitoramento. Respostas 403/429 suspendem novas consultas ao TSE por dez minutos. Nada neste mecanismo executa ou cancela sessões internas do ChatGPT.

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

Cada consulta tem timeout de oito segundos e no máximo duas tentativas, com até oito consultas simultâneas. Respostas HTTP 403 ou 429 do TSE suspendem novas consultas ao TSE por dez minutos, com esse estado preservado entre jobs, para não prolongar eventual bloqueio; PET continua sendo consultado. A publicação no branch `data` usa o `GITHUB_TOKEN` temporário nativo do GitHub Actions; não requer credenciais extras. Nenhum token aparece no código, snapshots ou URL pública. Somente o job de coleta, que permanece desabilitado, tem permissão `contents: write`; o job de testes tem leitura, inclusive em pull requests. O checkout é fixado em SHA.

A etapa municipal limita a oito consultas simultâneas, vinte inícios de consulta por segundo, até 600 municípios por ciclo e 25 segundos para iniciar novas consultas. Requisições em curso compartilham o prazo municipal; os horários reservados nunca são comprimidos para caber no prazo. Documentos municipais só substituem a versão anterior quando eleição, abrangência, seções e horário coincidem com a atualização indicada pelo índice. O limite de 30 fontes do heartbeat refere-se às fontes principais; a cobertura municipal é informada separadamente.

Testes offline: `node --test collector.test.mjs municipal.test.mjs`. Consulta local única sem publicação: `node collector.mjs --data-dir ./local-snapshots --once`.

## Fontes e créditos

- TSE: `https://resultados.tse.jus.br/oficial/ele2026/6258/dados/`.
- PET Apura, Manoel Galdino e colaboradores: https://petapura.eleicoes-pet.workers.dev/ e https://github.com/mgaldino/petapura.
- Limites GitHub Actions: https://docs.github.com/en/actions/reference/limits.
- Agendamento: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule.

Este repositório registra e disponibiliza fontes públicas. Não é serviço oficial do TSE e não demonstra execução independente dos três modelos comparados no painel.

