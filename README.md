# Equipe Gerador — DMA

App de campo para os checklists de inspeção e manutenção de **geradores, subestações e
bancos de capacitores** do Grupo DMA. É uma página web que funciona **offline** e pode ser
adicionada à tela de início do celular como se fosse um aplicativo.

## Publicar no GitHub Pages

1. Crie um repositório novo no GitHub (pode ser privado — o Pages exige plano pago para
   repositório privado; para uso aberto, deixe público).
2. Envie **todos** os arquivos desta pasta para a raiz do repositório.
3. No repositório: **Settings → Pages → Source: Deploy from a branch**, escolha a branch
   `main` e a pasta `/ (root)`. Salve.
4. Em um ou dois minutos o endereço aparece na mesma tela, no formato
   `https://SEU-USUARIO.github.io/NOME-DO-REPO/`.

> O app **precisa** ser aberto por `https://` (o GitHub Pages já entrega assim). Em
> `file://` a câmera, o GPS e o modo offline não funcionam.

## Instalar no celular

**Android (Chrome):** abra o endereço → menu ⋮ → *Adicionar à tela inicial*.
**iPhone (Safari):** abra o endereço → botão Compartilhar → *Adicionar à Tela de Início*.

Depois disso o ícone da DMA fica na tela inicial e o app abre em tela cheia, sem barra de
navegador. Na primeira abertura é preciso ter internet, para baixar as perguntas; a partir
daí funciona offline.

## Como funciona

- Cada visita é um **relatório independente**, com número próprio — a mesma loja pode
  receber quantas visitas forem necessárias, sem agrupar.
- **Técnico** e **loja** são escolhidos em listas suspensas (não é mais texto livre). Se a
  loja não estiver na lista, o botão **+ Nova loja** cadastra o código, nome e endereço na
  hora — fica salva neste aparelho e disponível nas próximas visitas.
- A **geolocalização é obrigatória e automática**: o app já sai buscando o GPS ao abrir a
  tela de nova visita, sem precisar tocar em nada, e só libera a escolha do checklist depois
  que a localização é obtida. Se falhar (permissão negada, sem sinal), mostra o motivo e um
  botão **Tentar novamente** — não dá para seguir sem ela.
- Os **dados técnicos do gerador** (fabricante, motor, alternador, USCA, potência, tensão,
  baterias) são perguntados **uma única vez por loja**, na primeira visita em que a loja
  ainda não tiver esse cadastro completo. Nas visitas seguintes esses dados aparecem prontos
  (não são perguntados de novo); se algo mudou no equipamento, o link **"Dados técnicos
  incorretos? Corrigir cadastro da loja"**, dentro do checklist, libera os campos para
  atualizar. Cada relatório continua trazendo os valores no seu próprio registro, mesmo
  quando eles vêm do cadastro da loja.
- As respostas e fotos ficam **no próprio celular** (IndexedDB). Nada se perde se o app
  fechar ou o celular ficar sem sinal.
- As fotos são reduzidas para no máximo 1600px e salvas em JPEG, para não encher a memória.
- No fim, **Gerar PDF** abre a tela de impressão do celular (escolha “Salvar como PDF”) e
  **Exportar dados** baixa um `.json` com as respostas, pronto para alimentar planilha.

## Alterar as perguntas

Todas as perguntas ficam em **`checklists.json`** — não é preciso mexer no código.
Cada item aceita:

| Campo | Para que serve |
|---|---|
| `id` | identificador único do item (não repita dentro do mesmo checklist) |
| `secao` | agrupa os itens em blocos na tela |
| `pergunta` | o enunciado que o técnico lê |
| `tipo` | `opcoes`, `tristate`, `numero`, `texto`, `texto_amplo` ou `foto` |
| `opcoes` | lista de botões, para `opcoes` e `tristate` |
| `foto` | `{"sempre": true}` ou `{"quando": "Sim"}` (foto só naquela resposta) |
| `obs` | `true` mostra um campo de observação livre |
| `cond` | `{"id": "outro_item", "igual": "Sim"}` — só aparece se aquele item tiver essa resposta |
| `prioridade` | `Crítica`, `Alta` ou `Média` (aparece como etiqueta) |

As listas `tecnicos` e `lojas` (com código, nome, endereço e os dados técnicos já
conhecidos de cada gerador) ficam neste arquivo — **por decisão da DMA, ele é público**, ou
seja, qualquer pessoa com o link do app consegue ver esses dados. Se isso mudar no futuro,
mova `tecnicos`/`lojas`/`dadosTecnicosPorBloco` para fora do repositório público.

A seção `dadosTecnicosPorBloco` define, por bloco de equipamento (hoje só `"Gerador"`), quais
perguntas são "dado da loja" — pedidas uma vez só e reaproveitadas nas visitas seguintes —
em vez de aparecerem na lista `itens` de cada checklist.

Lojas cadastradas em campo pelo botão **+ Nova loja**, e correções feitas pelo link
"Corrigir cadastro da loja", ficam salvas **apenas no aparelho** de quem cadastrou
(localStorage) — elas não voltam sozinhas para este `checklists.json`. Para que todos os
técnicos passem a ver uma loja nova ou uma correção, adicione/edite manualmente aqui e
publique de novo.

**Depois de editar qualquer arquivo, abra `sw.js` e troque o número em
`const CACHE = 'equipe-gerador-v2'`** (v3, v4…). Sem isso os celulares que já instalaram o
app continuam abrindo a versão antiga guardada em cache.

## Regra de conformidade

O app marca um item como **não conforme** seguindo a mesma regra conferida contra os 33
relatórios em PDF já existentes: em perguntas de Sim/Não com prioridade, o “Não” é a não
conformidade — exceto em *“Existe vestígio de insetos…”* e *“possui vazamentos…”*, onde é o
“Sim”. Itens de medição (nível de combustível, corrente) e dados técnicos são informativos.

## Arquivos

| Arquivo | O que é |
|---|---|
| `index.html` | estrutura e estilo da tela |
| `app.js` | toda a lógica do app |
| `checklists.json` | **as perguntas** — edite aqui |
| `sw.js` | faz o app abrir sem internet |
| `manifest.webmanifest` | nome e ícones do app instalado |
| `logo.png`, `icon-192.png`, `icon-512.png` | identidade visual |
