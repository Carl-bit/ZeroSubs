# ZeroSubs - Roadmap de Desarrollo

> Plataforma de aprendizaje de idiomas adaptativa impulsada por IA. Sin anuncios, sin suscripciones agresivas. Gamificacion con cultura pop.

---

## Vision del Producto

ZeroSubs es una plataforma de aprendizaje de idiomas centrada en la personalizacion, la interactividad y la calidad visual. El diferenciador principal frente a Duolingo es la ausencia de monetizacion agresiva, la generacion dinamica de ejercicios por IA (no un banco estatico), y la gamificacion basada en cultura pop real (cine, musica, videojuegos).

### Diferenciadores clave

| Area | ZeroSubs | Duolingo |
|---|---|---|
| Modelo de negocio | Sin anuncios ni paywall | Freemium con anuncios agresivos |
| Generacion de ejercicios | IA dinamica segun perfil e intereses | Banco estatico curado |
| Contexto de aprendizaje | Cultura pop: peliculas, canciones, juegos | Frases genericas |
| Archivos propios | Upload PDF/SRT para estudiar desde tu contenido | No disponible |
| Leaderboard | Por juegos ganados, no por nivel aprendido | Por XP/nivel |
| UI/UX | GSAP, animaciones fluidas, temas por idioma | Funcional pero uniforme |

---

## Arquitectura del Sistema

### Stack

| Capa | Tecnologia |
|---|---|
| Frontend Web | React 18 + Vite + Tailwind CSS + GSAP |
| App Mobile | Expo Router (SDK 51+) + React Native + Reanimated |
| Backend API | Node.js/Express 5 + TypeScript |
| ORM | Prisma |
| Base de datos | PostgreSQL |
| Cache / Realtime | Redis 7 (ejercicios, lookup, leaderboard sorted sets) |
| IA - Desarrollo | Ollama local (llama3.2:3b-q4 o qwen2.5:7b-q4_K_M) |
| IA - Produccion | Claude API (claude-sonnet-4-20250514) |
| Autenticacion | JWT + refresh token rotation |
| Infra | Docker Compose + Cloudflare Tunnel |
| Realtime PvP | Socket.io |
| Validacion | Zod (especialmente respuestas JSON de IA) |
| Cola de trabajos | BullMQ + Redis (pipeline de subtitulos) |
| Transcripcion local | faster-whisper via subgen Docker |

### Flujo de datos principal

```
[Usuario] -> [React/Expo] -> [Express API]
                                 |
       +----------------+--------+----------+------------------+
       |                |                   |                  |
[ExerciseService] [LookupService] [LeaderboardService] [SubtitleService]
       |                |                   |                  |
  [AIService]     [Dict APIs]        [Redis sorted sets]  [subtitle_cache DB]
   Ollama|Claude   Wiktionary                               [BullMQ worker]
       |
  [Redis cache]
  [PostgreSQL]

[subtitle-scheduler - cron nocturno]
  -> TMDB trending -> BullMQ queue -> subtitle.worker
     -> Podnapisi | SubDL | OpenSubtitles -> PostgreSQL subtitle_cache
     -> fallback: subgen (faster-whisper GPU) -> PostgreSQL
```

### APIs externas aprobadas

**Diccionario / traduccion:**
- Free Dictionary API: `https://api.dictionaryapi.dev/api/v2/entries/en/{word}` - sin auth
- Wiktionary API: `https://en.wiktionary.org/api/rest_v1/` - multilingual, libre
- MyMemory Translation: `https://api.mymemory.translated.net/` - 5000 chars/dia gratis
- LanguageTool API: `https://api.languagetool.org/` - revision gramatical, tier gratis

**Peliculas / series:**
- TMDB: `https://api.themoviedb.org/3/` - portadas + metadata, sin limite documentado, API key gratis
- Podnapisi: API XML/JSON sin auth, sin limite - proveedor SRT primario
- SubDL: API sin auth, sin limite documentado - proveedor SRT secundario
- OpenSubtitles REST: `https://api.opensubtitles.com/api/v1/` - 20 SRT/dia gratis - proveedor SRT terciario

**Musica:**
- Last.fm: `https://ws.audioscrobbler.com/2.0/` - portadas albums, sin limite practico, API key gratis
- lrclib.net: `https://lrclib.net/api/` - letras sincronizadas con timestamps, sin auth, sin limite
- Deezer: `https://api.deezer.com/search` - preview 30s MP3, sin auth para busqueda basica
- Genius: `https://api.genius.com/` - metadata + URL de pagina de letra (no letra directa)

