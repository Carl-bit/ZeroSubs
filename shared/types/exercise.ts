export type ExerciseType =
  | 'multiple_choice'
  | 'fill_blank'
  | 'true_false'
  | 'free_translation'
  | 'guess_who'
  | 'culture_pop';

export interface Exercise {
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

export interface ExerciseFeedback {
  exerciseId: string;
  wasCorrect: boolean;
  userAnswer: string;
  correctAnswer: string;
  explanation: string;
  culturalNote?: string;
  errorType?: string;
}
