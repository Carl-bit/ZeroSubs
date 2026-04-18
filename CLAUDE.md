# CLAUDE.md

> Token-efficient base. Override rule: user instructions always win.

---

## PROJECT CONTEXT

**Project:** ZeroSubs
**Stack:** React + Vite (web) | Expo Router (mobile) | Node.js/Express (API) | PostgreSQL + Prisma | Redis | Ollama (dev) / Claude API (prod) | BullMQ | Docker Compose | Cloudflare Tunnel
**Goal:** Plataforma de aprendizaje de idiomas adaptativa impulsada por IA, sin anuncios ni suscripciones agresivas, con gamificacion basada en cultura pop y dashboard de leaderboard por minijuego.
**Current phase:** MVP - setup inicial

### Structure
```
/zerosubs
  backend/
    src/
      routes/
      controllers/
      services/
        ai/           - AIService + OllamaProvider + ClaudeProvider
        exercise/     - generacion, cache, evaluacion de ejercicios
        file/         - parser PDF/SRT + chunking
        lookup/       - busqueda de palabras/frases + contexto cultura pop
        leaderboard/  - tablas de posicion por minijuego
        subtitle/     - SubtitleService + providers
          providers/  - PodnapisiProvider, SubDLProvider, OpenSubtitlesProvider
      workers/
        subtitle.worker.ts  - BullMQ: descarga SRT via 3 capas
        scheduler.ts        - cron nocturno: encola peliculas TMDB trending
      middleware/     - auth JWT, rate limit, validacion
      db/
    prisma/
      schema.prisma
  frontend/
    src/
      components/
      pages/
        landing/      - dashboard post-login
        study/        - modos de estudio formal
        games/        - dinamicas de gamificacion
        leaderboard/  - tablero filtrable por minijuego
      hooks/
      animations/
  mobile/
    app/              - Expo Router: (auth)/, (app)/(tabs)/
    components/
    hooks/
  shared/
    types/
  docker/
    compose.yml
    .env.example
  scripts/
    seed-subtitles.ts - encola top N peliculas TMDB para pre-poblar DB
```

### Key files
- `backend/src/services/ai/AIService.ts` - interfaz comun (Ollama / Claude API swap)
- `backend/src/services/subtitle/providers/` - PodnapisiProvider, SubDLProvider, OpenSubtitlesProvider
- `backend/src/workers/subtitle.worker.ts` - BullMQ worker multi-provider
- `backend/src/workers/scheduler.ts` - cron TMDB trending -> BullMQ queue
- `shared/types/exercise.ts` - contrato Exercise + LookupResult + LeaderboardEntry
- `docker/compose.yml` - todos los servicios incluyendo subtitle-worker y subgen

### Constraints
- 6GB VRAM homelab: modelos quantizados en Ollama (llama3.2:3b-q4 o qwen2.5:7b-q4_K_M)
- Claude API solo en produccion: desarrollo 100% Ollama local
- AIService usa interfaz comun: OllamaProvider y ClaudeProvider son intercambiables sin tocar logica
- Redis obligatorio: cache ejercicios TTL 24h, lookup TTL 7d, leaderboard sorted sets, BullMQ queues
- Pipeline de subtitulos: 3 capas (Podnapisi -> SubDL -> OpenSubtitles -> Whisper). SRT se guarda permanentemente en PostgreSQL (SubtitleCache). No se vuelve a pedir el mismo SRT jamas.
- Podnapisi y SubDL son los proveedores primarios (sin limite documentado, sin auth). OpenSubtitles es terciario (20/dia gratis).
- Spotify depreco previews en nov 2024. Usar Deezer para audio de 30s.
- Musixmatch solo da 30% de letra en tier gratuito. Usar lrclib.net como fuente principal de letras.
- NO scraping de sitios con TOS restrictivos. No usar Spotify previews en nuevas apps.
- Archivos de usuario: max 10MB, validar con file-type, chunking antes de enviar a IA
- Leaderboard basado en juegos ganados, NO en nivel de idioma aprendido
- Docker Compose para todo

---

## LANDING PAGE POST-LOGIN (estructura de 3 zonas)

La landing es el dashboard del usuario autenticado. No es la home publica.

```
+--------------------------------------------------+
|  "Que hacemos hoy, [nombre]?"                    |
|  [rotacion por idioma activo del usuario]        |
+--------------------------------------------------+
|  ZONA IZQUIERDA: LOOKUP      |  ZONA DERECHA: MODOS |
|  Input: palabra/frase        |  Estudio formal      |
|  Idioma origen -> destino    |  - Desde cero        |
|  Resultado 3 capas:          |  - Intermedio        |
|    1. Traduccion + fonema    |  - Personalizado     |
|    2. Definicion             |  - Mis archivos      |
|    3. Cultura pop (IA)       |  Gamificacion        |
|       pelicula/cancion/juego |  - Adivina quien?    |
+------------------------------+  - Es o no es?       |
                                  - Como se dice?     |
                                  - Modo pelicula     |
                                  - Batalla PvP       |
```