**Videojuegos:**
- IGDB: `https://api.igdb.com/v4/` - portadas, storyline, screenshots; via Twitch OAuth; 4 req/seg sin limite diario
- Giant Bomb: `https://www.giantbomb.com/api/` - lore, personajes; 200 req/hora gratis

**Libros / Comics:**
- Open Library: `https://openlibrary.org/` + `https://covers.openlibrary.org/` - portadas por ISBN, sin auth
- Marvel API: `http://gateway.marvel.com/v1/public/` - portadas + personajes; 3000 calls/dia gratis
- Wikiquote: `https://en.wikiquote.org/w/api.php` - frases canonicas por obra/personaje, sin auth
- gutendex.com: `https://gutendex.com/books/` - wrapper de Project Gutenberg, textos dominio publico

> Spotify depreco los previews de 30s en noviembre 2024 para nuevas apps. No usar.
> Musixmatch solo entrega 30% de la letra en tier gratuito. Usar lrclib.net.
> No implementar scraping de Cambridge u otros sitios con TOS restrictivos.

---

## Estructura del Proyecto

```
/zerosubs
  backend/
    src/
      routes/
      controllers/
      services/
        ai/           - AIService + OllamaProvider + ClaudeProvider
        exercise/     - generacion, cache, evaluacion
        file/         - parser PDF/SRT + chunking
        lookup/       - busqueda de palabras + contexto cultura pop
        leaderboard/  - tablas por minijuego (Redis)
        subtitle/     - SubtitleService + providers
          providers/  - PodnapisiProvider, SubDLProvider, OpenSubtitlesProvider
      workers/
        subtitle.worker.ts  - BullMQ worker: descarga SRT via 3 capas
        scheduler.ts        - cron nocturno: encola peliculas de TMDB trending
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
    types/            - tipos TypeScript compartidos
  docker/
    compose.yml
    .env.example
  scripts/
    seed-subtitles.ts - encola top N peliculas de TMDB para pre-poblar DB
```

---

## Pipeline de Subtitulos (Bazarr-style)

Este sistema resuelve el acceso a dialogos de peliculas para los ejercicios de cultura pop sin depender de una sola fuente ni pagar durante el desarrollo.

### El problema que resuelve

200 usuarios estudiando peliculas generan ~5000 requests de SRT/dia. OpenSubtitles gratis tiene limite de 20/dia. La solucion: descargar cada SRT una vez, guardarlo en PostgreSQL de forma permanente, nunca volver a pedirlo. El catalogo se pre-pobla durante el desarrollo para que al llegar a la Fase 3 ya este disponible.

### Las 3 capas (en orden de prioridad)

**Capa 1 - Proveedores externos (multi-provider, estilo Bazarr)**

Se consultan los 3 proveedores en paralelo. Se guarda el de mayor score.

| Proveedor | Limite gratuito | Auth requerida |
|---|---|---|
| Podnapisi | Sin limite documentado | No - XML/JSON libre |
| SubDL | Sin limite documentado | No |
| OpenSubtitles | 20/dia gratis | Si - API key + login |

Con Podnapisi y SubDL sin limite, el techo practico es de 100-500 SRTs/dia sin costo. OpenSubtitles actua como tercer proveedor para titulos que los otros dos no cubran.

**Capa 2 - faster-whisper local (fallback offline)**

Si los proveedores externos no tienen SRT, el worker transcribe el audio del archivo de video con faster-whisper en la RTX 3050 del homelab.

- Proyecto: `github.com/McCloudS/subgen` - Docker que expone endpoint HTTP, Bazarr lo usa como provider custom
- Modelo: `faster-whisper large-v3` o `medium` segun disponibilidad de VRAM
- Velocidad estimada RTX 3050: 5-15 min por pelicula de 2h
- Costo: $0

**Capa 3 - YouTube transcripcion (ultima instancia)**

Para peliculas sin archivo de video local y sin SRT en proveedores externos.

```bash
yt-dlp --write-auto-subs --sub-langs es,en --skip-download "URL"
```

### Flujo del worker

