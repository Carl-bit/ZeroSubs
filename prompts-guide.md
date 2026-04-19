# Prompts Guide — ZeroSubs
## Ejecucion secuencial. Verificar cada paso antes de avanzar.

> Pre-requisito: CLAUDE.md en raiz del proyecto. Claude Code lo lee al inicio de sesion.
> Estado inicial: repo vacio. Todo por construir.

---

## Que se optimizo y por que

### Regla 1: No repetir lo que CLAUDE.md ya define
El CLAUDE.md del proyecto ya tiene: estructura de carpetas, schema Prisma completo,
contratos TypeScript de Exercise/LookupResult/LeaderboardEntry/GameType, stack,
constraints, estrategia de IA, endpoints, TTLs de Redis y APIs externas aprobadas.

**Si esta en CLAUDE.md, no va en el prompt. "Segun CLAUDE.md" es suficiente.**

### Regla 2: El prompt es la instruccion, no la explicacion
Claude Code no necesita saber por que usas Ollama en dev o por que Redis cachea
el lookup. Solo necesita saber que construir.

**Los comentarios explicativos van en esta guia, no en lo que se pega.**

### Regla 3: Patron + repeticion, no prompt por cada service
Hay 3 AI providers, 2 exercise types iniciales, 5 minijuegos, 4 APIs de diccionario.
Establecer el patron con el primero, luego "mismo patron para X, Y, Z".

### Regla 4: Estructura en CLAUDE.md, no en el prompt
La estructura de `/zerosubs` ya esta definida en CLAUDE.md seccion "Structure".
"Crea la estructura segun CLAUDE.md" evita duplicar ~20 lineas de tokens.

### Resumen de ahorro estimado

| Metrica | Sin optimizar | Optimizado |
|---|---|---|
| Tokens por prompt largo | ~800-1200 | ~300-500 |
| Prompts para montar el backend | ~15 | ~8 |
| Repeticion de interfaces TS | en cada prompt | 0 (en CLAUDE.md) |

---

## FASE 0 - Scaffolding del Monorepo

### 0.1 - Estructura base
```
Crea la estructura del monorepo segun CLAUDE.md seccion "Structure".
Archivos vacios excepto:

shared/types/exercise.ts: interfaces Exercise, ExerciseFeedback, ExerciseType
  segun CLAUDE.md seccion "CONTRATO DE EJERCICIO".
shared/types/leaderboard.ts: interfaces LeaderboardEntry, GameType,
  LookupResult segun CLAUDE.md.
shared/types/index.ts: re-exporta todo desde exercise.ts y leaderboard.ts.

backend/package.json: express, prisma, @prisma/client, redis, bullmq, axios, zod,
  dotenv, cors, morgan, helmet, express-rate-limit, socket.io, bcryptjs,
  jsonwebtoken, file-type, pdf-parse, srt-parser-2, node-cron, xml2js.
  devDeps: typescript, tsx, @types/express, @types/cors, @types/morgan,
  @types/bcryptjs, @types/jsonwebtoken, @types/xml2js, @types/node-cron.
backend/tsconfig.json: Node.js ESM, strict: true, outDir: dist.
backend/prisma/schema.prisma: schema completo segun CLAUDE.md
  seccion "ESQUEMA DE BASE DE DATOS COMPLETO" (incluye SubtitleCache).
backend/.env.example: DATABASE_URL, REDIS_URL, JWT_SECRET, JWT_REFRESH_SECRET,
  AI_PROVIDER (ollama|claude), OLLAMA_URL, CLAUDE_API_KEY, CLAUDE_MODEL, PORT,
  TMDB_API_KEY, OPENSUBTITLES_API_KEY, OPENSUBTITLES_USERNAME, OPENSUBTITLES_PASSWORD,
  LASTFM_API_KEY, GENIUS_API_KEY, TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET,
  MARVEL_PUBLIC_KEY, MARVEL_PRIVATE_KEY, YOUTUBE_API_KEY,
  SUBGEN_URL (http://subgen:9000), SUBTITLE_SEED_LIMIT (200).

frontend/package.json: react, react-dom, react-router-dom, axios, gsap,
  @gsap/react, framer-motion, tailwindcss, vite.
  devDeps: @vitejs/plugin-react, typescript, @types/react.
frontend/vite.config.ts, tailwind.config.ts, tsconfig.json basicos.

scripts/seed-subtitles.ts: script standalone (no parte del server).
  Lee TMDB_API_KEY y SUBTITLE_SEED_LIMIT de .env.
  Llama GET /movie/popular paginando hasta el limite.
  Para cada pelicula, encola en BullMQ queue "subtitle-fetch".
  Muestra progreso en consola. Se ejecuta una vez manualmente.

Solo crear archivos, no instalar dependencias.
```

