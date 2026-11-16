# Plano do jogo: "Ilhas" (nome provisório)

Jogo 2D pixel art com visual de anime, top-down. Cada participante recebe uma ilha inicial
num arquipélago compartilhado. Todos saem para coletar recursos, caçar, construir, evoluir a
ilha e o personagem. Na primeira versão, os outros participantes são bots (100 por padrão,
1000 como teste de estresse).

---

## 1. Pilares de design
1. **Aconchegante primeiro, competitivo depois.** Ritmo calmo, cores suaves, nada de punição pesada.
2. **O arquipélago está vivo.** Os bots fazem as mesmas coisas que o jogador e o mundo muda sem você.
3. **Progresso visível.** A ilha cresce na tela: casa → vila → fortaleza/torre mágica.
4. **Escolha com consequência.** A árvore de habilidades define o estilo: coletor, guerreiro, mago, construtor.

## 2. Loop principal
```
Explorar ilhas vizinhas → coletar/caçar → voltar → construir/craftar → subir de nível
  → liberar habilidade/magia → alcançar ilhas mais perigosas → ...
```
- **Ciclo dia/noite** (~10 min reais): de dia coleta; de noite monstros mais fortes e bônus de magia.
- **Temporada** (ex.: 30 dias de jogo): ranking final por nível da ilha, riqueza, conquistas.

## 3. Mundo
- Mapa em grade de tiles 16×16 px, gerado proceduralmente (ruído Perlin/Simplex + seed).
- Arquipélago com N ilhas iniciais pequenas (uma por participante) + ilhas neutras de recursos
  (floresta, mina, vulcão, ruínas mágicas) em anéis de dificuldade crescente.
- Travessia: ponte (barata, perto) → jangada → barco → teleporte mágico.
- Recursos renascem com o tempo (árvores voltam a crescer, minérios reaparecem).

## 4. Sistemas
| Sistema | Conteúdo da v1 |
|---|---|
| Recursos | madeira, pedra, fibra, minério, carne, couro, cristal de mana |
| Coleta | machado/picareta/foice, com tempo e durabilidade |
| Combate | ação em tempo real simples: ataque, esquiva, magia em área; inimigos com padrões |
| Criaturas | coelho, javali, slime, lobo, golem de pedra, espírito noturno, chefe por bioma |
| Construção | posicionar em grade na própria ilha: casa, baú, fogueira, bancada, forja, altar, muro, torre, fazenda |
| Nível da ilha | 1–10; cada nível exige construções e libera área/estruturas |
| Personagem | HP, mana, stamina, força, agilidade, inteligência, sorte |
| Árvore de habilidades | 4 ramos: **Sobrevivência**, **Combate**, **Arcano**, **Engenharia** (~10 nós cada) |
| Magia | fogo (dano), água (cura/regar), terra (escudo/minerar), vento (velocidade/travessia) |
| Inventário/craft | receitas desbloqueadas por nível e habilidade |
| Interação entre jogadores | comércio, alianças, invasão de ilha (opcional, ligar só depois) |

## 5. IA dos bots (o coração do projeto)
Para 100–1000 bots é preciso IA **barata e com cara de gente**. Proposta em camadas:

1. **Perfis (personalidade)** — pesos que mudam as decisões:
   - *Coletor* (prioriza recurso e construção), *Caçador* (combate, XP), *Mago* (cristais, Arcano),
     *Mercador* (troca), *Explorador* (ilhas distantes), *Agressor* (invasões, quando ligado).
   - Cada bot sorteia um perfil + variação aleatória → não ficam iguais.
2. **Decisão estratégica: Utility AI** (a cada ~5 s de jogo). Cada objetivo recebe uma nota:
   `nota = necessidade × peso_do_perfil × chance_de_sucesso / distância`
   Objetivos: coletar X, caçar, construir Y, subir habilidade, voltar para casa, fugir, negociar.
3. **Execução tática: máquina de estados / árvore de comportamento** curta por objetivo
   (ir até → agir → voltar → depositar).
4. **Caminho: A\*** em grade com cache de rotas + mapa de fluxo para destinos comuns.
5. **Planejador de construção**: lista de metas do nível da ilha; o bot escolhe a próxima
   que cabe nos recursos (estilo GOAP simplificado).
6. **Performance (LOD de IA):** bots fora da tela do jogador rodam em **simulação abstrata**
   (sem pathfinding passo a passo, só "levou 40 s, ganhou 12 madeira"). Bots perto da câmera
   rodam a simulação completa. É isso que viabiliza 1000 bots no navegador.
7. **Ajuste de dificuldade:** parâmetros de "erro humano" (demora para reagir, decisões
   subótimas) e um nível de habilidade por bot.

