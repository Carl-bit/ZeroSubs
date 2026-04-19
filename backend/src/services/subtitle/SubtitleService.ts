import SrtParser from 'srt-parser-2';
import { prisma } from '../../db/prisma.js';
import type { Quote } from './types.js';

// Lineas que no sirven para ejercicios: tags HTML/SSA, notas musicales,
// efectos entre corchetes/parentesis y creditos de subtitulador.
const TAG_REGEX = /<[^>]+>|\{[^}]+\}/g;
const MUSIC_LINE = /[♪♫]/;
const EFFECT_LINE = /^[\[\(]/;
const CREDIT_HINT = /subtit(le|ulo)|sync(hronized)? by|www\.|http/i;

function cleanLine(raw: string): string {
  return raw.replace(TAG_REGEX, '').replace(/\s+/g, ' ').trim();
}

export const SubtitleService = {
  async getByTmdbId(
    tmdbId: number,
    language: string,
    opts: { mediaType?: 'movie' | 'tv'; season?: number; episode?: number } = {},
  ): Promise<string | null> {
    const where: Record<string, unknown> = { tmdbId, language };
    if (opts.mediaType) where.mediaType = opts.mediaType;
    if (opts.season != null) where.season = opts.season;
    if (opts.episode != null) where.episode = opts.episode;

    const row = await prisma.subtitleCache.findFirst({
      where,
      select: { content: true },
    });
    return row?.content ?? null;
  },

  extractQuotes(srtContent: string, count: number): Quote[] {
    if (!srtContent || count <= 0) return [];

    const parser = new SrtParser();
    let lines: ReturnType<typeof parser.fromSrt>;
    try {
      lines = parser.fromSrt(srtContent);
    } catch {
      return [];
    }

    const usable = lines
      .map((l) => ({
        text: cleanLine(l.text),
        startTime: l.startSeconds,
        endTime: l.endSeconds,
      }))
      .filter((q) => {
        if (!q.text) return false;
        if (MUSIC_LINE.test(q.text)) return false;
        if (EFFECT_LINE.test(q.text)) return false;
        if (CREDIT_HINT.test(q.text)) return false;
        const words = q.text.split(/\s+/).filter(Boolean);
        return words.length >= 4;
      });

    if (!usable.length) return [];

    // Fisher-Yates parcial: O(n) con muestreo sin reemplazo.
    const pick = Math.min(count, usable.length);
    for (let i = 0; i < pick; i++) {
      const j = i + Math.floor(Math.random() * (usable.length - i));
      [usable[i], usable[j]] = [usable[j], usable[i]];
    }
    return usable.slice(0, pick);
  },
};