### 0.2 - Docker Compose
```
Crea docker/compose.yml con 7 servicios:

postgres: postgres:16, POSTGRES_DB=zerosubs, volumen persistente,
  healthcheck pg_isready.
redis: redis:7-alpine, requirepass via env, volumen persistente,
  healthcheck redis-cli ping.
ollama: ollama/ollama, volumen persistente, GPU si disponible
  (deploy.resources.reservations.devices driver nvidia).
backend: build ./backend, depends_on postgres+redis+ollama (condition healthy),
  env_file .env, puerto 3000 expuesto al host SOLO en dev.
  En produccion, reemplazar por Cloudflare Tunnel (sin puertos expuestos).
subtitle-worker: build ./backend, command: node dist/workers/subtitle.worker.js,
  env_file .env, depends_on postgres+redis, restart: unless-stopped.
  No expone puertos. Consume la queue BullMQ "subtitle-fetch".
subtitle-scheduler: build ./backend, command: node dist/workers/scheduler.js,
  env_file .env, depends_on postgres+redis, restart: unless-stopped.
  Cron nocturno: encola peliculas TMDB trending en la queue.
subgen: ghcr.io/mccloudS/subgen:latest (o imagen equivalente),
  env WHISPER_MODEL=large-v3, CONCURRENT_TRANSCRIPTIONS=1,
  volumen para acceso a archivos de video si disponibles,
  puerto 9000 expuesto solo a la red interna Docker (no al host),
  GPU passthrough igual que ollama, restart: unless-stopped.

Todos restart: unless-stopped.
Crea docker/.env.example con todas las variables de CLAUDE.md.
Crea docker/SETUP.md: como levantar el stack, como bajar modelos Ollama,
  como ejecutar el seed inicial (npx tsx scripts/seed-subtitles.ts),
  notas sobre GPU passthrough para ollama y subgen.
```

### 0.3 - Scripts de desarrollo
```
En backend/package.json agrega scripts:
  dev: tsx watch src/index.ts
  build: tsc
  start: node dist/index.js
  db:migrate: prisma migrate dev
  db:generate: prisma generate
  db:studio: prisma studio

En frontend/package.json agrega scripts:
  dev: vite
  build: tsc && vite build
  preview: vite preview

Crea DEV.md en raiz: como levantar el stack completo para desarrollo,
url del backend (localhost:3000), url del frontend (localhost:5173),
como conectar frontend al backend via variables de entorno VITE_API_URL,
comando unico para levantar todo: docker compose -f docker/compose.yml up -d
y luego npm run dev en backend/ y frontend/ en terminales separadas.
```

---

## FASE 0.5 - Pipeline de Subtitulos (corre en paralelo desde dia 1)

> Esta fase no bloquea nada. Se implementa una vez y corre en background mientras se desarrolla el resto. Al llegar a Fase 3 (ejercicios de cultura pop), el catalogo ya esta disponible.

### 0.5.1 - Providers de subtitulos
```
Implementa los 3 providers en backend/src/services/subtitle/providers/.
Todos exportan la misma interfaz:
  interface SubtitleProvider {
    search(tmdbId: number, language: string): Promise<SubtitleResult | null>
  }
  interface SubtitleResult { content: string; score: number; source: string }

PodnapisiProvider.ts:
  Buscar por tmdbId en su API XML/JSON (sin auth).
  Endpoint de busqueda: https://www.podnapisi.net/subtitles/search/old
  Params: tmdb={tmdbId}&language={lang}&format=json
  Parsear respuesta XML con xml2js si necesario.
  Retornar el subtitulo de mayor downloads como resultado.

SubDLProvider.ts:
  Mismo patron que Podnapisi.
  API: https://api.subdl.com/api/v1/subtitles?tmdb_id={tmdbId}&languages={lang}
  Sin auth requerida para busqueda basica.

OpenSubtitlesProvider.ts:
  Usar OpenSubtitles REST API v1.
  Auth: POST /login con credenciales -> token JWT en header.
  Busqueda: GET /subtitles?tmdb_id={tmdbId}&languages={lang}
  Descarga: POST /download { file_id }
  Respetar limite 20 descargas/dia con contador en Redis:
    key os_daily_count, INCR + EXPIRE 86400.
    Si contador >= 20: return null sin llamar al endpoint de descarga.
```

