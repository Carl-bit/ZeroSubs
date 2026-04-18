# ZeroSubs - Guia de desarrollo

Setup local. Para deploy y stack completo en produccion ver `docker/SETUP.md`.

## Arquitectura en dev

- Infra (postgres, redis, ollama, subgen, workers) corre en Docker.
- Backend y frontend corren en el host con hot reload.

```
+----------------+              +----------------+
|  frontend      |  VITE_API_URL|  backend       |
|  localhost:5173|------------->|  localhost:3000|
+----------------+              +----------------+
                                        |
                                +-------+--------+-----+-------+
                                |       |        |     |       |
                             postgres redis  ollama subgen  workers
                             (docker, red interna zerosubs)
```

## 1. Infra via Docker

```bash
cd docker
cp .env.example .env   # editar secretos y API keys
docker compose -f docker/compose.yml up -d
```

Servicios levantados:

- `postgres` (interno, puerto 5432 en la red `zerosubs`)
- `redis` (interno, 6379)
- `ollama` (interno, 11434) + GPU
- `subgen` (interno, 9000) + GPU
- `subtitle-worker`, `subtitle-scheduler` (BullMQ consumers)
- `backend` (expuesto en `localhost:3000`)

Para dev con hot reload del backend, apagar el contenedor `backend` y correrlo desde el host:

```bash
docker compose -f docker/compose.yml stop backend
```

## 2. Backend (host)

```bash
cd backend
cp .env.example .env    # ajustar DATABASE_URL=postgresql://...@localhost:5432
                        # y REDIS_URL=redis://:...@localhost:6379 para apuntar al host
npm install
npm run db:generate
npm run db:migrate
npm run dev             # tsx watch src/index.ts -> http://localhost:3000
```

Scripts utiles:

- `npm run build` - compila a `dist/`
- `npm start` - corre el build compilado
- `npm run db:studio` - abre Prisma Studio en el navegador

Para que el backend del host alcance postgres/redis del contenedor, exponer esos
puertos en `docker/compose.yml` agregando `ports: ["5432:5432"]` y
`ports: ["6379:6379"]` temporalmente (solo dev).

## 3. Frontend (host)

```bash
cd frontend
npm install
echo "VITE_API_URL=http://localhost:3000" > .env.local
npm run dev             # vite -> http://localhost:5173
```

Uso en codigo:

```ts
const api = import.meta.env.VITE_API_URL;
fetch(`${api}/lookup?q=...`);
```

Build de produccion:

- `npm run build` -> compila TS y genera `dist/`
- `npm run preview` -> sirve el build local para probar

## 4. Arranque rapido (tres terminales)

```bash
# terminal 1 - infra
docker compose -f docker/compose.yml up -d

# terminal 2 - backend
cd backend && npm run dev

# terminal 3 - frontend
cd frontend && npm run dev
```

URLs:

- Frontend: http://localhost:5173
- Backend: http://localhost:3000
- Prisma Studio: http://localhost:5555 (tras `npm run db:studio`)

## 5. Seed inicial de subtitulos

Ver `docker/SETUP.md` seccion 5. Una vez con la infra arriba:

```bash
cd backend
npx tsx ../scripts/seed-subtitles.ts
```

## 6. Apagar todo

```bash
# dejar corriendo npm dev? Ctrl+C en cada terminal.
docker compose -f docker/compose.yml down        # conserva volumenes
docker compose -f docker/compose.yml down -v     # borra data (destructivo)
```
