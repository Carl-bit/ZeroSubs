# ZeroSubs - Docker setup

## Prerequisitos

- Docker Engine 24+ y Docker Compose v2
- NVIDIA Container Toolkit (para GPU passthrough en `ollama` y `subgen`)
- ~20 GB libres para imagenes + modelos Ollama + cache Whisper

## 1. Configurar variables de entorno

```bash
cd docker
cp .env.example .env
# Editar .env: POSTGRES_PASSWORD, REDIS_PASSWORD, JWT_SECRET, JWT_REFRESH_SECRET,
# y las API keys externas (TMDB obligatorio para el seed).
```

Generar secretos:

```bash
openssl rand -base64 32   # JWT_SECRET
openssl rand -base64 32   # JWT_REFRESH_SECRET
```

## 2. Levantar el stack

```bash
cd docker
docker compose up -d
```

Verificar:

```bash
docker compose ps
docker compose logs -f backend
```

Servicios expuestos:

- `backend`: http://localhost:3000 (solo dev; en prod cerrarlo y enrutar por Cloudflare Tunnel)
- `postgres`, `redis`, `ollama`, `subgen`: solo red interna `zerosubs`

## 3. Migraciones Prisma

```bash
docker compose exec backend npx prisma migrate deploy
docker compose exec backend npx prisma generate
```

## 4. Descargar modelos Ollama

El contenedor arranca sin modelos. Hay que traerlos una vez:

```bash
# Modelo principal (6GB VRAM target)
docker compose exec ollama ollama pull llama3.2:3b-instruct-q4_K_M

# Alternativa mas capaz
docker compose exec ollama ollama pull qwen2.5:7b-instruct-q4_K_M

# Verificar
docker compose exec ollama ollama list
```

Apuntar `AI_PROVIDER=ollama` y `OLLAMA_URL=http://ollama:11434` en `.env`.

## 5. Seed inicial de subtitulos

Pre-poblar la `SubtitleCache` con las top N peliculas de TMDB.
El script encola en la queue BullMQ `subtitle-fetch`; el worker (`subtitle-worker`)
las procesa por las 3 capas (Podnapisi, SubDL, OpenSubtitles) y cae a Whisper
via `subgen` si todas fallan.

```bash
# Desde la raiz del repo (usa .env local, no el del contenedor)
cd backend
npm install
npx tsx ../scripts/seed-subtitles.ts
```

O dentro del contenedor backend:

```bash
docker compose exec backend npx tsx scripts/seed-subtitles.ts
```

Progreso en consola cada 20 peliculas. Se ejecuta una vez manualmente.
El `subtitle-scheduler` se encarga despues del cron nocturno (TMDB trending).

## 6. GPU passthrough

### Requisitos host (Linux)

```bash
# NVIDIA driver >= 535
nvidia-smi

# NVIDIA Container Toolkit
sudo apt install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker

# Verificar
docker run --rm --gpus all nvidia/cuda:12.4.0-base-ubuntu22.04 nvidia-smi
```

Tanto `ollama` como `subgen` reservan `driver: nvidia, count: all, capabilities: [gpu]`
via `deploy.resources.reservations.devices`. Si no hay GPU, comentar esos bloques
para correr en CPU (mucho mas lento, sobre todo Whisper).

### Reparto de VRAM (RTX 3050 6GB)

- Ollama con q4 3B: ~3-4 GB
- Whisper large-v3 en subgen: ~3-4 GB
- Correr ambos en simultaneo es justo. Si hay OOM, bajar a `WHISPER_MODEL=medium`
  en `.env` o reducir el modelo Ollama.

## 7. Produccion con Cloudflare Tunnel

En `compose.yml` remover la seccion `ports:` del servicio `backend` y agregar
un servicio `cloudflared` con el token del tunnel:

```yaml
cloudflared:
  image: cloudflare/cloudflared:latest
  restart: unless-stopped
  command: tunnel --no-autoupdate run
  environment:
    TUNNEL_TOKEN: ${CLOUDFLARE_TUNNEL_TOKEN}
  networks:
    - zerosubs
```

Apuntar el hostname del tunnel a `http://backend:3000`.

## Comandos utiles

```bash
docker compose logs -f subtitle-worker      # ver procesamiento de SRTs
docker compose logs -f subtitle-scheduler   # ver cron nocturno
docker compose restart backend              # recargar despues de cambios
docker compose down                         # apagar stack (mantiene volumenes)
docker compose down -v                      # apagar + borrar data (destructivo)
```