### 0.5.2 - Worker BullMQ y scheduler
```
Implementa backend/src/workers/subtitle.worker.ts:
  Conectar a BullMQ queue "subtitle-fetch" en Redis.
  Para cada job { tmdbId, languages: string[] }:
    Para cada language en languages:
      1. Verificar si ya existe en SubtitleCache (skip si existe).
      2. Llamar PodnapisiProvider.search -> resultado o null.
      3. Si null: SubDLProvider.search.
      4. Si null: OpenSubtitlesProvider.search (respeta limite Redis).
      5. Si resultado: prisma.subtitleCache.upsert({ tmdbId, language, content, source, score }).
      6. Si null en todos: encolar en queue "subtitle-whisper" para Whisper.
  Concurrencia: 3 jobs simultaneos (no sobrecargar APIs).
  Log de cada resultado (encontrado/no encontrado/fuente).

Implementa backend/src/workers/scheduler.ts:
  Cron con node-cron: "0 2 * * *" (2am cada noche).
  GET https://api.themoviedb.org/3/movie/popular?page=1..5 (top ~100)
  GET https://api.themoviedb.org/3/trending/movie/week
  Para cada pelicula: verificar si tmdbId ya tiene SRT para es+en en DB.
  Si falta alguno: queue.add("subtitle-fetch", { tmdbId, languages: ["es","en"] })
  Log de cuantas peliculas nuevas se encolaron.

Implementa backend/src/workers/whisper.worker.ts:
  Queue "subtitle-whisper". Si SUBGEN_URL no esta configurado: skip con log.
  POST ${SUBGEN_URL}/transcribe { video_path?, tmdb_id, language }
  Si subgen responde SRT: upsert en SubtitleCache con source="whisper".
  Si no hay video local: log y skip (whisper necesita el archivo).
```

### 0.5.3 - Script de seed inicial ------>here!!!!
```
Implementa scripts/seed-subtitles.ts (script standalone, no parte del server):
  Lee TMDB_API_KEY y SUBTITLE_SEED_LIMIT (default 200) de .env.
  Paginar GET /movie/popular hasta llegar al limite.
  Para cada pelicula: verificar en DB si ya tiene SRT.
  Si no: queue.add con { tmdbId, languages: ["es","en"] }.
  Al final: mostrar resumen (total encoladas, ya existentes, saltadas).

Instrucciones de uso tras la Fase 0:
  npm run db:migrate
  npx tsx scripts/seed-subtitles.ts
  # Deja corriendo subtitle-worker en background (ya esta en docker-compose)
  # Verifica progreso con: docker logs subtitle-worker -f
```

### 0.5.4 - Endpoint de consulta (para ejercicios Fase 3)
```
Implementa backend/src/services/subtitle/SubtitleService.ts:

getByTmdbId(tmdbId: number, language: string): Promise<string | null>
  -> prisma.subtitleCache.findFirst({ where: { tmdbId, language } })
  -> retornar content (el SRT completo) o null

extractQuotes(srtContent: string, count: number): Quote[]
  -> parsear SRT con srt-parser-2
  -> filtrar lineas muy cortas (< 4 palabras) o con caracteres especiales
  -> retornar count lineas aleatorias con { text, startTime, endTime }
  -> startTime en segundos (para YouTube IFrame ?start=)

Endpoint: GET /subtitles/:tmdbId?lang=es
  Solo uso interno (ejercicios), requiere auth, no exponer al cliente directamente.
```

---

## FASE 1 - Backend: Auth y Base

### 1.1 - Entry point y configuracion
```
Implementa:

backend/src/index.ts: Express con cors, helmet, morgan, json body parser.
  GET /api/health -> { status: "ok", timestamp, ai_provider: process.env.AI_PROVIDER }.
  Registrar routers (vacios por ahora, los implementamos en 1.5).
  Inicializar conexion Redis al arrancar. Puerto desde env o 3000.

backend/src/config/redis.ts: cliente Redis con reconexion automatica,
  log de conexion/error, exportar cliente singleton.

backend/src/config/constants.ts: TTLs (exercises: 86400, lookup: 604800),
  limites de rate (global: 100/min, ai: 50/hora por usuario),
  gameTypes array segun CLAUDE.md.

backend/src/middleware/errorHandler.ts: middleware de error Express,
  responde ApiResponse con success: false, sin stack en NODE_ENV=production.

backend/src/middleware/auth.ts: verifyToken middleware, extrae JWT del
  header Authorization, agrega req.userId. Rechaza con 401 si invalido.
```

### 1.2 - Auth endpoints
```
Implementa backend/src/controllers/authController.ts y
backend/src/routes/auth.ts:

POST /api/auth/register: validar email+password con Zod,
  bcrypt hash (saltRounds 12), crear User + UserProfile vacio via Prisma,
  devolver access token (15min) + refresh token (7dias).

POST /api/auth/login: verificar credenciales, misma respuesta.

POST /api/auth/refresh: verificar refresh token, devolver nuevo access token.

GET /api/auth/me: requiere auth middleware, devolver user + profile.

Tokens JWT firmados con secrets distintos (JWT_SECRET vs JWT_REFRESH_SECRET).
Refresh token guardado en Redis: key refresh:{userId}, TTL 7 dias.
```

### 1.3 - Profile y onboarding
```
Implementa backend/src/controllers/profileController.ts y
backend/src/routes/profile.ts. Todas requieren auth middleware.

PUT /api/profile: actualizar UserProfile (targetLanguages, level, interests).
  Validar con Zod: targetLanguages es string[] de codigos ISO 639-1,
  level es 0|1|2, interests es string[].

GET /api/profile: devolver perfil completo del usuario autenticado.

El perfil es necesario para generar ejercicios en Fase 2, definirlo bien aqui.
```

