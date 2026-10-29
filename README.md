# HubSpot Sinalizador 3.0.12 — TESTE

Ajuste isolado da aba Atenção: remove o botão Abrir e preserva os botões entre atualizações idênticas para não interromper o clique no ×. A remoção usa o fluxo existente de favoritos, persistência e contador. Sem lembretes ou alterações nas outras funcionalidades.

Para atualizar: substitua os arquivos da extensão, clique em Recarregar em chrome://extensions e atualize a página do HubSpot.

# HubSpot Sinalizador 3.0.11 — TESTE

Base: **3.0.10**, preservando todas as funcionalidades e regras anteriores.

## Alteração desta versão

Somente o posicionamento do módulo **Resumo histórico IA** foi ajustado.

- passa a priorizar a âncora específica do HubSpot:
  `data-test-id="composer-drag-resize-handle"`;
- o painel é inserido antes do bloco do composer ativo, ocupando espaço real no fluxo da interface;
- ao alternar entre **Chat** e **Observação**, a extensão detecta a reconstrução/troca do composer e reposiciona o mesmo card;
- o objetivo é impedir que o resumo fique sobre a área de escrita da Observação;
- se o seletor específico não estiver disponível, o comportamento anterior com `DragHandle` permanece como fallback;
- nenhuma regra de captura, conteúdo, velocidade ou visual do resumo foi alterada.

## Comportamento preservado

- resumo continua aparecendo somente quando o HubSpot possui histórico real;
- leitura rápida da 3.0.10 permanece;
- cor escura universal permanece;
- Minimizar/Expandir e Ver mais/Mostrar menos permanecem;
- controle ON/OFF permanece;
- cores dos tickets, sirene, toast, Aba Atenção, velocidade de áudio, transcrição, Dark Reader e diagnóstico não tiveram suas regras alteradas.
