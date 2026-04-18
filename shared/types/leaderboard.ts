export type GameType = 'guess_who' | 'true_false' | 'vocab_battle' | 'movie_mode' | 'pvp';

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  username: string;
  gamesWon: number;
  isCurrentUser: boolean;
}

export interface LookupResult {
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