---

## FASE 2 - Backend: Motor de IA

### 2.1 - AIService con OllamaProvider
```
Implementa la interfaz AIService y OllamaProvider segun CLAUDE.md
seccion "ESTRATEGIA DE IA".

backend/src/services/ai/AIService.ts: interface con metodos:
  generateExercises(profile: UserProfile, errorHistory: string[]): Promise<Exercise[]>
  evaluateFreeTranslation(original: string, userAnswer: string, lang: string): Promise<ExerciseFeedback>
  generateCulturalContext(term: string, fromLang: string, toLang: string): Promise<LookupResult['culturalContext']>

backend/src/services/ai/OllamaProvider.ts: implementa AIService usando
  fetch a OLLAMA_URL/api/chat con model desde env.
  generateExercises: prompt con perfil + historial, pide JSON array de Exercise[].
  Parsear y validar respuesta con Zod (schema Exercise de shared/types).
  Si la respuesta no es JSON valido, reintentar una vez, luego throw.

backend/src/services/ai/ClaudeProvider.ts: misma interfaz, stub por ahora.
  throw new Error("Claude provider: set AI_PROVIDER=claude and CLAUDE_API_KEY").

backend/src/services/ai/index.ts: factory que lee AI_PROVIDER y devuelve
  la instancia correcta. Singleton.

El prompt base para generateExercises debe estar en un archivo separado:
backend/src/services/ai/prompts/exercises.ts
Incluir: system prompt, funcion buildExercisePrompt(profile, errorHistory) -> string.
El prompt debe pedir respuesta EXCLUSIVAMENTE en JSON array de Exercise[],
sin texto adicional, sin markdown.
```

### 2.2 - ExerciseService y cache
```
Implementa backend/src/services/exercise/ExerciseService.ts:

generateSet(userId: string): Promise<Exercise[]>
  1. Leer UserProfile desde Prisma.
  2. Leer historial de errores recientes (UserProgress ultimos 20 registros).
  3. Construir cacheKey = hash MD5 de (userId + targetLanguages + level + date YYYY-MM-DD).
  4. Check Redis: si existe, devolver cacheado.
  5. Si no: llamar AIService.generateExercises, validar cada item con Zod Exercise schema.
  6. Guardar en Redis con TTL de constants.EXERCISES_TTL.
  7. Devolver array.

evaluateAnswer(userId: string, exerciseId: string, answer: string): Promise<ExerciseFeedback>
  - Para type != "free_translation": comparacion directa con correctAnswer.
  - Para "free_translation": llamar AIService.evaluateFreeTranslation.
  - Guardar resultado en UserProgress via Prisma.
  - Devolver ExerciseFeedback.

backend/src/routes/exercises.ts:
  GET /api/exercises (auth) -> ExerciseService.generateSet
  POST /api/exercises/:id/answer (auth) -> ExerciseService.evaluateAnswer
```

### 2.3 - LookupService
```
Implementa backend/src/services/lookup/LookupService.ts:

lookup(term: string, fromLang: string, toLang: string): Promise<LookupResult>
  1. cacheKey = lookup:{term}:{fromLang}:{toLang}. Check Redis (TTL 7 dias).
  2. Si no cacheado:
     a. Traduccion: fetch MyMemory API.
     b. Definicion: fetch Free Dictionary API (si fromLang=en o toLang=en)
        o Wiktionary (otros idiomas).
     c. Contexto cultura pop: AIService.generateCulturalContext.
  3. Armar LookupResult, guardar en Redis, devolver.
  Si alguna fuente falla: devolver lo que se pudo obtener, no throw global.

backend/src/routes/lookup.ts:
  GET /api/lookup?q={term}&from={lang}&to={lang} (auth)
```

---

## FASE 3 - Backend: Leaderboard y Juegos

### 3.1 - GameResult y LeaderboardService
```
Implementa backend/src/services/leaderboard/LeaderboardService.ts.
Usa Redis sorted sets segun CLAUDE.md seccion "LEADERBOARD".

recordResult(userId: string, gameType: GameType, won: boolean, language: string): Promise<void>
  - Guardar GameResult en PostgreSQL via Prisma.
  - Si won: ZINCRBY en leaderboard:global:{gameType} y leaderboard:weekly:{gameType}.

getGlobal(gameType: string, period: "weekly"|"all"): Promise<LeaderboardEntry[]>
  - Si period=weekly: ZREVRANGE leaderboard:weekly:{gameType} 0 49 WITHSCORES.
  - Si period=all: ZREVRANGE leaderboard:global:{gameType} 0 49 WITHSCORES.
  - Mapear a LeaderboardEntry[]. Top 50.

getFriends(userId: string, gameType: string): Promise<LeaderboardEntry[]>
  - Leer UserFollow donde followerId=userId.
  - Para cada followingId: ZSCORE leaderboard:global:{gameType}.
  - Ordenar y devolver.

backend/src/routes/leaderboard.ts:
  GET /api/leaderboard?gameType=all&period=weekly (auth)
  GET /api/leaderboard/friends?gameType=all (auth)
  POST /api/leaderboard/game-result (auth) -> body: { gameType, won, language }
```

