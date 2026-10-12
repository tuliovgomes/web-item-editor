# OTEditor TS — editor web de assets do Open Tibia

Projeto **open source** (licença [MIT](./LICENSE)) que reimplementa, em **Node.js + TypeScript**, um editor de assets para o ecossistema Open Tibia. Ele roda localmente no navegador e trabalha com o conjunto **DAT + SPR + OTFI** do cliente.

É uma implementação independente: nenhum código ou recurso do OTEditor original foi copiado. Nenhum arquivo proprietário de cliente é distribuído com o projeto.

## O que ele faz

- Abre uma **pasta de projeto** (um único seletor) e lê `.dat`, `.spr` e `.otfi` automaticamente. O OTFI é opcional.
- Detecta o layout do SPR e a versão do cliente quando não há OTFI, ou quando o OTFI não corresponde ao DAT (com aviso).
- Navega por itens, outfits, efeitos e projéteis em uma grade de miniaturas, com animações, paginação e ir direto para uma página digitando o número.
- Edita propriedades e flags do DAT em um modal, criando e removendo registros.
- Navega, substitui, adiciona, importa e exporta sprites (PNG, ZIP, spritesheets; botão direito ou arrastar e soltar).
- **Seleção múltipla** de registros e **exportação `.obd`** (Object Builder Data v2), em arquivo único ou ZIP.
- **Importação `.obd`** arrastando e soltando os arquivos na janela (sempre cria um novo registro).
- Valida e compila o trio DAT + SPR + OTFI para download. Os arquivos originais nunca são sobrescritos.
- Inclui também um leitor/escritor de OTB e uma CLI.

Os detalhes dos formatos, limites e a compatibilidade estão em [`docs/`](./docs): [formatos](./docs/formats.md), [compatibilidade](./docs/compatibility.md), [arquitetura](./docs/architecture.md) e [desempenho](./docs/performance.md).

## Como executar (passo a passo)

Você só precisa de **Docker**. Node.js e npm não precisam estar instalados no computador.

1. **Instale o Docker** (Docker Engine ou Docker Desktop) e confirme que funciona:

   ```bash
   docker --version
   ```

2. **Clone o repositório** e entre na pasta:

   ```bash
   git clone https://github.com/tuliovgomes/web-item-editor.git
   cd web-item-editor
   ```

3. **Inicie o editor:**

   ```bash
   npm run dev
   ```

   O comando monta a imagem Docker e sobe o servidor. Ele usa `http://127.0.0.1:4173`; se a porta estiver ocupada, escolhe outra e a imprime. Para encerrar, pressione `Ctrl+C`.

   > Sem npm no host, use o equivalente direto em Docker:
   >
   > ```bash
   > docker build -t oteditor-ts .
   > docker run --rm -p 127.0.0.1:4173:4173 -e HOST=0.0.0.0 -e PORT=4173 oteditor-ts npm run start
   > ```

4. **Abra no navegador** o endereço exato impresso no terminal.

5. **Selecione a pasta do projeto**, a que contém o `.dat`, o `.spr` e, se houver, o `.otfi`, e clique em **Abrir pasta selecionada**. Deixe a versão do cliente em `0` para detecção automática, ou informe a versão exata se souber.

6. **Edite** e clique em **Validar e compilar** para baixar os arquivos gerados.

### Dicas

- O servidor guarda o projeto aberto **na memória**. Se ele reiniciar, recarregue a página e abra a pasta de novo.
- SPRs grandes ficam inteiros na memória. Um SPR de ~3 GB precisa de pelo menos 8 GB de memória para o Docker. O limite é de 4 GiB por arquivo.
- Cada reinício do `npm run dev` deixa um container novo. Se uma instância antiga estiver ocupando a porta, pare-a com `docker ps` e `docker stop <id>`.

## Uso

| Ação | Como |
| --- | --- |
| Abrir registro | Clique na miniatura |
| Selecionar vários registros | `Ctrl`/`⌘`+clique, `Shift`+clique (intervalo), `Ctrl+A`; `Esc` limpa |
| Exportar `.obd` | Botão direito no registro (1 arquivo, ou ZIP com vários) |
| Importar `.obd` | Arrastar e soltar os arquivos na janela |
| Exportar/importar sprites | Botão direito na grade de sprites; arrastar imagens/spritesheets |
| Ir para uma página | Digitar o número no campo do rodapé da lista |

### Limites do OBD

Só o OBD v2 (LZMA, pixels ARGB 32×32). O OBD v1 não é suportado. Há apenas um grupo de frames (outfits com vários grupos exportam o grupo 0, com aviso). Bones, `npcSaleData`, `changer` e `podium` não existem no formato e são descartados com aviso. A versão do cliente gravada é a inferida do projeto. Flags não suportadas pela versão do projeto são ignoradas com aviso na importação.

### Conjuntos problemáticos

- **Sem OTFI:** o layout do SPR (16/32 bits, RGB/RGBA) é detectado e as versões de DAT 1100, 1057, 1050, 1010, 960, 860, 780 e 772 são testadas até uma abrir por completo.
- **OTFI inconsistente com o SPR** (por exemplo `transparency: false` com pixels RGBA): o editor usa o formato real, mostra um aviso e corrige o OTFI na compilação.
- **OTFI inconsistente com o DAT** (por exemplo, OTFI de 10.57 com um DAT de 8.54): o editor tenta outras versões e informa qual usou.

## Desenvolvimento

Com Docker (não precisa de Node no host):

```bash
docker build -t oteditor-ts .
docker run --rm oteditor-ts npm run typecheck
docker run --rm oteditor-ts npm run lint
docker run --rm oteditor-ts npm test
docker run --rm oteditor-ts npm run build
```

Com Node.js 24 instalado:

```bash
npm ci
npm run dev:web     # servidor em desenvolvimento (tsx)
npm test
npm run typecheck
npm run lint
npm run build
```

### CLI (OTB)

```bash
docker run --rm -v "$PWD/data:/data" oteditor-ts npm run dev:cli -- inspect /data/items.otb
docker run --rm -v "$PWD/data:/data" oteditor-ts npm run dev:cli -- roundtrip /data/items.otb /data/items-copy.otb
docker run --rm -v "$PWD/data:/data" oteditor-ts npm run dev:cli -- set /data/items.otb /data/items-edited.otb 100 name "Example item"
```

A CLI recusa sobrescrever a entrada ou uma saída existente.

## Status e limitações

- Cobertura de versões de cliente e de flags do DAT ainda incompleta; flags desconhecidas não são preservadas nem editáveis.
- Sem histórico/desfazer, `items.xml`, OTBM, atualizador ou serviço de IA.
- O suporte a OTB não é anunciado como completo, pois não foi validado com corpora externos.

## Contribuindo

Contribuições são bem-vindas: abra uma issue ou um pull request. Antes de enviar, rode `typecheck`, `lint` e `test`. Não envie arquivos proprietários de clientes (`.dat`, `.spr`) como fixtures.

## Licença

[MIT](./LICENSE). O repositório original do OTEditor não possui arquivo de licença na raiz; este projeto não copia seu código nem seus recursos.
