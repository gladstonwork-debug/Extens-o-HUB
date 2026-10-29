# HubSpot Sinalizador — Melhorias da aba Atenção

Documento de uso das versões de teste 3.0.12 e 3.0.13  
Data: 29/10/2026

## Objetivo

A aba Atenção permite separar atendimentos que precisam de acompanhamento pessoal. As duas melhorias documentadas aqui simplificam a remoção dos favoritos e acrescentam uma agenda de próximos passos. Elas não alteram o status dos chamados no HubSpot.

## 1. Ajuste dos botões e remoção de favoritos — 3.0.12

### O que mudou

- O botão **Abrir** foi retirado dos cards da aba Atenção. O acesso ao atendimento continua pela lista normal do HubSpot.
- O botão **×** continua usando o fluxo de remoção dos favoritos: retira o atendimento da Atenção, desmarca sua estrela na lista e atualiza o contador.
- O painel preserva seus botões quando as informações exibidas não mudam, reduzindo a possibilidade de uma atualização periódica interromper o clique.

### Como usar

1. Marque a estrela de um atendimento em **Atribuído a mim**.
2. Abra a aba **Atenção**.
3. Para retirar um atendimento dessa lista, clique no **×** do card.
4. Para sair do painel sem remover favoritos, clique em **Todos**.

O **× não encerra o chamado**. Ele remove apenas o favorito local. Não foi incluído botão Desfazer.

## 2. Agenda pessoal de próximos passos — 3.0.13

### O que mudou

Cada card da Atenção passou a oferecer **Editar acompanhamento**. O formulário permite registrar:

| Campo | Finalidade | Exemplo |
| --- | --- | --- |
| Aguardando | Identificar a pendência atual | Logs do cliente |
| Próxima ação | Registrar o que deve ser feito | Cobrar retorno |
| Data e hora | Definir um lembrete opcional | 30/10/2026 às 10h |
| Prioridade pessoal | Organizar a importância para o técnico | Baixa, Normal ou Alta |

A prioridade é pessoal: ela não modifica a prioridade registrada no HubSpot. O formulário limita Aguardando a 300 caracteres e Próxima ação a 500 caracteres.

### Como cadastrar ou editar

1. Marque o atendimento em Atenção.
2. Abra o painel e clique em **Editar acompanhamento** no card desejado.
3. Preencha os campos necessários. A data e a hora são opcionais.
4. Clique em **Salvar acompanhamento**.

O card passa a apresentar as informações salvas. **Cancelar** ou a tecla **Escape** fecha o formulário sem salvar a edição. As atualizações periódicas do painel não apagam o texto que está sendo digitado no formulário.

### Exemplo do card

```text
Chamado #12345 — Falha na integração        ×
Cliente / contato

Prioridade: Alta
Aguardando: Logs do cliente
Próxima ação: Cobrar retorno
30/10/2026 às 10h

[Editar acompanhamento] [Concluir ação]
```

### Lembretes e ordenação

- Os acompanhamentos ativos com data aparecem primeiro, da data mais antiga para a mais recente. Assim, os vencidos ficam antes dos futuros.
- Um lembrete ativo cuja data já passou recebe uma borda vermelha e o texto **Vencido**.
- Itens sem lembrete ativo ficam depois, em ordem de inclusão em Atenção.
- A prioridade é exibida no card, mas não determina a ordenação.
- O horário segue o fuso local do computador.
- Os avisos são visuais no painel. Não há notificações de sistema, alarmes ou avisos com o HubSpot fechado.

### Concluir uma ação

O botão **Concluir ação** aparece quando existe uma próxima ação ou uma data e o acompanhamento ainda não foi concluído.

Ao clicar:

- O card exibe **Ação concluída**.
- O lembrete deixa de ser tratado como ativo ou vencido.
- O atendimento continua favorito em Atenção.
- Os campos permanecem disponíveis para consulta e edição.

Para iniciar outro acompanhamento nesse atendimento, use **Editar acompanhamento** e salve os novos dados. Salvar reativa a ação, inclusive quando se edita uma ação anteriormente concluída.

### Remover um atendimento

O **×** remove o favorito e seu acompanhamento pessoal. Ele não conclui nem exclui o chamado do HubSpot. Ao marcar o mesmo atendimento novamente, os dados pessoais removidos não são restaurados.

## Armazenamento e privacidade

Os favoritos e acompanhamentos são guardados no armazenamento local da extensão, no perfil do navegador. Permanecem após fechar e abrir o navegador, desde que esse armazenamento seja preservado.

- Não são enviados ao cliente, ao Jira ou aos registros do HubSpot.
- Não são sincronizados automaticamente com outro computador ou perfil.
- Não são compartilhados com os outros técnicos.
- Não existe exportação ou backup da agenda nesta versão.
- Desinstalar a extensão ou limpar seus dados pode apagar os registros.
- Quem utiliza o mesmo perfil do navegador pode ter acesso aos dados locais; evite registrar senhas ou outras credenciais.

## Instalação e atualização

A versão **3.0.13 já inclui o ajuste da 3.0.12**. Para avaliar as duas melhorias, utilize o ZIP 3.0.13 disponível na pasta `downloads` do repositório.

1. Baixe e extraia `HubSpot-Sinalizador-3.0.13-TESTE-Agenda.zip`.
2. Substitua os arquivos na pasta da extensão já instalada pelos arquivos extraídos.
3. Acesse `chrome://extensions` e clique em **Recarregar** na extensão.
4. Atualize a página do HubSpot.
5. Abra **Atribuído a mim → Atenção** e confira os acompanhamentos.

Atualize a instalação existente, sem desinstalá-la. Carregar outra pasta como uma extensão separada pode criar outra instalação e não reutilizar os favoritos. A versão 3.0.13 aceita os favoritos anteriores sem exigir preenchimento dos novos campos.

## Validação e limites

Foram executadas verificações de sintaxe JavaScript e testes em Chromium com uma página simulada e APIs de armazenamento Chrome simuladas. Os testes cobriram:

- Ausência do botão Abrir.
- Remoção pelo × durante uma atualização periódica.
- Atualização da estrela, do contador e do armazenamento.
- Cadastro e edição dos campos da agenda.
- Preservação do formulário durante atualizações.
- Cancelamento sem salvar.
- Exibição de vencimento e ordenação por data.
- Conclusão da ação mantendo o favorito.

A integração completa ainda depende de avaliação em uma sessão real autenticada do HubSpot. O navegador do ambiente de desenvolvimento bloqueia administrativamente a instalação de extensões locais, por isso os testes automatizados usaram uma página simulada.

As alterações funcionais ficaram concentradas na aba Atenção. Os módulos de cores, sirene de primeira resposta, aviso de atribuição, velocidade de áudio, transcrição e resumo histórico foram preservados.

## Fora do escopo destas versões

Não foram incluídos filtros, adiamento rápido de lembretes, contador de vencidos, sincronização, backup, integração com Jira, macros ou respostas por IA. Esses recursos não fazem parte das duas melhorias aqui documentadas.