### 3.2 - Follow y perfil publico
```
backend/src/routes/users.ts:
  POST /api/users/follow/:userId (auth): crear UserFollow en Prisma.
    No permitir seguirse a uno mismo. Ignorar si ya existe (upsert).
  DELETE /api/users/follow/:userId (auth): eliminar UserFollow.
  GET /api/users/:userId/public: devolver username y stats publicos
    (gamesWon por gameType). Sin datos sensibles (email, hash).
```

### 3.3 - Socket.io para PvP (stub)
```
En backend/src/index.ts, integrar Socket.io sobre el servidor HTTP.
Crear backend/src/socket/pvpHandler.ts: exports setupPvP(io: Server).

Por ahora solo el scaffold:
  io.on("connection", socket -> log conectado).
  Eventos planificados (comentados): challenge, accept, submit_answer, result.
Esto se implementa completo en Fase 6 (gamificacion).
```

---

## FASE 4 - Frontend: Base y Auth

### 4.1 - API client y contexto de auth
```
Crea frontend/src/services/api.ts: axios con baseURL desde
  import.meta.env.VITE_API_URL (fallback localhost:3000).
  Interceptor de request: agregar Authorization header desde localStorage.
  Interceptor de response: si 401, limpiar token y redirect a /login.

Crea frontend/src/context/AuthContext.tsx:
  Provider con estado: user, profile, token, isAuthenticated, loading.
  Metodos: login(email, pw), register(email, pw), logout, updateProfile.
  Persistir token en localStorage. Al montar, verificar token con GET /api/auth/me.

Crea frontend/src/hooks/useAuth.ts: shortcut para useContext(AuthContext).
```

### 4.2 - Paginas de auth
```
Crea frontend/src/pages/auth/LoginPage.tsx y RegisterPage.tsx.
Formularios sin tag <form>. Usar estado local + onClick en el boton.
Validacion cliente con Zod (mismas reglas que el backend).
Redirigir a /onboarding tras register, a /landing tras login.
Sin librerias de formularios. Sin estilos elaborados aun (Tailwind basico).

Crea frontend/src/router.tsx: React Router v6 con rutas:
  / -> redirect a /login si no auth, a /landing si auth
  /login, /register, /onboarding (publicas)
  /landing, /study/*, /games/*, /leaderboard (requieren auth, PrivateRoute)
```

### 4.3 - Onboarding
```
Crea frontend/src/pages/auth/OnboardingPage.tsx.
Flujo de 3 pasos sin navegacion entre paginas (estado local):
  Paso 1: seleccion de idioma objetivo (botones con banderas, multi-select).
    Idiomas: EN, FR, DE, JA, IT, PT, ZH, KO, AR, RU.
  Paso 2: nivel (0=desde cero, 1=intermedio, 2=tengo algo especifico).
  Paso 3: intereses (cinema, music, gaming, sports, tech, food, travel).
    Multi-select con iconos.

Al finalizar: PUT /api/profile y redirect a /landing.
Animacion de transicion entre pasos con Framer Motion (slide horizontal).
```

---

## FASE 5 - Frontend: Landing y Lookup

### 5.1 - Landing page estructura
```
Crea frontend/src/pages/landing/LandingPage.tsx.
Layout segun CLAUDE.md seccion "LANDING PAGE POST-LOGIN":
  - Zona superior: saludo rotatorio. Leer profile.targetLanguages[],
    elegir uno al azar en cada render, mostrar el saludo en ese idioma.
    Saludos hardcodeados por codigo ISO: { fr: "Qu'est-ce...", de: "Was...", etc }.
    Animacion con GSAP: fade-in del texto, cambio suave al rotar.
  - Zona izquierda: componente LookupPanel (crearlo como componente separado).
  - Zona derecha: componente StudyModesPanel (crearlo como componente separado).
Layout responsivo: en mobile, zonas apiladas verticalmente.
```

### 5.2 - LookupPanel
```
Crea frontend/src/components/landing/LookupPanel.tsx.

Estado local: term, fromLang, toLang, result (LookupResult | null), loading, error.
Hook useLookup.ts: llama GET /api/lookup, maneja loading/error, cachea en
  sessionStorage para no repetir la misma busqueda en la sesion.

UI del resultado en 3 capas con reveal progresivo (Framer Motion AnimatePresence):
  Capa 1 (aparece primero): traduccion + pronunciacion.
  Capa 2 (300ms despues): definicion.
  Capa 3 (600ms despues): contexto cultura pop con badge por sourceType
    (movie/game/song/series con colores distintos).

Si culturalContext esta vacio: no mostrar capa 3, sin mensaje de error.
```

