import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { SubtitleService } from '../services/subtitle/SubtitleService.js';

const paramsSchema = z.object({
  tmdbId: z.coerce.number().int().positive(),
});
const querySchema = z.object({
  lang: z.string().min(2).max(8).default('es'),
});

export const subtitleRouter = Router();

// GET /subtitles/:tmdbId?lang=es
// Uso interno (generacion de ejercicios, workers). Requiere JWT.
subtitleRouter.get('/:tmdbId', requireAuth, async (req, res) => {
  const params = paramsSchema.safeParse(req.params);
  const query = querySchema.safeParse(req.query);
  if (!params.success || !query.success) {
    res.status(400).json({ error: 'invalid_request' });
    return;
  }

  const { tmdbId } = params.data;
  const { lang } = query.data;

  const content = await SubtitleService.getByTmdbId(tmdbId, lang);
  if (!content) {
    res.status(404).json({ error: 'subtitle_not_found', tmdbId, language: lang });
    return;
  }

  res.json({ tmdbId, language: lang, content });
});