Métrica de sucesso: ao assistir o mundo em modo espectador, o progresso dos bots parece
plausível e variado (curvas de nível diferentes, ilhas com aparências diferentes).

## 6. Arte e som
- Pixel art 16×16 (tiles) e 32×32 (personagens), paleta pastel limitada (~32 cores), olhos
  grandes e proporções chibi para o tom de anime.
- Animações: andar (4 direções × 4 quadros), atacar, coletar, conjurar.
- Fase de protótipo: formas simples/placeholder. Depois: assets próprios (desenhar no
  Aseprite/LibreSprite) ou pacotes livres com licença CC0, sempre conferindo a licença.
- Música lo-fi/chiptune calma; efeitos curtos para coleta e magia.

## 7. Tecnologia
| Camada | Escolha | Por quê |
|---|---|---|
| Linguagem | TypeScript | tipagem ajuda um projeto grande |
| Motor | **Phaser 3** (ou Godot 4 se quiser desktop/mobile nativo) | 2D, pixel art, roda no navegador, fácil de compartilhar |
| Build | Vite | rápido, simples |
| Simulação | módulo separado da renderização (ECS leve) rodando em **Web Worker** | IA de 1000 bots não trava a tela |
| Mapa | Tiled (editor) + geração procedural | |
| Salvamento | localStorage/IndexedDB na v1; servidor depois | |
| Multiplayer (futuro) | servidor Node autoritativo + WebSocket (Colyseus) | a simulação separada já prepara isso |
| Testes | Vitest para regras e IA; simulações sem tela para balanceamento | |

Decisão-chave: **regras do jogo e IA não dependem do motor gráfico.** Assim dá para simular
uma temporada inteira com 1000 bots em segundos para balancear, e depois ligar multiplayer.

## 8. Estrutura de pastas proposta
```
jogo-ilha/
  src/
    sim/        # regras puras: mundo, recursos, combate, construção, tempo
    ai/         # perfis, utility AI, comportamentos, pathfinding, LOD
    render/     # cenas Phaser, sprites, câmera, UI
    data/       # JSON: itens, receitas, criaturas, árvore de habilidades
  tools/        # simulador headless para balanceamento
  tests/
```

## 9. Roteiro em fases
| Fase | Entrega | Critério de pronto |
|---|---|---|
| 0 – Fundação (1 sem) | Vite + Phaser + TS, mapa procedural visível, câmera, personagem andando | abre no navegador e anda pela ilha |
| 1 – Coleta e craft (1–2 sem) | árvores/pedras, inventário, 5 receitas, bancada | consegue craftar machado melhor |
| 2 – Construção e nível da ilha (1–2 sem) | posicionar estruturas, níveis 1–3 da ilha, salvar/carregar | ilha muda visualmente ao evoluir |
| 3 – Combate e criaturas (2 sem) | 4 criaturas, dia/noite, XP, morte/renascer | ciclo explorar→lutar→voltar funciona |
| 4 – Bots v1 (2 sem) | 10 bots com perfis + utility AI + A\* | bots coletam, constroem e sobem de nível sozinhos |
| 5 – Escala (1–2 sem) | Web Worker, LOD de IA, 100 → 1000 bots, modo espectador, ranking | 1000 bots a 60 fps em notebook comum |
| 6 – Habilidades e magia (2 sem) | 4 ramos da árvore, 4 elementos, bots usam a árvore | builds diferentes jogam de forma diferente |
| 7 – Arte e polimento (contínuo) | sprites finais, música, UI, tutorial | parece um jogo "bonitinho" de verdade |
| 8 – Futuro | comércio/alianças/invasões, multiplayer real, mobile | |

## 10. Riscos e como reduzir
- **Escopo grande** → cada fase entrega algo jogável; nada de construir tudo antes de testar.
- **Performance com 1000 bots** → simulação separada + LOD desde a fase 4, medir sempre.
- **Bots "burros" ou idênticos** → perfis com variação + simulador headless para observar.
- **Arte consome muito tempo** → placeholders até a fase 7; definir paleta e tamanho cedo.
- **Originalidade** → o jogo usa o gênero (sobrevivência em ilhas), com nomes, personagens
  e visual próprios, sem copiar a série do vídeo.

## 11. Decisões em aberto (para você escolher)
1. Navegador (Phaser) ou app nativo (Godot)? *Recomendo Phaser para começar.*
2. Combate em tempo real ou automático/por turnos? *Recomendo tempo real simples.*
3. Invasão entre ilhas ligada desde cedo ou só cooperativo/competitivo por ranking?
4. Nome do jogo e do mundo.
5. Quantos bots na versão inicial jogável: 100 é um bom ponto de partida.