### 5.3 - StudyModesPanel
```
Crea frontend/src/components/landing/StudyModesPanel.tsx.

Dos secciones con separador visual:
  "Estudio": 4 tarjetas (Desde cero, Intermedio, Personalizado, Mis archivos).
  "Juegos": 5 tarjetas (Adivina quien?, Es o no es?, Como se dice?, Modo pelicula, Batalla).

Cada tarjeta: icono, nombre, descripcion de 1 linea, color de acento unico.
Al hacer click: navigate a la ruta correspondiente (stubs por ahora, Fase 6 y 7).
Animacion hover con GSAP o Framer Motion: leve scale + sombra.
```

---

## FASE 6 - Frontend: Estudio y Ejercicios

### 6.1 - Hook de ejercicios y ExerciseCard
```
Crea frontend/src/hooks/useExercise.ts:
  Estado: exercises[], currentIndex, answers[], loading, error.
  Metodos: loadSet() -> GET /api/exercises, submitAnswer(answer) -> POST /api/exercises/:id/answer.
  Al submitAnswer: guardar feedback en answers[], avanzar currentIndex.

Crea frontend/src/components/exercise/ExerciseCard.tsx:
  Renderizado condicional por exercise.type:
    multiple_choice: botones de opciones, highlight correcto/incorrecto post-respuesta.
    fill_blank: input de texto + boton confirmar.
    true_false: dos botones grandes (Correcto / Incorrecto).
    free_translation: textarea + boton.
    guess_who, culture_pop: prompt con imagen placeholder y opciones.

Crea FeedbackOverlay.tsx: aparece sobre ExerciseCard tras responder.
  Correcto: fondo verde, icono check, texto de explanation + culturalNote.
  Incorrecto: fondo rojo-suave, shake animation en la card, explanation.
  Animaciones con GSAP (no CSS). Desaparece al hacer click o tras 3s.
```

### 6.2 - Paginas de estudio formal
```
Crea frontend/src/pages/study/StudyPage.tsx: wrapper comun para todos
  los modos de estudio. Recibe el modo como prop/param de ruta.
  Usa useExercise para cargar ejercicios.
  Layout: barra de progreso arriba, ExerciseCard en centro, boton "Saltar" abajo.

Rutas:
  /study/beginner  -> StudyPage mode="beginner"
  /study/intermediate -> StudyPage mode="intermediate"
  /study/custom -> StudyPage mode="custom" (con selector de tema antes de empezar)
  /study/files -> FileStudyPage (ver 6.3)

Al terminar el set: pantalla de resumen con aciertos/errores y boton "Volver al inicio".
```

### 6.3 - Upload de archivos propios
```
Crea frontend/src/pages/study/FileStudyPage.tsx.

Zona de upload: drag & drop o click, acepta PDF y SRT/VTT, max 10MB.
Al seleccionar archivo: POST /api/files/upload (multipart/form-data).
Backend ya valida con file-type, parsea con pdf-parse o srt-parser-2,
divide en chunks y los guarda en UserFile.

Implementa backend/src/services/file/FileService.ts:
  upload(file: Buffer, fileType: string, userId: string): Promise<UserFile>
  generateExercisesFromFile(fileId: string, userId: string): Promise<Exercise[]>
    - Leer chunks de UserFile.
    - Enviar chunks relevantes (no el documento completo) a AIService
      con prompt especial: "genera ejercicios basados en este contenido".
    - Devolver Exercise[] igual que el flujo normal.

Endpoint: POST /api/files/upload (auth, multipart).
Endpoint: GET /api/files (auth) -> lista de archivos del usuario.
Endpoint: POST /api/exercises/from-file/:fileId (auth).
```

---

## FASE 7 - Frontend: Gamificacion

### 7.1 - Juego: Adivina quien?
```
Crea frontend/src/pages/games/GuessWhoGame.tsx.

El backend genera ejercicios type="guess_who" via ExerciseService.
Frontend: mostrar cita anonimizada, 4 opciones de origen (pelicula/cancion/juego).
Temporizador de 30s con barra visual. Si se acaba el tiempo: contar como perdida.

Al terminar la partida (5 rondas): POST /api/leaderboard/game-result
  { gameType: "guess_who", won: acertadas >= 3, language }.
Mostrar pantalla de resultado con puntaje y boton "Jugar de nuevo".
```

### 7.2 - Juego: Es o no es?
```
Crea frontend/src/pages/games/TrueFalseGame.tsx.

Ejercicios type="true_false". Mostrar oracion, dos botones grandes
  "Correcto" / "Incorrecto". En mobile: preparar para swipe (Framer Motion drag).
10 rondas. Post /api/leaderboard/game-result al final.

Crea frontend/src/pages/games/VocabBattleGame.tsx (Como se dice?):
  Mismo patron, ejercicios type="multiple_choice", 10 rondas, mismo flujo de resultado.
  POST gameType="vocab_battle".
```