Lookup endpoint: `GET /lookup?q={term}&from={lang}&to={lang}`
Cache Redis: `lookup:{term}:{fromLang}:{toLang}`, TTL 7 dias

---

## LEADERBOARD

Redis sorted sets:
- `leaderboard:global:{gameType}` - ranking global
- `leaderboard:weekly:{gameType}` - ranking semanal (reset lunes)

gameTypes: `guess_who | true_false | vocab_battle | movie_mode | pvp | all`

Ranking por juegos ganados. NO por nivel de idioma aprendido.

---

## PIPELINE DE SUBTITULOS

### 3 capas en orden de prioridad

1. **Podnapisi** (sin auth, sin limite) -> XML/JSON API
2. **SubDL** (sin auth, sin limite)
3. **OpenSubtitles** (API key, 20/dia gratis) -> terciario
4. **faster-whisper via subgen** (Docker local, GPU RTX 3050) -> fallback cuando los 3 anteriores fallan

### Flujo BullMQ

```
scheduler.ts (cron nocturno)
  -> TMDB /movie/popular + /trending/movie/week
  -> filtrar tmdbIds sin SRT en DB
  -> BullMQ queue "subtitle-fetch"

subtitle.worker.ts
  -> buscar en Podnapisi, SubDL, OpenSubtitles en paralelo
  -> guardar mejor score en SubtitleCache
  -> si no encontrado: encolar en "subtitle-whisper"

whisper.worker.ts
  -> POST subgen:9000/transcribe
  -> guardar SRT con source="whisper"
```

### Schema SubtitleCache

```prisma
model SubtitleCache {
  id        String   @id @default(cuid())
  tmdbId    Int
  language  String
  content   String
  source    String   // "podnapisi" | "subdl" | "opensubtitles" | "whisper"
  score     Int      @default(0)
  createdAt DateTime @default(now())
  @@unique([tmdbId, language])
  @@index([tmdbId])
}
```

### Pre-poblado durante desarrollo

```bash
# Corre en background mientras se desarrolla el resto
npx tsx scripts/seed-subtitles.ts --limit=500 --lang=es,en
# ~100-150 SRTs/noche con Podnapisi + SubDL sin limite. Costo: $0.
```

---

## ESQUEMA DE BASE DE DATOS COMPLETO (Prisma)

```prisma
model User {
  id            String        @id @default(cuid())
  email         String        @unique
  passwordHash  String
  createdAt     DateTime      @default(now())
  profile       UserProfile?
  progress      UserProgress[]
  files         UserFile[]
  gameResults   GameResult[]
  following     UserFollow[]  @relation("follower")
  followers     UserFollow[]  @relation("following")
}

model UserProfile {
  userId          String   @id
  user            User     @relation(fields: [userId], references: [id])
  targetLanguages String[]
  level           Int      @default(0)
  interests       String[]
  xpTotal         Int      @default(0)
  streakDays      Int      @default(0)
  lastActiveAt    DateTime @default(now())
}

model UserProgress {
  id           String   @id @default(cuid())
  userId       String
  user         User     @relation(fields: [userId], references: [id])
  exerciseType String
  wasCorrect   Boolean
  errorType    String?
  createdAt    DateTime @default(now())
}

model UserFile {
  id           String   @id @default(cuid())
  userId       String
  user         User     @relation(fields: [userId], references: [id])
  originalName String
  fileType     String
  chunks       String[]
  createdAt    DateTime @default(now())
}

model GameResult {
  id         String   @id @default(cuid())
  userId     String
  user       User     @relation(fields: [userId], references: [id])
  gameType   String
  won        Boolean
  language   String
  opponentId String?
  createdAt  DateTime @default(now())
}

model UserFollow {
  followerId  String
  followingId String
  createdAt   DateTime @default(now())
  follower    User     @relation("follower", fields: [followerId], references: [id])
  following   User     @relation("following", fields: [followingId], references: [id])
  @@id([followerId, followingId])
}

model SubtitleCache {
  id        String   @id @default(cuid())
  tmdbId    Int
  language  String
  content   String
  source    String
  score     Int      @default(0)
  createdAt DateTime @default(now())
  @@unique([tmdbId, language])
  @@index([tmdbId])
}
```

---

## CONTRATO DE EJERCICIO (shared/types/exercise.ts)

