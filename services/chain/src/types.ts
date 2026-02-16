export type SignalClassification =
  | "CAPITAL"
  | "INFO"
  | "VELOCITY"
  | "LIQUIDITY"
  | "NEWS"
  | "TIME";

export const CLASSIFICATION_INDEX: Record<SignalClassification, number> = {
  CAPITAL: 0,
  INFO: 1,
  VELOCITY: 2,
  LIQUIDITY: 3,
  NEWS: 4,
  TIME: 5,
};

export type AttestationInput = {
  movement_id: string;
  market_id: string;
  classification: SignalClassification;
  confidence: number;
  capital_score: number;
  info_score: number;
  time_score: number;
  news_score: number;
};

export type AttestationResult = {
  txSignature: string;
  slot: number;
  mode: "memo" | "program";
};