### 7.3 - Leaderboard page
```
Crea frontend/src/pages/leaderboard/LeaderboardPage.tsx.
Hook useLeaderboard.ts: GET /api/leaderboard y GET /api/leaderboard/friends,
  acepta gameType y period como parametros.

Layout segun CLAUDE.md seccion "LEADERBOARD":
  - Filtros en la parte superior: gameType (todos + 5 tipos) y period (semanal/historico).
  - Dos tablas en paralelo: Global (top 50) y Amigos.
  - En Global: highlight de la fila del usuario autenticado aunque no este en top 50
    (si no esta en top 50, mostrar su posicion separada al final con "---").
  - Columnas: # | Avatar | Usuario | Ganados.

Animacion al cambiar filtro: fade de la tabla. No recargar pagina completa.
```

---

## FASE 8 - Pulido UI/UX

### 8.1 - Sistema de animaciones
```
Crea frontend/src/animations/transitions.ts: configuraciones GSAP reutilizables.
  pageEnter: fade + slide-up (duracion 0.3s).
  exerciseNext: slide-left + fade del siguiente.
  correctFeedback: scale-up + color burst verde.
  incorrectFeedback: shake horizontal 3 veces.
  leaderboardRankUp: slide-up con color highlight temporal.

Aplica pageEnter en cada Page component al montar.
Aplica exerciseNext en ExerciseCard al avanzar al siguiente.
Referencia showcase: https://gsap.com/showcase/ - especialmente morph y scroll.
```

### 8.2 - Temas por idioma
```
Crea frontend/src/config/languageThemes.ts:
  Record<string, { primary: string, accent: string, font?: string, emoji: string }>
  FR: azul marino + dorado, JA: rojo + blanco, DE: negro + amarillo,
  IT: verde + rojo, PT: verde + amarillo, KO: azul + rosa.

Crea frontend/src/hooks/useLanguageTheme.ts: lee profile.targetLanguages[0]
  (idioma principal), devuelve el tema. Si no hay perfil, tema neutral.

Aplicar el tema como CSS custom properties en el root del layout.
El saludo de la landing ya cambia de idioma, el tema refuerza esa identidad visual.
```

### 8.3 - Estados de carga y error
```
Crea frontend/src/components/ui/SkeletonLoader.tsx: shimmer con Tailwind animate-pulse.
  Variantes: card, text-line, table-row.
Crea frontend/src/components/ui/ErrorState.tsx: mensaje de error + boton "Reintentar".
Crea frontend/src/components/ui/EmptyState.tsx: ilustracion SVG inline + mensaje.

Aplicar en: ExercisePage, LeaderboardPage, LandingPage (lookup), FileStudyPage.

Crea frontend/src/hooks/useApi.ts generico:
  useApi<T>(fetcher: () => Promise<T>): { data, loading, error, refetch }
  Reemplazar fetch manual en los hooks existentes con este.
```

---

## FASE 9 - Deploy y Produccion

### 9.1 - Docker final y Cloudflare Tunnel
```
Verifica docker/compose.yml: confirmar 0 puertos expuestos en perfil de produccion.
Agregar perfil "prod" al servicio backend (sin port binding).
Agregar servicio cloudflared: cloudflare/cloudflared:latest, tunnel run,
  TUNNEL_TOKEN desde env.

Crea docker/deploy.sh:
  docker compose pull
  docker compose build --no-cache
  docker compose up -d
  docker compose logs -f --tail=100

Logs: json-file driver, max-size 10m, max-file 3.
Crea docker/CLOUDFLARE-SETUP.md: crear tunnel en Zero Trust dashboard,
  configurar hostname zerosubs.tudominio.com -> http://backend:3000,
  copiar token a .env.
```

### 9.2 - Swap a Claude API
```
En backend/src/services/ai/ClaudeProvider.ts implementar completo:
  Usa fetch a https://api.anthropic.com/v1/messages.
  Headers: x-api-key: CLAUDE_API_KEY, anthropic-version: 2023-06-01.
  Model: process.env.CLAUDE_MODEL (default claude-sonnet-4-20250514).
  generateExercises: misma logica que OllamaProvider, mismo Zod schema de validacion.
  evaluateFreeTranslation: aprovechar la capacidad de razonamiento de Claude.
  generateCulturalContext: pedir array de culturalContext[] en JSON estricto.

Agregar rate limiter especifico para IA en backend/src/middleware/aiRateLimit.ts:
  Redis counter: key ai_rl:{userId}, INCR + EXPIRE 3600.
  Si supera 50 en la hora: responder 429 con "Limite de IA alcanzado, reintentar en X min".

Agregar logging de tokens: loggear input_tokens y output_tokens de cada response
  de Claude API en un archivo separado (logs/ai-usage.jsonl) para monitoreo de costos.
```