```typescript
type ExerciseType =
  | 'multiple_choice'
  | 'fill_blank'
  | 'true_false'
  | 'free_translation'
  | 'guess_who'
  | 'culture_pop';

interface Exercise {
  id: string;
  type: ExerciseType;
  language: string;
  level: 0 | 1 | 2;
  prompt: string;
  options?: string[];
  correctAnswer: string;
  explanation: string;
  culturalNote?: string;
  source?: string;
}

interface ExerciseFeedback {
  exerciseId: string;
  wasCorrect: boolean;
  userAnswer: string;
  correctAnswer: string;
  explanation: string;
  culturalNote?: string;
  errorType?: string;
}

type GameType = 'guess_who' | 'true_false' | 'vocab_battle' | 'movie_mode' | 'pvp';

interface LeaderboardEntry {
  rank: number;
  userId: string;
  username: string;
  gamesWon: number;
  isCurrentUser: boolean;
}

interface LookupResult {
  term: string;
  fromLang: string;
  toLang: string;
  translation: string;
  definition?: string;
  pronunciation?: string;
  culturalContext?: {
    source: string;
    sourceType: 'movie' | 'game' | 'song' | 'series' | 'book' | 'comic';
    contextQuote: string;
    usage: string;
  }[];
}
```

---

## ESTRATEGIA DE IA

**Dev:** Ollama local | **Prod:** Claude API | **Swap:** `AI_PROVIDER=ollama|claude`

### Rol minimizado (70-80% viene de APIs y DB)

La IA solo interviene en:
1. `cultural_context` de una frase - cacheable 7 dias Redis
2. Distractores para multiple_choice - cacheable con el ejercicio
3. Evaluacion de `free_translation`
4. Fallback videojuegos: ejercicio basado en `storyline` IGDB cuando no hay script del juego

### Cache Redis

- Ejercicios: `exercises:{hash(lang+level+interests+date)}`, TTL 86400
- Lookup cultura pop: `lookup:{term}:{fromLang}:{toLang}`, TTL 604800
- Leaderboard: Redis sorted sets, sin TTL adicional

### Rate limiting

- Ollama dev: sin limite
- Claude prod: 50 requests IA / usuario / hora

---

## FUENTES POR CATEGORIA DE CULTURA POP

### Peliculas / Series
- Portada + metadata: TMDB API (sin limite, gratis)
- Dialogo con timestamp: SubtitleCache DB (permanente, cache local)
- Proveedores SRT: Podnapisi (libre) > SubDL (libre) > OpenSubtitles (20/dia)
- Fallback SRT: faster-whisper via subgen (GPU homelab, $0)
- Clip de escena: YouTube IFrame con `?start={timestamp_del_srt}`

### Musica
- Portada album: Last.fm API (sin limite practico, API key gratis)
- Letra sincronizada: lrclib.net (sin auth, sin limite, timestamps por verso)
- Preview 30s: Deezer API (sin auth para busqueda, MP3 URL)
- Video musical: YouTube IFrame
- Metadata + enlace a letra completa: Genius API

### Videojuegos
- Portada + storyline + screenshots: IGDB via Twitch OAuth (4 req/seg, sin limite dia)
- Lore + personajes: Giant Bomb API (200 req/hora gratis)
- Dialogos: Fandom wiki parsing cuando disponible (cobertura variable)
- Clips gameplay: YouTube IFrame
- Sin script disponible: IA genera ejercicio basado en storyline IGDB

### Libros / Comics
- Portada libro: Open Library (sin auth, sin limite)
- Portada comic Marvel: Marvel API (3000 calls/dia gratis)
- Frases canonicas: Wikiquote API (sin auth, sin limite, cache permanente en DB)
- Texto completo: Project Gutenberg via gutendex.com (dominio publico)

---

## APIS EXTERNAS APROBADAS