```
[scheduler.ts - cron nocturno]
  GET TMDB /movie/popular + /trending/movie/week
  -> filtrar tmdbIds sin SRT en DB
  -> encolar en BullMQ queue "subtitle-fetch"

[subtitle.worker.ts]
  para cada pelicula en cola:
    1. PodnapisiProvider.search(tmdbId, lang)
    2. SubDLProvider.search(tmdbId, lang)
    3. OpenSubtitlesProvider.search(tmdbId, lang)  <- respeta limite 20/dia
    si encontrado: SubtitleCache.upsert({ tmdbId, lang, content, source })
    si no encontrado: encolar en "subtitle-whisper"

[whisper.worker.ts]
  POST http://subgen:9000/transcribe { video_path, language }
  -> recibir SRT generado
  -> SubtitleCache.upsert({ source: "whisper" })
```

### Schema Prisma para subtitulos

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
# Encola las top 500 peliculas mas populares de TMDB para su descarga
npx tsx scripts/seed-subtitles.ts --limit=500 --lang=es,en

# Con Podnapisi + SubDL sin limite:
# - 3-5 dias para cubrir top 500
# - ~100-150 SRTs/noche respetando rate limits
# - Costo: $0
```

La Fase 0.5 corre en paralelo al desarrollo principal. Al llegar a la Fase 3, el catalogo ya esta disponible.

### Analisis de requests para 200 usuarios (25 preguntas/dia, 1 tematica)

| API | Limite gratuito/dia | Sin cache | Con cache | Estado |
|---|---|---|---|---|
| TMDB portadas | ~sin limite | 5,000 | 200-400 | OK |
| OpenSubtitles SRT | 20/dia | 5,000 | 10-30 nuevos | OK con cache permanente |
| Podnapisi SRT | sin limite | - | proveedor libre | OK |
| YouTube Search | 100 busquedas | 5,000 | 20-60 | OK con cache 7 dias |
| YouTube IFrame | sin limite | 5,000 | N/A | OK siempre |
| Last.fm portadas | sin limite practico | 5,000 | 200-400 | OK |
| lrclib letras | sin limite | 5,000 | 200-400 | OK |
| Deezer preview | sin limite | 5,000 | 200-400 | OK |
| IGDB | 4 req/seg, sin limite dia | 5,000 | 100-300 | OK con cache 7 dias |
| Open Library | sin limite | 5,000 | 200-400 | OK |
| Wikiquote | sin limite | 5,000 | permanente DB | OK |

**Costo total de APIs para 200 usuarios: $0/mes** con las APIs listadas y cache correcto.

### TTLs de cache

| Contenido | TTL | Almacenamiento |
|---|---|---|
| SRT de pelicula | Permanente | PostgreSQL |
| Portada TMDB/IGDB | 30 dias | Redis |
| Portada Last.fm | 7 dias | Redis |
| Letra lrclib | 7 dias | Redis |
| Preview Deezer URL | 24h | Redis |
| Lookup cultura pop (IA) | 7 dias | Redis |
| Ejercicios IA | 24h | Redis |
| Frases Wikiquote | Permanente | PostgreSQL |
| Video ID YouTube | 7 dias | Redis |

---

## Landing Page Post-Login

La landing es el dashboard del usuario autenticado (no la home publica).

### Estructura de 3 zonas

```
+----------------------------------------------------+
|  "Que hacemos hoy, [nombre]?"                      |
|  Rota entre los idiomas activos del usuario:       |
|  "Qu'est-ce qu'on fait aujourd'hui, Carlos?"       |
+----------------------------------------------------+
|  ZONA LOOKUP                  |  ZONA MODOS        |
|                               |                    |
|  [input: palabra o frase]     |  -- Estudio --     |
|  [idioma origen -> destino]   |  Desde cero        |
|                               |  Intermedio        |
|  Resultado en 3 capas:        |  Personalizado     |
|  1. Traduccion + pronunciacion|  Mis archivos      |
|  2. Definicion en idioma obj. |                    |
|  3. Cultura pop:              |  -- Gamificacion --+
|     "Aparece en Pulp Fiction  |  Adivina quien?    |
|      cuando [contexto]"       |  Es o no es?       |
|     [tipo: movie/game/song]   |  Como se dice?     |
|                               |  Modo pelicula     |
|                               |  Batalla PvP       |
+----------------------------------------------------+
```

---

## Leaderboard (Tablero de Juegos)

**Principio:** ranking por juegos ganados, NO por nivel de idioma aprendido.

| gameType | Nombre en UI |
|---|---|
| `guess_who` | Adivina quien? |
| `true_false` | Es o no es? |
| `vocab_battle` | Como se dice? |
| `movie_mode` | Modo pelicula |
| `pvp` | Batalla 1vs1 |
| `all` | Todos (default) |

Redis sorted sets: `leaderboard:global:{gameType}` y `leaderboard:weekly:{gameType}`.

Endpoints:
```
GET  /leaderboard?gameType=all&period=weekly
GET  /leaderboard/friends?gameType=guess_who
POST /leaderboard/game-result
POST /users/follow/:userId
```

---

## Sistema de IA - Estrategia

```
AI_PROVIDER=ollama  ->  OllamaProvider  (http://localhost:11434)
AI_PROVIDER=claude  ->  ClaudeProvider  (api.anthropic.com)
```

### Modelos Ollama (6GB VRAM)

- `llama3.2:3b-instruct-q4_K_M` - rapido, ejercicios simples
- `qwen2.5:7b-instruct-q4_K_M` - mejor razonamiento, feedback elaborado

### Rol de la IA (minimizado con APIs)

El 70-80% del contenido viene de APIs y DB local. La IA solo interviene en:

1. `cultural_context` de una frase (cacheable 7 dias en Redis)
2. Distractores para multiple_choice (cacheable con el ejercicio)
3. Evaluacion de `free_translation`
4. Fallback de videojuegos: ejercicio basado en storyline IGDB

---

## Gamificacion

| Tipo | Descripcion | Fuente |
|---|---|---|
| `multiple_choice` | 4 opciones, 1 correcta | IA |
| `fill_blank` | Completar la oracion | IA |
| `true_false` | Correcto/incorrecto gramaticalmente | IA |
| `free_translation` | Traduccion libre | IA evaluacion |
| `guess_who` | Cita anonimizada, identificar origen | IA + Wikiquote |
| `culture_pop` | Dialogo de pelicula con huecos | SubtitleCache + IA |

---

## Roadmap por Fases

| Fase | Duracion | Entregables |
|---|---|---|
| 0 | 1-2 sem | Repo + Docker Compose base + estructura + .env + schema Prisma con SubtitleCache |
| 0.5 | paralelo desde dia 1 | Pipeline subtitulos: BullMQ worker + 3 proveedores + seed script TMDB top 500 |
| 1 | 3-4 sem | Auth JWT + perfil usuario + onboarding idioma/nivel/intereses |
| 2 | 4-6 sem | Motor IA Ollama + 3 tipos de ejercicio + feedback + cache Redis |
| 3 | 3-4 sem | Landing post-login 3 zonas + LookupService + cultura pop via IA |
| 4 | 3-4 sem | UI GSAP + animaciones + modo oscuro + temas por idioma |
| 5 | 3-4 sem | Upload archivos propios (PDF/SRT) + ejercicios desde contenido propio |
| 6 | 4-5 sem | Gamificacion: 5 minijuegos + XP/streaks |
| 7 | 3-4 sem | Leaderboard global y amigos + filtro + Socket.io live updates |
| 8 | 2-3 sem | App mobile: Expo Router + gestos nativos + push notifications |
| 9 | 2-3 sem | Swap Claude API produccion + ajuste prompts + monitoreo costos |

> La Fase 0.5 corre en background desde el dia 1 del desarrollo. Al llegar a Fase 3, el catalogo de subtitulos ya tiene cientos de peliculas disponibles sin ningun costo.

---

## Proximos pasos inmediatos

1. Crear repo `zerosubs` con estructura monorepo
2. Docker Compose con servicios base + subtitle-worker + subgen
3. Prisma schema con `SubtitleCache` incluido + primera migracion
4. Implementar subtitle worker: Podnapisi + SubDL (sin limite, prioridad)
5. Correr `seed-subtitles.ts` contra TMDB top 200 para empezar el catalogo
6. Backend: Express + TypeScript + `/health`
7. Prompt base para ejercicios, testear con Ollama local
8. Frontend: Vite + React + Tailwind + onboarding

> El pipeline de subtitulos corre desde el dia 1. Cuando se necesite en Fase 3, el catalogo ya esta disponible.

---

## Seguridad y Privacidad

- API keys en variables de entorno, nunca en codigo ni en el frontend
- Rate limiting en todos los endpoints de IA
- Archivos de usuario: escanear con `file-type` antes de procesar
- Chunks de archivos: no enviar el documento completo a la IA
- CORS configurado estrictamente en produccion
- JWT con refresh token rotation
- Leaderboard: solo usernames publicos, nunca emails
- SRTs en DB: solo texto plano, no redistribuir archivos al cliente

---

*Ultima actualizacion: 2025-04 | Proyecto: ZeroSubs*