### 9.3 - Build frontend para produccion
```
Configura frontend/vite.config.ts para build de produccion:
  Asegurarse que VITE_API_URL apunte al dominio Cloudflare en build.
  Code splitting por ruta (lazy imports en router.tsx).
  Ajustar el backend para servir el build de frontend en dist/
  o configurar como servicio separado en el compose.

Documenta en README.md:
  Requisitos del servidor (Docker, GPU opcional, 8GB RAM minimo).
  Pasos de primer despliegue.
  Como actualizar (deploy.sh).
  Como agregar un idioma nuevo al sistema.
```

---

## Plantillas de prompts para el dia a dia

**Arreglar algo:**
```
En [ruta], [que cambiar]. Actual: [X]. Necesito: [Y].
```

**Agregar feature:**
```
Agrega [que] en [ruta]. Patron de [archivo referencia].
```

**Error de TS/runtime:**
```
[pegar error exacto y stack trace]. Archivo: [ruta].
```

**Nuevo tipo de ejercicio:**
```
Agrega ExerciseType "[nombre]" al sistema.
- Backend: ExerciseService debe incluirlo en el prompt de generateExercises.
- Frontend: ExerciseCard debe renderizar el nuevo type (patron de los existentes).
- Zod schema en shared/types/exercise.ts.
```

**Nuevo minijuego:**
```
Crea frontend/src/pages/games/[NombreGame].tsx.
Patron de [GuessWhoGame.tsx o TrueFalseGame.tsx].
GameType: "[gameType]". Rondas: [N]. POST game-result al final.
```

**Ajuste de prompt de IA:**
```
En backend/src/services/ai/prompts/exercises.ts, modifica buildExercisePrompt.
Necesito que la IA [comportamiento deseado].
Actual: [pegar la parte relevante del prompt].
Objetivo: [describir el cambio].
No modificar el schema Zod de validacion.
```

**Nuevo provider de subtitulos:**
```
Agrega [NombreProvider]Provider.ts en backend/src/services/subtitle/providers/.
Patron de PodnapisiProvider.ts. API: [URL]. Auth: [si/no]. 
Integrarlo en subtitle.worker.ts como capa [N] antes/despues de [provider existente].
```

**Debug del pipeline de subtitulos:**
```
El subtitle-worker no esta descargando SRTs. 
Ver logs: docker logs subtitle-worker --tail=50
[pegar logs relevantes]
Proveedor con problema: [Podnapisi/SubDL/OpenSubtitles].
```

---

## Notas de limpieza

```
COMANDO UNICO DE DESARROLLO (agregar a DEV.md):
docker compose -f docker/compose.yml up postgres redis ollama subgen subtitle-worker subtitle-scheduler -d
cd backend && npm run dev &
cd frontend && npm run dev

# Primera vez: poblar el catalogo de subtitulos
npm run db:migrate
npx tsx scripts/seed-subtitles.ts --limit=200
```

```
VARIABLES DE ENTORNO MINIMAS PARA DESARROLLO LOCAL:
DATABASE_URL=postgresql://zerosubs:password@localhost:5432/zerosubs
REDIS_URL=redis://:password@localhost:6379
OLLAMA_URL=http://localhost:11434
AI_PROVIDER=ollama
JWT_SECRET=dev-secret-cambiar-en-prod
JWT_REFRESH_SECRET=dev-refresh-secret
PORT=3000
TMDB_API_KEY=obtener-en-themoviedb.org (gratis)
OPENSUBTITLES_API_KEY=obtener-en-opensubtitles.com (gratis)
SUBGEN_URL=http://localhost:9000
SUBTITLE_SEED_LIMIT=200
```

```
ORDEN DE VERIFICACION ANTES DE PASAR A SIGUIENTE FASE:
- Fase 0: docker compose up levanta los 7 servicios sin errores.
- Fase 0.5: subtitle-worker procesa al menos 10 peliculas. Ver: docker logs subtitle-worker.
            Verificar en DB: SELECT count(*) FROM "SubtitleCache";
            Seed corriendo: npx tsx scripts/seed-subtitles.ts muestra progreso.
- Fase 1: GET /api/health responde 200. POST /api/auth/register crea usuario en DB.
- Fase 2: GET /api/exercises devuelve array de Exercise[] validos (Ollama respondiendo).
- Fase 3: GET /api/lookup responde con traduccion + cultural_context.
          GET /subtitles/:tmdbId devuelve SRT para pelicula del catalogo.
- Fase 4: Leaderboard muestra datos y el filtro actualiza las tablas.
- Fase 5: Flujo completo: ejercicio culture_pop usa frase real del SubtitleCache.
- Fase 6: Animaciones GSAP sin jank. Temas cambian segun idioma del perfil.
- Fase 7: Leaderboard con Socket.io actualiza en tiempo real al ganar un juego.
- Fase 8: App mobile navega entre tabs, gestos swipe funcionan en iOS/Android.
- Fase 9: Claude API responde en produccion. Logs de tokens en logs/ai-usage.jsonl.
```