| API | URL base | Auth | Limite |
|---|---|---|---|
| TMDB | api.themoviedb.org/3 | API key | ~sin limite |
| Podnapisi | podnapisi.net/api | Sin auth | Sin limite doc. |
| SubDL | subdl.com/api | Sin auth | Sin limite doc. |
| OpenSubtitles | api.opensubtitles.com/api/v1 | API key + login | 20/dia gratis |
| Last.fm | ws.audioscrobbler.com/2.0 | API key | Sin limite practico |
| lrclib.net | lrclib.net/api | Sin auth | Sin limite |
| Deezer | api.deezer.com | Sin auth (busqueda) | Sin limite doc. |
| Genius | api.genius.com | Bearer token | Generoso |
| IGDB | api.igdb.com/v4 | Twitch OAuth | 4 req/seg |
| Giant Bomb | giantbomb.com/api | API key | 200 req/hora |
| Open Library | openlibrary.org + covers.openlibrary.org | Sin auth | Sin limite |
| Marvel | gateway.marvel.com/v1/public | API key + hash | 3000/dia |
| Wikiquote | en.wikiquote.org/w/api.php | Sin auth | Sin limite |
| gutendex.com | gutendex.com/books | Sin auth | Sin limite |
| Free Dictionary | dictionaryapi.dev/api/v2 | Sin auth | Sin limite |
| Wiktionary | en.wiktionary.org/api/rest_v1 | Sin auth | Sin limite |
| MyMemory | api.mymemory.translated.net | Sin auth | 5000 chars/dia |
| LanguageTool | api.languagetool.org | Sin auth | Tier gratis |
| YouTube Data v3 | googleapis.com/youtube/v3 | API key | 10,000 unidades/dia |

---

## GAMIFICACION

- XP por ejercicio correcto, escala por dificultad y tipo
- Streaks diarios SIN penalizacion dura
- 5 minijuegos: Adivina quien?, Es o no es?, Como se dice?, Modo pelicula, Batalla PvP
- Leaderboard en Redis sorted sets por gameType
- PvP asincronico via Socket.io (Fase 6)

---

## UI/UX

- GSAP (gsap + @gsap/react) para transiciones entre ejercicios
- Framer Motion para componentes React / Reanimated para mobile
- Modo oscuro por defecto
- Temas visuales por idioma (paleta, tipografia, iconos culturales)
- Animacion correcto: burst verde + culturalNote slide-up
- Animacion incorrecto: shake suave + explicacion desplegable
- Referencia: https://gsap.com/showcase/

---

## OUTPUT RULES

- Answer line 1. No preamble.
- No "Sure!", "Great!", "Of course!", "Absolutely!", "Certainly!".
- No hollow closings. No "Hope this helps!", "Let me know!".
- No restating the prompt. Task is clear -> execute.
- No explaining what you're about to do. Just do it.
- No unsolicited suggestions. Exact scope only.
- Structured output: bullets, tables, code blocks. Prose only if explicitly asked.

## TOKEN EFFICIENCY

- Every sentence earns its place.
- No redundant context. Don't repeat what's already in session.
- Short = correct. Depth only if asked.

## CODE OUTPUT

- Simplest working solution. No over-engineering.
- No abstractions for single-use ops.
- No speculative features or future-proofing.
- No docstrings/comments on unchanged code.
- Inline comments only where logic is non-obvious.
- Read file before modifying. Never edit blind.
- No new files unless strictly necessary.

## SCOPE CONTROL

- Don't add features beyond what was asked.
- Don't refactor surrounding code when fixing a bug.
- Don't touch files outside the request.

## SYCOPHANCY - ZERO TOLERANCE

- Never validate before answering.
- Disagree when wrong. State correction directly.
- Don't change a correct answer because user pushes back.

## HALLUCINATION PREVENTION

- Never speculate about code/files/APIs not read.
- Reference a file? Read it first, then answer.
- Unsure? Say "I don't know." Never guess confidently.
- Never invent paths, function names, or API signatures.

## TYPOGRAPHY - ASCII ONLY

- No em dashes -> use hyphens (-)
- No smart/curly quotes -> use straight quotes
- No ellipsis char -> use three dots (...)
- No Unicode bullets -> use hyphens (-) or asterisks (*)

## WARNINGS & DISCLAIMERS

- No safety disclaimers unless genuine life/legal risk.
- No "Note that...", "Keep in mind...", "Worth mentioning...".
- No "As an AI..." framing.

## SESSION MEMORY

- Learn corrections and preferences within session.
- Apply silently. Don't re-announce learned behavior.

---

## STACK DEFAULTS

- Runtime: Node.js 20+ (ESM preferred), TypeScript strict
- Frontend: React 18 + Vite + Tailwind CSS
- Mobile: Expo Router (SDK 51+) + React Native
- ORM: Prisma
- Backend: Express 5 / Fastify
- Cache: Redis 7
- Queue: BullMQ (sobre Redis)
- AI Dev: Ollama (llama3.2:3b o qwen2.5:7b-q4_K_M)
- AI Prod: Claude API (claude-sonnet-4-20250514)
- Infra: Docker Compose, Cloudflare Tunnel
- OS target: Ubuntu/Debian (homelab)
- Secrets: .env files, never hardcoded
- Validation: Zod (especialmente respuestas JSON de IA)
- Realtime: Socket.io (PvP y leaderboard live updates)
- Subtitle local: faster-whisper via subgen Docker (GPU homelab)
